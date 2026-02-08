/**
 * Warm Session Manager
 *
 * Manages a persistent browser session with TradingView pre-loaded for fast validation.
 * Session stays warm between requests to avoid cold start latency (~70s -> ~8s).
 *
 * Feature flag: USE_WARM_LOCAL_BROWSER=true enables this path.
 * Production default is enabled unless explicitly set to false.
 */

import puppeteer, { Browser, Page } from 'puppeteer-core'
import fs from 'fs'
import { injectCookies } from './browserless'
import {
  parseTVCookies,
  TV_SELECTORS,
  SCREENSHOT_DIR,
  ensureChartContext,
  ensureChartPineEditorOpen,
  type TVCredentials,
} from './tradingview'

// Environment configuration
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH

// Helper for retrying operations with exponential backoff
async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number
    baseDelayMs?: number
    operationName?: string
  } = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 1000, operationName = 'operation' } = options

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const isLastAttempt = attempt === maxAttempts
      console.log(`[Retry] ${operationName} attempt ${attempt}/${maxAttempts} failed: ${error}`)
      if (isLastAttempt) throw error
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1)
      console.log(`[Retry] Waiting ${delayMs}ms before retry...`)
      await delay(delayMs)
    }
  }
  throw new Error('Unreachable')
}

// Warm session configuration (configurable via env)
const IDLE_TIMEOUT = parseInt(process.env.WARM_SESSION_IDLE_TIMEOUT || '1800000') // 30 min default
const MAX_AGE = parseInt(process.env.WARM_SESSION_MAX_AGE || '7200000') // 2 hours default
const MAX_REQUESTS = parseInt(process.env.WARM_SESSION_MAX_REQUESTS || '500') // 500 requests default
const ACQUIRE_TIMEOUT = 30000 // 30 seconds to wait for busy session

export interface WarmSession {
  browser: Browser
  page: Page
  state: 'idle' | 'busy' | 'error'
  createdAt: number
  lastUsedAt: number
  requestsServed: number
}

// Singleton warm session
let warmSession: WarmSession | null = null
let idleTimer: NodeJS.Timeout | null = null
let acquireQueue: Array<{
  resolve: (session: WarmSession) => void
  reject: (error: Error) => void
}> = []

// Lock to prevent race condition when creating session
let sessionCreationPromise: Promise<WarmSession> | null = null

// Pre-warm tracking
let preWarmPromise: Promise<void> | null = null
let preWarmCredentials: TVCredentials | null = null

/**
 * Check if warm local browser is enabled
 */
export function isWarmLocalBrowserEnabled(): boolean {
  const raw = process.env.USE_WARM_LOCAL_BROWSER
  if (raw === 'true') return true
  if (raw === 'false') return false
  return process.env.NODE_ENV === 'production'
}

/**
 * Start pre-warming the browser session at app startup.
 * This initializes Chrome and navigates to TradingView before any requests arrive.
 * Call this early in server startup with service account credentials.
 */
export function startPreWarm(credentials: TVCredentials): void {
  if (preWarmPromise) {
    console.log('[Pre-warm] Already started, skipping')
    return
  }

  preWarmCredentials = credentials

  preWarmPromise = (async () => {
    console.log('[Pre-warm] Starting Chrome initialization...')
    const startTime = Date.now()

    try {
      const session = await acquireSession(credentials)
      await releaseSession(true)
      console.log(`[Pre-warm] Chrome ready for requests in ${Date.now() - startTime}ms`)
    } catch (error) {
      console.error('[Pre-warm] Failed to initialize:', error)
      preWarmPromise = null // Allow retry
    }
  })()
}

/**
 * Wait for pre-warm to complete (call before first validation request)
 */
export async function waitForPreWarm(): Promise<void> {
  if (preWarmPromise) {
    await preWarmPromise
  }
}

/**
 * Get Chrome executable path
 */
function getChromePath(): string {
  // Production: Use Dockerfile-configured path
  if (PUPPETEER_EXECUTABLE_PATH) {
    if (fs.existsSync(PUPPETEER_EXECUTABLE_PATH)) {
      return PUPPETEER_EXECUTABLE_PATH
    }
    throw new Error(`PUPPETEER_EXECUTABLE_PATH set to ${PUPPETEER_EXECUTABLE_PATH} but file does not exist`)
  }

  // Development: Auto-detect Chrome
  const paths: Record<string, string[]> = {
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
  }

  const osPaths = paths[process.platform] || []
  for (const p of osPaths) {
    if (fs.existsSync(p)) {
      return p
    }
  }

  throw new Error(`Chrome not found. Set PUPPETEER_EXECUTABLE_PATH env var. Searched: ${osPaths.join(', ')}`)
}

/**
 * Reset idle timer - called when session is released back to pool
 */
function resetIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
  }

  idleTimer = setTimeout(async () => {
    console.log(`[Warm Session] Idle timeout reached (${IDLE_TIMEOUT}ms), closing browser...`)
    await shutdownSession()
  }, IDLE_TIMEOUT)
}

/**
 * Create a new warm session with TradingView + Pine Editor pre-loaded
 */
async function createWarmSession(credentials: TVCredentials): Promise<WarmSession> {
  console.log('[Warm Session] Creating new warm session...')
  const startTime = Date.now()

  const chromePath = getChromePath()
  console.log(`[Warm Session] Launching Chrome: ${chromePath}`)

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--no-first-run',
    '--disable-accelerated-2d-canvas',
    '--disable-canvas-aa',
    '--disable-2d-canvas-clip-aa',
    '--disable-gl-drawing-for-tests',
  ]

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromePath,
    args,
    defaultViewport: { width: 1920, height: 1080 },
  })

  const page = await browser.newPage()

  // Auto-accept all dialogs
  page.on('dialog', async (dialog) => {
    console.log(`[Warm Session] Auto-accepting dialog: ${dialog.type()} - "${dialog.message()}"`)
    await dialog.accept()
  })

  // Set realistic user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  // Inject credentials
  const cookies = parseTVCookies(credentials)
  await injectCookies(page, cookies)
  console.log('[Warm Session] Credentials injected')

  // Navigate to TradingView chart page
  console.log('[Warm Session] Navigating to TradingView...')
  await page.goto('https://www.tradingview.com/chart/', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  })

  // Wait for page to stabilize and check if we're logged in
  await delay(3000)

  // Check if we're logged in using same selector as browserless implementation
  const isLoggedIn = await page.evaluate((selector) => {
    const userMenu = document.querySelector(selector)
    return !!userMenu
  }, TV_SELECTORS.auth.userMenu)

  if (!isLoggedIn) {
    console.log('[Warm Session] WARNING: May not be logged in to TradingView')
    // Take screenshot for debugging
    try {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/warm-session-not-logged-in.png` })
      console.log(`[Warm Session] Screenshot saved to ${SCREENSHOT_DIR}/warm-session-not-logged-in.png`)
    } catch (e) {
      console.log('[Warm Session] Could not take screenshot')
    }
  } else {
    console.log('[Warm Session] Confirmed logged in to TradingView')
  }

  // Open Pine Editor on chart with strict selectors only.
  console.log('[Warm Session] Opening Pine Editor...')
  await ensureChartPineEditorOpen(page, 'Warm Session')
  const editorFound = await page.$(TV_SELECTORS.pineEditor.editorArea)

  if (!editorFound) {
    // Take screenshot for debugging
    try {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/warm-session-editor-not-found.png` })
      console.log(`[Warm Session] Screenshot saved to ${SCREENSHOT_DIR}/warm-session-editor-not-found.png`)
    } catch (e) {
      console.log('[Warm Session] Could not take screenshot:', e)
    }

    // Check current URL - might have been redirected to login
    const currentUrl = page.url()
    console.log(`[Warm Session] Current URL: ${currentUrl}`)

    // Check for login page indicators
    const isLoginPage = await page.evaluate(() => {
      const url = window.location.href
      const hasLoginForm = !!document.querySelector('input[type="password"]')
      return url.includes('signin') || url.includes('login') || hasLoginForm
    })

    if (isLoginPage) {
      throw new Error('TradingView session expired - redirected to login page. Please refresh credentials.')
    }

    throw new Error('Monaco editor did not load - Pine Editor panel may not have opened')
  }

  await delay(500)

  // Remove any existing indicators from the chart (TradingView free tier limits to 2)
  console.log('[Warm Session] Cleaning up existing indicators...')
  const removedCount = await page.evaluate(() => {
    let removed = 0
    // Find all indicator close/remove buttons
    const removeButtons = document.querySelectorAll(
      '[data-name="legend-delete-action"], ' +
      '[class*="legend-"] button[aria-label*="Remove" i], ' +
      '[class*="legend-"] button[aria-label*="Delete" i], ' +
      '[class*="legend-"] [class*="close"], ' +
      '[class*="legend-"] [class*="remove"]'
    )
    for (const btn of removeButtons) {
      try {
        (btn as HTMLElement).click()
        removed++
      } catch {
        // Ignore
      }
    }
    return removed
  })

  if (removedCount > 0) {
    console.log(`[Warm Session] Removed ${removedCount} existing indicators`)
    await delay(500)
  } else {
    console.log('[Warm Session] No existing indicators to remove')
  }

  const session: WarmSession = {
    browser,
    page,
    state: 'idle',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    requestsServed: 0,
  }

  const elapsed = Date.now() - startTime
  console.log(`[Warm Session] Session created in ${elapsed}ms`)

  return session
}

/**
 * Check if session needs to be refreshed (age or request count limits)
 */
function sessionNeedsRefresh(session: WarmSession): boolean {
  const age = Date.now() - session.createdAt
  if (age > MAX_AGE) {
    console.log(`[Warm Session] Session exceeded max age (${age}ms > ${MAX_AGE}ms)`)
    return true
  }
  if (session.requestsServed >= MAX_REQUESTS) {
    console.log(`[Warm Session] Session exceeded max requests (${session.requestsServed} >= ${MAX_REQUESTS})`)
    return true
  }
  return false
}

/**
 * Acquire a warm session for use
 * - Creates a new session if none exists
 * - Waits if session is busy
 * - Refreshes session if needed
 */
export async function acquireSession(credentials: TVCredentials): Promise<WarmSession> {
  const startTime = Date.now()

  // If no session exists, create one (with lock to prevent race condition)
  if (!warmSession) {
    // Check if another request is already creating a session
    if (sessionCreationPromise) {
      console.log('[Warm Session] Session creation in progress, waiting...')
      await sessionCreationPromise
      // After waiting, the session should exist - recursively try to acquire
      return acquireSession(credentials)
    }

    console.log('[Warm Session] No warm session exists, creating...')

    // Set the lock before starting creation
    sessionCreationPromise = createWarmSession(credentials)

    try {
      warmSession = await sessionCreationPromise
      warmSession.state = 'busy'
      warmSession.lastUsedAt = Date.now()
      warmSession.requestsServed++
      resetIdleTimer()
      console.log(`[Warm Session] Acquired (cold start) in ${Date.now() - startTime}ms`)
      return warmSession
    } finally {
      // Clear the lock
      sessionCreationPromise = null
    }
  }

  // If session exists but needs refresh
  if (sessionNeedsRefresh(warmSession)) {
    console.log('[Warm Session] Refreshing session due to limits...')
    await shutdownSession()
    warmSession = await createWarmSession(credentials)
    warmSession.state = 'busy'
    warmSession.lastUsedAt = Date.now()
    warmSession.requestsServed++
    resetIdleTimer()
    console.log(`[Warm Session] Acquired (refreshed) in ${Date.now() - startTime}ms`)
    return warmSession
  }

  // If session is idle, acquire it
  if (warmSession.state === 'idle') {
    warmSession.state = 'busy'
    warmSession.lastUsedAt = Date.now()
    warmSession.requestsServed++

    // Clear idle timer while session is in use
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }

    console.log(`[Warm Session] Acquired (warm) in ${Date.now() - startTime}ms`)
    return warmSession
  }

  // If session is busy, wait in queue
  if (warmSession.state === 'busy') {
    console.log('[Warm Session] Session busy, waiting in queue...')

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Remove from queue
        acquireQueue = acquireQueue.filter(item => item.resolve !== resolve)
        reject(new Error(`Timeout waiting for warm session (${ACQUIRE_TIMEOUT}ms)`))
      }, ACQUIRE_TIMEOUT)

      acquireQueue.push({
        resolve: (session: WarmSession) => {
          clearTimeout(timeout)
          session.lastUsedAt = Date.now()
          session.requestsServed++
          console.log(`[Warm Session] Acquired (from queue) in ${Date.now() - startTime}ms`)
          resolve(session)
        },
        reject: (error: Error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
    })
  }

  // Session is in error state, recreate
  console.log('[Warm Session] Session in error state, recreating...')
  await shutdownSession()
  warmSession = await createWarmSession(credentials)
  warmSession.state = 'busy'
  warmSession.lastUsedAt = Date.now()
  warmSession.requestsServed++
  resetIdleTimer()
  console.log(`[Warm Session] Acquired (recovered from error) in ${Date.now() - startTime}ms`)
  return warmSession
}

/**
 * Release session back to pool after use
 */
export async function releaseSession(success: boolean): Promise<void> {
  if (!warmSession) {
    console.log('[Warm Session] No session to release')
    return
  }

  if (success) {
    warmSession.state = 'idle'
    console.log(`[Warm Session] Released (${warmSession.requestsServed} requests served)`)

    // Process waiting queue
    if (acquireQueue.length > 0) {
      const next = acquireQueue.shift()!
      warmSession.state = 'busy'
      next.resolve(warmSession)
      return
    }

    // Start idle timer
    resetIdleTimer()
  } else {
    // Mark as error - will be recreated on next acquire
    warmSession.state = 'error'
    console.log('[Warm Session] Released with error, will recreate on next acquire')

    // Reject all waiting requests
    for (const waiter of acquireQueue) {
      waiter.reject(new Error('Session failed, please retry'))
    }
    acquireQueue = []
  }
}

/**
 * Reset editor state between requests
 * Clears editor content and dismisses any dialogs
 */
export async function resetEditorState(page: Page): Promise<void> {
  console.log('[Warm Session] Resetting editor state...')

  // Dismiss any open dialogs
  await page.keyboard.press('Escape')
  await delay(100)
  await page.keyboard.press('Escape')
  await delay(100)

  // Check if Monaco editor is accessible
  const editorExists = await page.$('.monaco-editor')

  if (!editorExists) {
    console.log('[Warm Session] Monaco editor not found, navigating back to chart...')
    const currentUrl = page.url()
    console.log(`[Warm Session] Current URL: ${currentUrl}`)

    // Navigate back to chart page
    await page.goto('https://www.tradingview.com/chart/', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    })
    await delay(2000)

    await ensureChartContext(page, 'Warm Session')
    await ensureChartPineEditorOpen(page, 'Warm Session')
    await page.waitForSelector('.monaco-editor', { timeout: 10000 })
    await delay(500)
    console.log('[Warm Session] Pine Editor reopened')
  }

  // Click on Monaco editor to focus
  try {
    await page.click('.monaco-editor')
    await delay(100)

    // Select all and delete
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')
    await delay(50)
    await page.keyboard.press('Delete')
    await delay(100)
  } catch (error) {
    console.log('[Warm Session] Error resetting editor:', error)
    throw error // Re-throw to trigger session refresh
  }

  console.log('[Warm Session] Editor state reset complete')
}

/**
 * Check if session is healthy (browser connected, page responsive)
 */
export async function checkSessionHealth(): Promise<boolean> {
  if (!warmSession) return false

  try {
    // Check if browser is still connected
    if (!warmSession.browser.isConnected()) {
      console.log('[Warm Session] Health check failed: browser disconnected')
      return false
    }

    // Check if page is responsive
    await warmSession.page.evaluate(() => true)
    return true
  } catch (error) {
    console.log('[Warm Session] Health check failed:', error)
    return false
  }
}

/**
 * Shutdown warm session (for graceful server stop or idle timeout)
 */
export async function shutdownSession(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }

  // Clear creation lock if it exists
  sessionCreationPromise = null

  if (!warmSession) {
    console.log('[Warm Session] No session to shutdown')
    return
  }

  try {
    console.log('[Warm Session] Shutting down...')
    await warmSession.browser.close()
    console.log('[Warm Session] Browser closed')
  } catch (error) {
    console.error('[Warm Session] Error closing browser:', error)
  }

  // Reject all waiting requests
  for (const waiter of acquireQueue) {
    waiter.reject(new Error('Session shutdown'))
  }
  acquireQueue = []

  warmSession = null
}

/**
 * Get warm session stats (for monitoring/debugging)
 */
export function getSessionStats(): {
  hasSession: boolean
  state?: string
  requestsServed?: number
  ageMs?: number
  idleSinceMs?: number
  queueLength: number
} {
  if (!warmSession) {
    return { hasSession: false, queueLength: acquireQueue.length }
  }

  return {
    hasSession: true,
    state: warmSession.state,
    requestsServed: warmSession.requestsServed,
    ageMs: Date.now() - warmSession.createdAt,
    idleSinceMs: warmSession.state === 'idle' ? Date.now() - warmSession.lastUsedAt : undefined,
    queueLength: acquireQueue.length,
  }
}

// Helper
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
