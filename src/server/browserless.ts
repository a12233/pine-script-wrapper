import puppeteer, { Browser, Page } from 'puppeteer-core'

const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY
const BROWSERLESS_ENDPOINT = process.env.BROWSERLESS_ENDPOINT || 'wss://chrome.browserless.io'

export interface BrowserlessSession {
  browser: Browser
  page: Page
}

/**
 * Connect to Browserless.io and create a new browser session
 */
export async function createBrowserSession(): Promise<BrowserlessSession> {
  if (!BROWSERLESS_API_KEY) {
    throw new Error('BROWSERLESS_API_KEY is not set')
  }

  const browser = await puppeteer.connect({
    browserWSEndpoint: `${BROWSERLESS_ENDPOINT}?token=${BROWSERLESS_API_KEY}`,
  })

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
