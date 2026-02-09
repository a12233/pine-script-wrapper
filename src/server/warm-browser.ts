/**
 * Warm Browser Module
 *
 * Manages a singleton browser instance that persists across requests.
 * Pre-warms at app startup so the first request doesn't pay the cold-start cost.
 *
 * The warm browser:
 * 1. Launches Chromium once at startup
 * 2. Navigates to TradingView /chart/ and opens Pine Editor
 * 3. Reuses the same browser/page for all validation requests
 * 4. Handles recovery if the page crashes or becomes unresponsive
 *
 * IMPORTANT: All mutable state lives on globalThis to survive Nitro's
 * code-splitting (plugin chunk vs validation-loop chunk).
 */

import puppeteer, { Browser, Page } from 'puppeteer-core'
import fs from 'fs'
import {
  injectCookies,
  type BrowserlessSession,
} from './browserless'
import { parseTVCookies, type TVCredentials } from './tradingview'
import { getServiceAccountCredentials } from './service-validation'

const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH
const USE_WARM_BROWSER = process.env.USE_WARM_BROWSER === 'true'

// Persistent cache directory on Fly volume (if available)
const CHROME_CACHE_DIR = process.env.CHROME_CACHE_DIR || '/data/chrome-cache'

/** State of the warm browser */
type WarmBrowserState = 'idle' | 'busy' | 'initializing' | 'error'

interface WarmBrowser {
  browser: Browser
  page: Page
  state: WarmBrowserState
  createdAt: number
  requestCount: number
}

// Use globalThis to share state across module boundaries.
// Nitro bundles the plugin and validation-loop into separate chunks,
// each with their own module-level variables. globalThis is the only
// way to share singleton state between them.
interface WarmBrowserGlobal {
  warmBrowser: WarmBrowser | null
  initPromise: Promise<void> | null
  waitQueue: Array<{
    resolve: (session: BrowserlessSession) => void
    reject: (error: Error) => void
  }>
  keepAliveTimer: ReturnType<typeof setInterval> | null
}

const g = globalThis as unknown as { __warmBrowser?: WarmBrowserGlobal }
if (!g.__warmBrowser) {
  g.__warmBrowser = {
    warmBrowser: null,
    initPromise: null,
    waitQueue: [],
    keepAliveTimer: null,
  }
}
const shared = g.__warmBrowser

/** Max requests before recycling the browser (prevent memory leaks) */
const MAX_REQUESTS = 200
/** Max browser age before recycling (2 hours) */
const MAX_AGE_MS = 2 * 60 * 60 * 1000

/**
 * Get Chromium launch args optimized for container environments.
 * Includes cache directory for persistent caching across restarts.
 */
function getChromiumArgs(): string[] {
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
    '--disable-component-update',
    '--metrics-recording-only',
    '--mute-audio',
    '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
    '--window-size=1920,1080',
  ]

  // Use persistent cache dir if on Fly volume
  if (CHROME_CACHE_DIR) {
    // Ensure cache directories exist
    try {
      fs.mkdirSync(`${CHROME_CACHE_DIR}/profile`, { recursive: true })
    } catch {
      // Directory may already exist or volume not mounted yet
    }
    args.push(`--disk-cache-dir=${CHROME_CACHE_DIR}`)
    args.push(`--user-data-dir=${CHROME_CACHE_DIR}/profile`)
  }

  return args
}

/**
 * Launch a new browser instance
 */
async function launchBrowser(): Promise<Browser> {
  const executablePath = PUPPETEER_EXECUTABLE_PATH
  if (!executablePath) {
    throw new Error('PUPPETEER_EXECUTABLE_PATH is required for warm browser')
  }

  console.log(`[WarmBrowser] Launching Chromium: ${executablePath}`)
  if (CHROME_CACHE_DIR) {
    console.log(`[WarmBrowser] Using cache dir: ${CHROME_CACHE_DIR}`)
  }

  return puppeteer.launch({
    headless: true,
    executablePath,
    args: getChromiumArgs(),
    defaultViewport: { width: 1920, height: 1080 },
  })
}

/**
 * Set up a fresh page with proper viewport, user agent, and dialog handling
 */
async function setupPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage()

  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  // Auto-accept all dialogs
  page.on('dialog', async (dialog) => {
    console.log(`[WarmBrowser] Auto-accepting dialog: ${dialog.type()} - "${dialog.message()}"`)
    await dialog.accept()
  })

  return page
}

/**
 * Navigate to TradingView /chart/ and open Pine Editor.
 * This pre-warms the session so validation requests start instantly.
 */
async function warmUpSession(page: Page, credentials: TVCredentials): Promise<void> {
  // Inject auth cookies
  const cookies = parseTVCookies(credentials)
  await injectCookies(page, cookies)

  // Navigate to /chart/ page
  console.log('[WarmBrowser] Navigating to TradingView /chart/...')
  await page.goto('https://www.tradingview.com/chart/', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  })

  // Wait for chart to initialize
  const authReady = await Promise.race([
    page.waitForSelector('[data-name="header-user-menu-button"]', { timeout: 15000 }).then(() => 'authenticated'),
    page.waitForSelector('[data-name="header-signin-button"]', { timeout: 15000 }).then(() => 'not-authenticated'),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 15000)),
  ])

  console.log(`[WarmBrowser] Auth status: ${authReady}`)

  if (authReady === 'not-authenticated') {
    console.warn('[WarmBrowser] Not authenticated - credentials may be expired')
  }

  // Open Pine Editor
  console.log('[WarmBrowser] Opening Pine Editor...')
  const pineEditorOpened = await openPineEditor(page)
  if (!pineEditorOpened) {
    console.warn('[WarmBrowser] Could not open Pine Editor during warm-up (will retry on first request)')
  }
}

/**
 * Try to open Pine Editor on /chart/ page using known selectors
 */
async function openPineEditor(page: Page): Promise<boolean> {
  // Check if already open
  const editorExists = await page.$('.monaco-editor')
  if (editorExists) {
    console.log('[WarmBrowser] Pine Editor already open')
    return true
  }

  // Try open-pine-editor first (works if editor was previously opened)
  const selectors = [
    '[data-name="open-pine-editor"]',
    '[data-name="pine-dialog-button"]',
  ]

  for (const selector of selectors) {
    try {
      const btn = await page.$(selector)
      if (btn) {
        await btn.click()
        console.log(`[WarmBrowser] Clicked: ${selector}`)

        // Wait for Monaco editor
        try {
          await page.waitForSelector('.monaco-editor', { timeout: 8000 })
          console.log('[WarmBrowser] Pine Editor opened successfully')
          return true
        } catch {
          console.log(`[WarmBrowser] Monaco didn't appear after clicking ${selector}`)
        }
      }
    } catch {
      // Try next selector
    }
  }

  return false
}

/**
 * Initialize the warm browser. Called once at startup.
 */
async function initWarmBrowser(): Promise<void> {
  const start = Date.now()
  console.log('[WarmBrowser] Initializing...')

  try {
    const browser = await launchBrowser()
    const page = await setupPage(browser)

    shared.warmBrowser = {
      browser,
      page,
      state: 'initializing',
      createdAt: Date.now(),
      requestCount: 0,
    }

    // Try to get credentials and warm up the session
    const credentials = await getServiceAccountCredentials()
    if (credentials) {
      await warmUpSession(page, credentials)
    } else {
      console.warn('[WarmBrowser] No service account credentials - browser launched but not authenticated')
    }

    shared.warmBrowser.state = 'idle'
    console.log(`[WarmBrowser] Ready in ${Date.now() - start}ms`)

    // Drain the wait queue
    while (shared.waitQueue.length > 0) {
      const waiter = shared.waitQueue.shift()!
      waiter.resolve({ browser: shared.warmBrowser.browser, page: shared.warmBrowser.page })
    }
  } catch (error) {
    console.error('[WarmBrowser] Initialization failed:', error)
    if (shared.warmBrowser) {
      shared.warmBrowser.state = 'error'
    }

    // Reject all waiters
    while (shared.waitQueue.length > 0) {
      const waiter = shared.waitQueue.shift()!
      waiter.reject(new Error(`Warm browser init failed: ${error}`))
    }

    throw error
  }
}

/**
 * Check if the warm browser needs recycling
 */
function needsRecycle(): boolean {
  if (!shared.warmBrowser) return false
  if (shared.warmBrowser.requestCount >= MAX_REQUESTS) return true
  if (Date.now() - shared.warmBrowser.createdAt > MAX_AGE_MS) return true
  return false
}

/**
 * Recycle the warm browser (close and re-init)
 */
async function recycleBrowser(): Promise<void> {
  console.log('[WarmBrowser] Recycling browser...')
  if (shared.warmBrowser) {
    try {
      await shared.warmBrowser.browser.close()
    } catch {
      // Ignore close errors
    }
    shared.warmBrowser = null
  }
  shared.initPromise = null
  await ensureWarmBrowser()
}

/**
 * Ensure the warm browser is initialized. Safe to call multiple times.
 */
export async function ensureWarmBrowser(): Promise<void> {
  if (!USE_WARM_BROWSER && !PUPPETEER_EXECUTABLE_PATH) {
    return // Not configured for warm browser
  }

  if (shared.warmBrowser && shared.warmBrowser.state !== 'error' && shared.warmBrowser.state !== 'initializing') {
    return // Already initialized and ready
  }

  if (shared.initPromise) {
    return shared.initPromise // Wait for ongoing initialization
  }

  shared.initPromise = initWarmBrowser()
  return shared.initPromise
}

/**
 * Get the warm browser session for a request.
 * If the browser is busy, waits in a queue.
 * Falls back to creating a fresh session if warm browser isn't available.
 */
export async function getWarmSession(): Promise<BrowserlessSession | null> {
  if (!shared.warmBrowser || shared.warmBrowser.state === 'error') {
    return null // Not available, caller should fall back
  }

  // If still initializing, wait for it
  if (shared.warmBrowser.state === 'initializing') {
    return new Promise((resolve, reject) => {
      shared.waitQueue.push({ resolve, reject })
    })
  }

  // If busy, wait in queue
  if (shared.warmBrowser.state === 'busy') {
    return new Promise((resolve, reject) => {
      shared.waitQueue.push({ resolve, reject })
    })
  }

  // Mark as busy
  shared.warmBrowser.state = 'busy'
  shared.warmBrowser.requestCount++

  return { browser: shared.warmBrowser.browser, page: shared.warmBrowser.page }
}

/**
 * Release the warm browser session after a request completes.
 * Must be called after getWarmSession() when done.
 */
export function releaseWarmSession(): void {
  if (!shared.warmBrowser) return

  shared.warmBrowser.state = 'idle'

  // Check if recycling is needed
  if (needsRecycle()) {
    recycleBrowser().catch(console.error)
    return
  }

  // Serve next waiter if any
  if (shared.waitQueue.length > 0) {
    const waiter = shared.waitQueue.shift()!
    shared.warmBrowser.state = 'busy'
    shared.warmBrowser.requestCount++
    waiter.resolve({ browser: shared.warmBrowser.browser, page: shared.warmBrowser.page })
  }
}

/**
 * Check if warm browser is available and configured
 */
export function isWarmBrowserEnabled(): boolean {
  return !!(USE_WARM_BROWSER && PUPPETEER_EXECUTABLE_PATH)
}

/**
 * Check if warm browser is ready to serve requests
 */
export function isWarmBrowserReady(): boolean {
  return shared.warmBrowser?.state === 'idle' || shared.warmBrowser?.state === 'busy'
}

/**
 * Start pre-warming at app startup.
 * Called from the main server entry or a Nitro plugin.
 */
export function startPreWarm(): void {
  if (!isWarmBrowserEnabled()) {
    console.log('[WarmBrowser] Not enabled (set USE_WARM_BROWSER=true to enable)')
    return
  }

  console.log('[WarmBrowser] Starting pre-warm...')
  // Fire and forget - don't block app startup
  ensureWarmBrowser().catch((error) => {
    console.error('[WarmBrowser] Pre-warm failed:', error)
  })
}

// ============ Keep-Alive Ping ============
// Prevents Fly.io from auto-suspending the machine after idle timeout (~5min).
// Only active when the warm browser is enabled, since there's no point keeping
// the machine alive without a warm browser to preserve.

const KEEP_ALIVE_ENABLED = process.env.KEEP_ALIVE_ENABLED !== 'false' // Enabled by default when warm browser is on
const KEEP_ALIVE_INTERVAL_MS = parseInt(process.env.KEEP_ALIVE_INTERVAL_MS || '240000', 10) // 4 minutes default

/**
 * Start the keep-alive ping loop.
 * Pings the app's own health endpoint to prevent Fly.io machine suspension.
 */
export function startKeepAlive(): void {
  if (!KEEP_ALIVE_ENABLED || !isWarmBrowserEnabled()) {
    return
  }

  if (shared.keepAliveTimer) {
    return // Already running
  }

  console.log(`[KeepAlive] Starting self-ping every ${KEEP_ALIVE_INTERVAL_MS / 1000}s`)

  shared.keepAliveTimer = setInterval(async () => {
    try {
      const res = await fetch('http://localhost:3000/', {
        method: 'HEAD',
        signal: AbortSignal.timeout(5000),
      })
      console.log(`[KeepAlive] Ping: ${res.status}`)
    } catch (error) {
      // Don't log full error to avoid noise — a failed ping just means the
      // machine might suspend, which is recoverable
      console.log('[KeepAlive] Ping failed (non-fatal)')
    }
  }, KEEP_ALIVE_INTERVAL_MS)

  // Don't block process exit
  if (shared.keepAliveTimer.unref) {
    shared.keepAliveTimer.unref()
  }
}

/**
 * Stop the keep-alive ping loop.
 */
export function stopKeepAlive(): void {
  if (shared.keepAliveTimer) {
    clearInterval(shared.keepAliveTimer)
    shared.keepAliveTimer = null
    console.log('[KeepAlive] Stopped')
  }
}

// Startup is triggered by the Nitro plugin (src/server/plugins/warm-browser-plugin.ts)
