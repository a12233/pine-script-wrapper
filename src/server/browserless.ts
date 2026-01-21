import puppeteer, { Browser, Page } from 'puppeteer-core'
import fs from 'fs'

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

/**
 * Create a browser session
 * - Uses visible Chrome window in dev (USE_LOCAL_BROWSER=true)
 * - Uses headless Chromium in production container (PUPPETEER_EXECUTABLE_PATH set)
 * - Falls back to Browserless.io if neither is available
 */
export async function createBrowserSession(): Promise<BrowserlessSession> {
  let browser: Browser

  if (USE_LOCAL_BROWSER) {
    // Launch local Chrome
    // Options: HEADLESS_BROWSER=true for invisible, otherwise launches minimized
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

    // Launch minimized/hidden by default (unless headless)
    // Note: --start-minimized doesn't work on Linux, so we position window off-screen instead
    if (!HEADLESS_BROWSER) {
      args.push('--window-position=-2400,-2400')
    }

    const headless = HEADLESS_BROWSER ? 'new' : false
    console.log(`🌐 Launching Chrome: ${chromePath} (headless: ${headless}, off-screen: ${!HEADLESS_BROWSER})`)
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
    console.log(`🌐 Launching headless Chromium: ${PUPPETEER_EXECUTABLE_PATH}`)

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

    browser = await puppeteer.launch({
      headless: true,
      executablePath: PUPPETEER_EXECUTABLE_PATH,
      args,
      defaultViewport: { width: 1920, height: 1080 },
    })
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
  try {
    await page.goto(url, {
      waitUntil: options?.waitUntil || 'networkidle2',
      timeout: 60000,
    })
    return true
  } catch (error) {
    console.error(`Navigation to ${url} failed:`, error)
    return false
  }
}
