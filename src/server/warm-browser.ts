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
export async function launchBrowser(): Promise<Browser> {
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
    // TradingView's JS engine saturates the shared CPU VM after script insertion,
    // causing CDP Runtime.callFunctionOn calls to queue. Default 180s timeout is
    // too short — increase to 5 minutes to let operations complete eventually.
    protocolTimeout: 300_000,
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
 * Prepare the warm session by injecting auth cookies only.
 *
 * IMPORTANT: We intentionally do NOT navigate to TradingView or open Pine Editor
 * during warm-up. On the shared CPU VM (2GB), TradingView's JS engine makes the
 * browser tab unresponsive after ~20s of idle. Since there's always a gap between
 * warm-up completing and the first validation request arriving, pre-navigating
 * wastes time and results in a stale/hung page.
 *
 * Instead, the validation loop navigates to TradingView fresh when the request
 * arrives. The warm browser's value is:
 * - Pre-launched Chromium (~15s saved)
 * - Auth cookies already injected
 * - Page ready to navigate
 */
async function warmUpSession(page: Page, credentials: TVCredentials): Promise<void> {
  // Inject auth cookies so the page is authenticated when we navigate later
  const cookies = parseTVCookies(credentials)
  await injectCookies(page, cookies)
  console.log('[WarmBrowser] Cookies injected, browser ready for navigation on first request')
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

        // Wait for Monaco editor (30s for cold start — Monaco is a large lazy-loaded bundle)
        try {
          await page.waitForSelector('.monaco-editor', { timeout: 30000 })
          console.log('[WarmBrowser] Pine Editor opened successfully')
          return true
        } catch {
          console.log(`[WarmBrowser] Monaco didn't appear after clicking ${selector} (30s timeout)`)
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

    // Close the browser to free memory for cold path fallback
    if (shared.warmBrowser) {
      try {
        await shared.warmBrowser.browser.close()
        console.log('[WarmBrowser] Closed failed browser to free resources')
      } catch {
        // Ignore close errors
      }
      shared.warmBrowser = null
    }

    // Reject all waiters
    while (shared.waitQueue.length > 0) {
      const waiter = shared.waitQueue.shift()!
      waiter.reject(new Error(`Warm browser init failed: ${error}`))
    }

    // Clear initPromise so isWarmBrowserInitializing() returns false
    shared.initPromise = null

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
    // Wait for ongoing init, but cap at 5 minutes to avoid blocking requests forever
    await Promise.race([
      shared.initPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Warm browser init timed out (5min)')), 300_000)
      ),
    ])
    return
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
 * Create a fresh page (new tab) in the warm browser's existing Chromium.
 * Used for publishing after warm validation — the new tab has a clean JS context
 * (no saturation from validation) while reusing the already-running Chromium
 * process (no 52s cold start).
 *
 * Returns null if the warm browser is not available.
 */
export async function createWarmPublishSession(): Promise<BrowserlessSession | null> {
  if (!shared.warmBrowser) return null

  try {
    const page = await shared.warmBrowser.browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    )
    page.on('dialog', async (dialog) => {
      console.log(`[WarmBrowser] Publish page dialog: ${dialog.type()} - "${dialog.message()}"`)
      await dialog.accept()
    })
    console.log('[WarmBrowser] Created fresh publish page in warm browser')
    return { browser: shared.warmBrowser.browser, page }
  } catch (error) {
    console.error('[WarmBrowser] Failed to create publish page:', error)
    return null
  }
}

/**
 * Close a publish page without closing the browser.
 * Safe to call even if the page is already closed.
 */
export async function closePublishPage(page: Page): Promise<void> {
  try {
    await page.close()
    console.log('[WarmBrowser] Closed publish page')
  } catch {
    // Page may already be closed
  }
}

/**
 * Shut down the warm browser to free memory (e.g. before cold path fallback).
 */
export async function shutdownWarmBrowser(): Promise<void> {
  if (shared.warmBrowser) {
    try {
      await shared.warmBrowser.browser.close()
      console.log('[WarmBrowser] Shut down warm browser to free resources')
    } catch {
      // Ignore close errors
    }
    shared.warmBrowser = null
    shared.initPromise = null
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
 * Check if warm browser is still initializing (not yet ready, but may become ready).
 * Returns false if init completed (success or failure) or was never started.
 */
export function isWarmBrowserInitializing(): boolean {
  // State is explicitly 'initializing'
  if (shared.warmBrowser?.state === 'initializing') return true
  // Browser is null but initPromise exists — init is in progress or just started
  // (initPromise is set before launch; warmBrowser is set once browser connects)
  if (!shared.warmBrowser && shared.initPromise !== null) return true
  return false
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
// IMPORTANT: Must ping through the EXTERNAL proxy URL, not localhost.
// Fly.io's auto-stop only monitors external proxy connections — internal
// localhost traffic does NOT count toward keeping the machine alive.

const KEEP_ALIVE_ENABLED = process.env.KEEP_ALIVE_ENABLED !== 'false' // Enabled by default when warm browser is on
const KEEP_ALIVE_INTERVAL_MS = parseInt(process.env.KEEP_ALIVE_INTERVAL_MS || '240000', 10) // 4 minutes default
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.APP_URL || 'https://pine-script-wrapper.fly.dev'

/**
 * Start the keep-alive ping loop.
 * Pings the app's EXTERNAL URL to prevent Fly.io machine suspension.
 * Fly.io only tracks connections through the external proxy for auto-stop decisions.
 */
export function startKeepAlive(): void {
  if (!KEEP_ALIVE_ENABLED || !isWarmBrowserEnabled()) {
    return
  }

  if (shared.keepAliveTimer) {
    return // Already running
  }

  console.log(`[KeepAlive] Starting external ping to ${KEEP_ALIVE_URL} every ${KEEP_ALIVE_INTERVAL_MS / 1000}s`)

  shared.keepAliveTimer = setInterval(async () => {
    try {
      const res = await fetch(KEEP_ALIVE_URL, {
        method: 'HEAD',
        signal: AbortSignal.timeout(10000),
      })
      console.log(`[KeepAlive] Ping: ${res.status}`)
    } catch (error) {
      // A failed ping means the machine might suspend, which is recoverable
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
