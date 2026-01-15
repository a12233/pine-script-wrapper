import puppeteer, { Browser, Page } from 'puppeteer-core'
import fs from 'fs'

const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY
const BROWSERLESS_ENDPOINT = process.env.BROWSERLESS_ENDPOINT || 'wss://chrome.browserless.io'
const USE_LOCAL_BROWSER = process.env.USE_LOCAL_BROWSER === 'true'
const CHROME_PATH = process.env.CHROME_PATH
const CHROME_USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR // Use existing Chrome profile

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

export interface BrowserlessSession {
  browser: Browser
  page: Page
}

/**
 * Create a browser session - uses local Chrome in dev, Browserless.io in production
 */
export async function createBrowserSession(): Promise<BrowserlessSession> {
  let browser: Browser

  if (USE_LOCAL_BROWSER) {
    // Launch local Chrome (dev mode - browser window is visible for debugging)
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

    console.log(`🌐 Launching Chrome: ${chromePath}`)
    console.log(`   Profile: ${userDataDir}`)

    browser = await puppeteer.launch({
      headless: false,
      executablePath: chromePath,
      args,
      defaultViewport: null, // Use default window size
    })
  } else {
    // Connect to Browserless.io (production)
    if (!BROWSERLESS_API_KEY) {
      throw new Error(
        'BROWSERLESS_API_KEY is required when USE_LOCAL_BROWSER is not set. ' +
          'Set USE_LOCAL_BROWSER=true for local development.'
      )
    }
    console.log('🌐 Connecting to Browserless.io...')
    browser = await puppeteer.connect({
      browserWSEndpoint: `${BROWSERLESS_ENDPOINT}?token=${BROWSERLESS_API_KEY}`,
    })
  }

  const page = await browser.newPage()

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
