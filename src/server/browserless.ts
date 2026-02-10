import puppeteer, { Browser, Page, CDPSession } from 'puppeteer-core'
import fs from 'fs'
import crypto from 'crypto'

const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY
const BROWSERLESS_ENDPOINT = process.env.BROWSERLESS_ENDPOINT || 'wss://chrome.browserless.io'
const USE_LOCAL_BROWSER = process.env.USE_LOCAL_BROWSER === 'true'
const HEADLESS_BROWSER = process.env.HEADLESS_BROWSER === 'true' // Run browser in background (headless)
const CHROME_PATH = process.env.CHROME_PATH
const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR // Use existing Chrome profile
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH // Set by Dockerfile for production
const BROWSERLESS_STEALTH = process.env.BROWSERLESS_STEALTH !== 'false' // Default: enabled
const BROWSERLESS_PROXY = process.env.BROWSERLESS_PROXY // 'residential' or 'datacenter'

/**
 * Auto-detect Chrome user data directory based on OS
 */
function getDefaultChromeUserDataDir(): string | undefined {
  const dirs: Record<string, string> = {
    linux: `${process.env.HOME}/.config/google-chrome`,
    darwin: `${process.env.HOME}/Library/Application Support/Google/Chrome`,
    win32: `${process.env.LOCALAPPDATA}\\Google\\Chrome\\User Data`,
  }
  const dir = dirs[process.platform]
  if (dir && fs.existsSync(dir)) {
    return dir
  }
  return undefined
}

/**
 * Auto-detect Chrome executable path based on OS
 */
function getChromePath(): string {
  // Allow manual override
  if (CHROME_PATH) {
    if (fs.existsSync(CHROME_PATH)) {
      return CHROME_PATH
    }
    throw new Error(`CHROME_PATH set to ${CHROME_PATH} but file does not exist`)
  }

  const paths: Record<string, string[]> = {
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
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

  throw new Error(
    `Chrome not found. Install Chrome or set CHROME_PATH env var. Searched: ${osPaths.join(', ')}`
  )
}

/**
 * Build Browserless.io WebSocket endpoint URL with stealth and proxy options
 */
function buildBrowserlessEndpoint(): string {
  let endpoint = BROWSERLESS_ENDPOINT

  // Add stealth path if enabled
  if (BROWSERLESS_STEALTH) {
    // wss://chrome.browserless.io -> wss://chrome.browserless.io/chromium/stealth
    const url = new URL(endpoint)
    if (!url.pathname.includes('/stealth')) {
      url.pathname = '/chromium/stealth'
    }
    endpoint = url.toString()
  }

  // Build query params
  const params = new URLSearchParams()
  params.set('token', BROWSERLESS_API_KEY!)
  if (BROWSERLESS_PROXY) {
    params.set('proxy', BROWSERLESS_PROXY)
  }

  return `${endpoint}?${params.toString()}`
}

export interface BrowserlessSession {
  browser: Browser
  page: Page
}

export interface BrowserSessionOptions {
  /** Force visible browser window (for CAPTCHA solving) */
  forceVisible?: boolean
}

/**
 * Create a browser session
 * - Uses visible Chrome window in dev (USE_LOCAL_BROWSER=true)
 * - Uses headless Chromium in production container (PUPPETEER_EXECUTABLE_PATH set)
 * - Falls back to Browserless.io if neither is available
 * @param options.forceVisible - Force visible browser for CAPTCHA solving
 */
export async function createBrowserSession(options?: BrowserSessionOptions): Promise<BrowserlessSession> {
  const forceVisible = options?.forceVisible ?? false
  let browser: Browser

  if (USE_LOCAL_BROWSER || forceVisible) {
    // Launch local Chrome
    // Options: HEADLESS_BROWSER=true for invisible, otherwise launches minimized
    // forceVisible overrides to show visible browser (for CAPTCHA solving)
    const chromePath = getChromePath()

    // Use custom profile dir if set, otherwise use a puppeteer-specific profile
    // (Don't use main Chrome profile - it may be locked by running Chrome)
    const userDataDir = CHROME_USER_DATA_DIR || `${process.env.HOME}/.puppeteer-chrome-profile`

    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      `--user-data-dir=${userDataDir}`,
    ]

    // Launch minimized/hidden by default (unless headless or forceVisible)
    // Note: --start-minimized doesn't work on Linux, so we position window off-screen instead
    // forceVisible shows the browser on-screen for manual CAPTCHA solving
    const shouldHideWindow = !HEADLESS_BROWSER && !forceVisible
    if (shouldHideWindow) {
      args.push('--window-position=-2400,-2400')
    }

    // forceVisible always uses non-headless mode
    const headless = forceVisible ? false : (HEADLESS_BROWSER ? 'new' : false)
    const visibleReason = forceVisible ? 'CAPTCHA solving' : (HEADLESS_BROWSER ? 'headless' : 'off-screen')
    console.log(`🌐 Launching Chrome: ${chromePath} (mode: ${visibleReason})`)
    console.log(`   Profile: ${userDataDir}`)

    browser = await puppeteer.launch({
      headless,
      executablePath: chromePath,
      args,
      defaultViewport: headless ? { width: 1920, height: 1080 } : null,
    })
  } else if (PUPPETEER_EXECUTABLE_PATH) {
    // Production mode: Launch headless Chromium in container
    // This is set in Dockerfile: PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
    const cachedir = process.env.CHROME_CACHE_DIR
    console.log(`🌐 Launching headless Chromium: ${PUPPETEER_EXECUTABLE_PATH}${cachedir ? ` (cache: ${cachedir})` : ''}`)

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
      '--disable-ipc-flooding-protection',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-hang-monitor',
      '--disable-field-trial-config',
      '--disable-breakpad',
      '--disable-domain-reliability',
    ]

    // Use persistent disk cache on Fly volume if configured
    // Each cold session gets a unique profile dir to avoid conflicts when
    // multiple validations run concurrently (e.g., AI fix retry while
    // previous browser is still closing).
    let coldProfileDir: string | undefined
    if (cachedir) {
      const sessionId = crypto.randomBytes(4).toString('hex')
      coldProfileDir = `${cachedir}/cold-${sessionId}`
      fs.mkdirSync(coldProfileDir, { recursive: true })
      args.push(`--disk-cache-dir=${cachedir}`)
      args.push(`--user-data-dir=${coldProfileDir}`)
    }

    browser = await puppeteer.launch({
      headless: true,
      executablePath: PUPPETEER_EXECUTABLE_PATH,
      args,
      defaultViewport: { width: 1920, height: 1080 },
      protocolTimeout: 300_000, // 5min — TradingView's JS can be slow on 2GB VM
    })

    // Clean up the unique profile dir when the browser closes
    if (coldProfileDir) {
      const dirToClean = coldProfileDir
      browser.on('disconnected', () => {
        fs.rm(dirToClean, { recursive: true, force: true }, () => {})
      })
    }
  } else if (BROWSERLESS_API_KEY) {
    // Fallback: Connect to Browserless.io
    const wsEndpoint = buildBrowserlessEndpoint()
    const mode = BROWSERLESS_STEALTH ? 'stealth' : 'standard'
    const proxy = BROWSERLESS_PROXY ? ` + ${BROWSERLESS_PROXY} proxy` : ''
    console.log(`🌐 Connecting to Browserless.io (${mode}${proxy})...`)
    browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
    })
  } else {
    throw new Error(
      'No browser available. Set one of: USE_LOCAL_BROWSER=true, PUPPETEER_EXECUTABLE_PATH, or BROWSERLESS_API_KEY'
    )
  }

  const page = await browser.newPage()

  // Auto-accept all dialogs (including beforeunload "are you sure" prompts)
  page.on('dialog', async (dialog) => {
    console.log(`[Browser] Auto-accepting dialog: ${dialog.type()} - "${dialog.message()}"`)
    await dialog.accept()
  })

  // Set a realistic viewport
  await page.setViewport({ width: 1920, height: 1080 })

  // Set a realistic user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  return { browser, page }
}

/**
 * Close a browser session
 */
export async function closeBrowserSession(session: BrowserlessSession): Promise<void> {
  await session.browser.close()
}

/**
 * Inject cookies into a page for authentication
 */
export async function injectCookies(
  page: Page,
  cookies: Array<{
    name: string
    value: string
    domain: string
    path?: string
    httpOnly?: boolean
    secure?: boolean
  }>
): Promise<void> {
  await page.setCookie(...cookies)
}

/**
 * Wait for an element with retry logic
 */
export async function waitForElement(
  page: Page,
  selector: string,
  timeout = 30000
): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout })
    return true
  } catch {
    return false
  }
}

/**
 * Safe page navigation with error handling
 */
export async function navigateTo(
  page: Page,
  url: string,
  options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2' }
): Promise<boolean> {
  const waitUntil = options?.waitUntil || 'domcontentloaded'
  try {
    await page.goto(url, {
      waitUntil,
      timeout: 90000,
    })
    return true
  } catch (error) {
    // Retry with 'load' fallback if domcontentloaded was used
    if (waitUntil === 'domcontentloaded') {
      console.warn(`Navigation to ${url} failed with domcontentloaded, retrying with 'load'...`)
      try {
        await page.goto(url, {
          waitUntil: 'load',
          timeout: 90000,
        })
        return true
      } catch (retryError) {
        console.error(`Navigation to ${url} failed on retry:`, retryError)
        return false
      }
    }
    console.error(`Navigation to ${url} failed:`, error)
    return false
  }
}

// ============ Live Session Management (for Admin CAPTCHA solving) ============

export interface LiveSession {
  sessionId: string
  liveURL: string
  browser: Browser
  page: Page
  cdpSession: CDPSession
  createdAt: number
}

// In-memory storage for active live sessions
const liveSessions = new Map<string, LiveSession>()

// Clean up old sessions after 10 minutes
const LIVE_SESSION_TTL = 10 * 60 * 1000

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `live_${crypto.randomUUID().slice(0, 8)}`
}

/**
 * Create a live Browserless session with shareable URL for manual CAPTCHA solving
 * Requires Browserless.io with record=true for LiveURL support
 * Note: Live URL feature may not work with stealth mode, so we use standard chromium
 */
export async function createLiveSession(): Promise<LiveSession> {
  if (!BROWSERLESS_API_KEY) {
    throw new Error('BROWSERLESS_API_KEY required for live sessions')
  }

  // Use standard chromium (not stealth) for live sessions as stealth may not support liveURL
  // Build endpoint with launch params for live URL support
  const params = new URLSearchParams()
  params.set('token', BROWSERLESS_API_KEY)
  params.set('launch', JSON.stringify({
    headless: false, // Required for live viewing
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  }))

  // Use standard chromium endpoint (not stealth) for live URL support
  const wsEndpoint = `${BROWSERLESS_ENDPOINT}?${params.toString()}`

  console.log('[Live Session] Connecting to Browserless (standard mode for live URL)...')
  const browser = await puppeteer.connect({
    browserWSEndpoint: wsEndpoint,
  })

  const page = await browser.newPage()

  // Set up viewport and user agent
  await page.setViewport({ width: 1920, height: 1080 })
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  // Get live URL via CDP
  const cdpSession = await page.createCDPSession()

  let liveURL: string | null = null

  try {
    // Request a live URL with 10 minute timeout
    const result = await cdpSession.send('Browserless.liveURL' as any, { timeout: 600000 }) as { liveURL: string }
    liveURL = result.liveURL
    console.log(`[Live Session] Got live URL: ${liveURL}`)
  } catch (error) {
    console.error('[Live Session] Failed to get liveURL via CDP:', error)
    // Try alternative approach - Browserless may expose live URL differently
    // If this fails, we'll return null and let the caller handle it
  }

  // If liveURL is still null, try to construct it from the browser endpoint
  if (!liveURL) {
    // Browserless provides live URLs at a predictable endpoint
    // Format: https://chrome.browserless.io/live?token=XXX&session=YYY
    try {
      // Get the WebSocket debugger URL which contains the session ID
      const wsUrl = browser.wsEndpoint()
      console.log(`[Live Session] Browser WebSocket URL: ${wsUrl}`)

      // Extract session ID from WebSocket URL (last part of path)
      const wsUrlParsed = new URL(wsUrl)
      const pathParts = wsUrlParsed.pathname.split('/')
      const sessionIdFromWs = pathParts[pathParts.length - 1]

      if (sessionIdFromWs) {
        // Construct live URL
        liveURL = `https://chrome.browserless.io/devtools/inspector.html?wss=chrome.browserless.io/devtools/page/${sessionIdFromWs}?token=${BROWSERLESS_API_KEY}`
        console.log(`[Live Session] Constructed DevTools URL: ${liveURL}`)
      }
    } catch (error) {
      console.error('[Live Session] Failed to construct live URL:', error)
    }
  }

  const sessionId = generateSessionId()
  const session: LiveSession = {
    sessionId,
    liveURL: liveURL || 'Unable to get live URL - use cookie upload method instead',
    browser,
    page,
    cdpSession,
    createdAt: Date.now(),
  }

  // Store the session
  liveSessions.set(sessionId, session)

  // Schedule cleanup
  setTimeout(() => {
    closeLiveSession(sessionId).catch(console.error)
  }, LIVE_SESSION_TTL)

  return session
}

/**
 * Store a live session (used internally)
 */
export function storeLiveSession(sessionId: string, browser: Browser, page: Page, cdpSession: CDPSession, liveURL: string): void {
  liveSessions.set(sessionId, {
    sessionId,
    liveURL,
    browser,
    page,
    cdpSession,
    createdAt: Date.now(),
  })
}

/**
 * Get a stored live session by ID
 */
export function getLiveSession(sessionId: string): LiveSession | undefined {
  return liveSessions.get(sessionId)
}

/**
 * Close and clean up a live session
 */
export async function closeLiveSession(sessionId: string): Promise<void> {
  const session = liveSessions.get(sessionId)
  if (!session) {
    console.log(`[Live Session] Session ${sessionId} not found or already closed`)
    return
  }

  try {
    await session.browser.close()
    console.log(`[Live Session] Closed session ${sessionId}`)
  } catch (error) {
    console.error(`[Live Session] Error closing session ${sessionId}:`, error)
  }

  liveSessions.delete(sessionId)
}

/**
 * Extract session cookies from a live session page
 * Used after manual login to get the TradingView session
 */
export async function extractSessionCookies(sessionId: string): Promise<{
  sessionId: string
  sessionIdSign: string
} | null> {
  const session = getLiveSession(sessionId)
  if (!session) {
    console.log(`[Live Session] Session ${sessionId} not found`)
    return null
  }

  const cookies = await session.page.cookies('https://www.tradingview.com')
  const sessionIdCookie = cookies.find(c => c.name === 'sessionid')
  const signatureCookie = cookies.find(c => c.name === 'sessionid_sign')

  if (!sessionIdCookie || !signatureCookie) {
    console.log('[Live Session] Session cookies not found - user may not have logged in yet')
    return null
  }

  return {
    sessionId: sessionIdCookie.value,
    sessionIdSign: signatureCookie.value,
  }
}
