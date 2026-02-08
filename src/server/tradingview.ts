import { randomUUID } from 'crypto'
import {
  createBrowserSession,
  closeBrowserSession,
  injectCookies,
  waitForElement,
  navigateTo,
  enableBrowserlessReconnect,
  type BrowserlessSession,
  type ReconnectableBrowserSession,
} from './browserless'

// Helper function for delays
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Wrapper for page.evaluate with timeout to prevent hangs on heavy TradingView pages */
async function timedEvaluate<T>(
  page: import('puppeteer-core').Page,
  fn: (...args: any[]) => T,
  args?: any,
  timeoutMs = 20000,
  fallback?: T,
): Promise<T> {
  return Promise.race([
    args !== undefined ? page.evaluate(fn, args) : page.evaluate(fn),
    new Promise<T>((resolve, reject) =>
      setTimeout(() => fallback !== undefined ? resolve(fallback) : reject(new Error(`timedEvaluate timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ])
}

// ============ Browserless Concurrency Lock ============
// Serializes access to Browserless to prevent 429 rate limit errors.
// Browserless plan limits concurrent sessions to 1.
let browserlessLock: Promise<void> | null = null
let browserlessLockResolve: (() => void) | null = null

async function acquireBrowserlessLock(requestId: string): Promise<void> {
  while (browserlessLock) {
    console.log(`[Browserless:${requestId}] Session in use, waiting...`)
    await browserlessLock
  }
  browserlessLock = new Promise(resolve => {
    browserlessLockResolve = resolve
  })
  console.log(`[Browserless:${requestId}] Lock acquired`)
}

function releaseBrowserlessLock(requestId: string): void {
  if (browserlessLockResolve) {
    console.log(`[Browserless:${requestId}] Lock released`)
    browserlessLockResolve()
    browserlessLockResolve = null
    browserlessLock = null
  }
}

// ============ Admin Session Cache (In-memory only, for server-level credentials) ============
// This cache is ONLY for admin auto-login with TV_USERNAME/TV_PASSWORD environment variables.
// It is NOT used for user sessions - those are stored per-user in Redis/KV via kv.ts.
interface AdminCachedSession {
  sessionId: string
  signature: string
  createdAt: number
}

let adminSessionCache: AdminCachedSession | null = null

/**
 * Load admin cached session from memory
 * Only used for server-level auto-login, not for user sessions
 * No expiry - sessions persist until cleared or auth fails
 */
function loadAdminCachedSession(): AdminCachedSession | null {
  if (!adminSessionCache) return null

  console.log('[TV Admin Cache] Using cached admin session (no expiry)')
  return adminSessionCache
}

/**
 * Save admin session to in-memory cache
 * Only used for server-level auto-login with environment credentials
 * No expiry - sessions persist until cleared or auth fails
 */
function saveAdminCachedSession(session: { sessionId: string; signature: string }): void {
  adminSessionCache = {
    ...session,
    createdAt: Date.now(),
  }
  console.log('[TV Admin Cache] Admin session cached in memory (no expiry)')
}

/**
 * Clear admin cached session
 */
function clearAdminCachedSession(): void {
  if (adminSessionCache) {
    adminSessionCache = null
    console.log('[TV Admin Cache] Admin session cache cleared')
  }
}

// Environment credentials for auto-login
const TV_USERNAME = process.env.TV_USERNAME
const TV_PASSWORD = process.env.TV_PASSWORD

// Feature flag to use the dedicated /pine/ page instead of /chart/
const USE_PINE_EDITOR_PAGE = process.env.TV_USE_PINE_PAGE === 'true'

// Screenshot directory - persisted on Fly volume in production, /tmp locally
export const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp'

// TradingView URLs
const TV_URLS = {
  chart: 'https://www.tradingview.com/chart/',
  pine: 'https://www.tradingview.com/pine/',
  signin: 'https://www.tradingview.com/accounts/signin/',
} as const

// TradingView DOM selectors - maintain separately for easy updates when TV changes UI
// Exported for use by warm-session.ts
export const TV_SELECTORS = {
  // Pine Editor
  pineEditor: {
    container: '[data-name="pine-editor"]',
    editorArea: '.monaco-editor',
    consolePanel: '[data-name="console-panel"]',
    errorLine: '.console-line.error',
    warningLine: '.console-line.warning',
  },
  // Script publishing
  publish: {
    button: '[data-name="publish-script-button"]',
    dialog: '[data-dialog-name="publish-script"]',
    titleInput: 'input[name="title"]',
    descriptionInput: 'textarea[name="description"]', // Legacy - actual UI uses contenteditable
    privateRadio: 'input[value="private"]',
    submitButton: 'button[type="submit"]',
  },
  // Publish dialog (two-step workflow)
  publishDialog: {
    // Step 1: Title and description
    titleInput: 'input[name="title"]',
    descriptionEditor: '[contenteditable="true"]', // Rich text editor
    continueButton: 'button', // Match by text "Continue"
    // Step 2: Privacy and visibility
    publicButton: 'button', // Match by text "Public"
    privateButton: 'button', // Match by text "Private"
    openButton: 'button', // Match by text "Open"
    protectedButton: 'button', // Match by text "Protected"
    inviteOnlyButton: 'button', // Match by text "Invite-only"
    // Final submit
    publishPublicButton: 'button', // Match by text "Publish public script"
    publishPrivateButton: 'button', // Match by text "Publish private script"
  },
  // User authentication indicators
  auth: {
    userMenu: '[data-name="header-user-menu-button"]',
    loginButton: '[data-name="header-signin-button"]',
    // Login form selectors
    emailInput: 'input[name="id_username"]',
    passwordInput: 'input[name="id_password"]',
    submitButton: 'button[type="submit"]',
    emailTab: '[data-name="email"]',
  },
  // Chart page
  chart: {
    container: '.chart-container',
    pineEditorButton: '[data-name="open-pine-editor"]',
    pineDialogButton: '[data-name="pine-dialog-button"]', // Sidebar toggle (always exists on fresh /chart/)
  },
  // Dedicated /pine/ editor page (simpler, faster loading)
  pineEditorPage: {
    container: '.pine-editor-container',
    editorArea: '.monaco-editor',
    consolePanel: '[data-name="console-panel"]',
    errorLine: '.console-line.error',
    warningLine: '.console-line.warning',
    compileButton: '[data-name="compile-button"]',
    saveButton: '[data-name="save-button"]',
    publishButton: '[data-name="publish-button"]',
    // Alternative selectors for /pine/ page
    altConsolePanel: '.pine-console',
    altErrorLine: '.error-line',
    altWarningLine: '.warning-line',
  },
  // Version info
  version: '2024-01',
} as const

type TVPageType = 'chart' | 'pine' | 'signin' | 'unknown'

const STRICT_SELECTORS = {
  pineOpenButton: [
    TV_SELECTORS.chart.pineEditorButton,      // [data-name="open-pine-editor"] (exists after first open)
    TV_SELECTORS.chart.pineDialogButton,       // Sidebar toggle (always exists on fresh /chart/)
  ],
  pineEditorReady: [TV_SELECTORS.pineEditor.container, TV_SELECTORS.pineEditor.editorArea],
  publishButtons: [
    '[data-name="publish-script-button"]',
    '[data-name="save-publish-button"]',
    '[title*="Share your script" i]',
  ],
} as const

function getPageTypeFromUrl(url: string): TVPageType {
  if (url.includes('/chart/')) return 'chart'
  if (url.includes('/pine/')) return 'pine'
  if (url.includes('/signin') || url.includes('/login')) return 'signin'
  return 'unknown'
}

export function detectTVPageFromUrl(url: string): TVPageType {
  return getPageTypeFromUrl(url)
}

export async function ensureChartContext(
  page: import('puppeteer-core').Page,
  requestTag: string = 'TV Nav'
): Promise<void> {
  const initialType = getPageTypeFromUrl(page.url())
  if (initialType !== 'chart') {
    console.log(`[${requestTag}] Enforcing chart context from ${page.url()}`)
    const navigated = await navigateTo(page, TV_URLS.chart)
    if (!navigated) {
      throw new Error('Failed to navigate to /chart/ page')
    }
    await delay(1500)
  }
}

export async function ensureChartPineEditorOpen(
  page: import('puppeteer-core').Page,
  requestTag: string = 'TV Nav',
  options: { chartContextVerified?: boolean } = {}
): Promise<void> {
  if (!options.chartContextVerified) {
    await ensureChartContext(page, requestTag)
  }

  const alreadyOpen = await page.$(TV_SELECTORS.pineEditor.container)
  if (alreadyOpen) {
    await waitForElement(page, TV_SELECTORS.pineEditor.editorArea, 10000)
    return
  }

  let opened = false
  for (const selector of STRICT_SELECTORS.pineOpenButton) {
    try {
      const button = await page.$(selector)
      if (!button) continue
      await button.click()
      await delay(800)
      await ensureChartContext(page, requestTag)
      const ready = await waitForElement(page, TV_SELECTORS.pineEditor.editorArea, 8000)
      if (ready) {
        opened = true
        console.log(`[${requestTag}] Pine Editor opened via ${selector}`)
        break
      }
    } catch {
      // Try next strict selector.
    }
  }

  if (!opened) {
    // Last strict fallback: click an existing legend source (if present) to open Pine panel.
    const legendOpened = await page.evaluate(() => {
      const item = document.querySelector('[data-name="legend-source-item"]') as HTMLElement | null
      if (!item) return false
      item.click()
      return true
    }).catch(() => false)

    if (legendOpened) {
      await delay(1000)
      await ensureChartContext(page, requestTag)
      opened = await waitForElement(page, TV_SELECTORS.pineEditor.editorArea, 8000)
      if (opened) {
        console.log(`[${requestTag}] Pine Editor opened via legend fallback`)
      }
    }
  }

  if (!opened) {
    throw new Error('Could not open Pine Editor on /chart/ with strict selectors')
  }
}

export async function clickPublishButtonInChart(
  page: import('puppeteer-core').Page,
  requestTag: string = 'TV Publish',
  options: { chartContextVerified?: boolean; pineEditorVerified?: boolean } = {}
): Promise<string | null> {
  if (!options.chartContextVerified) {
    await ensureChartContext(page, requestTag)
  }
  if (!options.pineEditorVerified) {
    await ensureChartPineEditorOpen(page, requestTag, { chartContextVerified: true })
  }

  const combinedSelector = STRICT_SELECTORS.publishButtons.join(', ')
  const clickedFromCombined = await timedEvaluate<string | null>(
    page,
    (sel) => {
      const candidates = Array.from(document.querySelectorAll(sel)) as HTMLElement[]
      for (const btn of candidates) {
        const rect = btn.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        btn.click()
        return btn.getAttribute('data-name') || btn.getAttribute('title') || sel
      }
      return null
    },
    combinedSelector,
    3000,
    null,
  ).catch(() => null)

  if (clickedFromCombined) {
    await ensureChartContext(page, requestTag)
    return clickedFromCombined
  }

  // Fallback: strict per-selector retry with short evaluate timeout.
  for (const selector of STRICT_SELECTORS.publishButtons) {
    const clicked = await timedEvaluate<string | null>(
      page,
      (sel) => {
        const btn = document.querySelector(sel) as HTMLElement | null
        if (!btn) return null
        const rect = btn.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return null
        btn.click()
        return sel
      },
      selector,
      1500,
      null,
    ).catch(() => null)

    if (clicked) {
      await ensureChartContext(page, requestTag)
      return clicked
    }
  }

  return null
}

export interface TVCredentials {
  sessionId: string
  signature: string
  userId: string
}

export interface ValidationResult {
  isValid: boolean
  errors: Array<{
    line: number
    message: string
    type: 'error' | 'warning'
  }>
  rawOutput: string
}

export interface PublishResult {
  success: boolean
  indicatorUrl?: string
  error?: string
  errorCode?: 'URL_CAPTURE_FAILED_AFTER_PUBLISH' | 'PUBLISH_ACTION_FAILED' | 'PUBLISH_DIALOG_NOT_FOUND' | 'DIALOG_FILL_FAILED'
  publishedButUrlUnknown?: boolean
  captureSource?: 'new-tab' | 'network-id' | 'redirect' | 'dom' | 'scripts-api'
}

interface ScriptApiResultItem {
  name?: string
  chart_url?: string
  url?: string
  image_url?: string
}

const URL_CAPTURE_WINDOW_MS = parseInt(process.env.TV_URL_CAPTURE_WINDOW_MS || '15000', 10)
const API_LOOKUP_ELAPSED_SCHEDULE_MS = [0, 1000, 2500, 5000, 8000, 12000] as const

export function resolveScriptsApiUsername(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const raw = env.TV_SERVICE_ACCOUNT_USERNAME || env.TV_USERNAME
  const username = raw?.trim()
  return username ? username : null
}

export function extractScriptIdFromText(text: string): string | null {
  if (!text) return null
  const idMatch = text.match(/"scriptIdPart"\s*:\s*"([a-zA-Z0-9]+)"/) ||
                  text.match(/"scriptId"\s*:\s*"([a-zA-Z0-9]+)"/) ||
                  text.match(/"script_id"\s*:\s*"([a-zA-Z0-9]+)"/) ||
                  text.match(/"idScript"\s*:\s*"([a-zA-Z0-9]+)"/) ||
                  text.match(/"id"\s*:\s*"([a-zA-Z0-9]+)"/) ||
                  text.match(/\/script\/([a-zA-Z0-9]+)/) ||
                  text.match(/"publishedUrl"\s*:\s*"[^"]*\/script\/([a-zA-Z0-9]+)/)
  return idMatch ? idMatch[1] : null
}

export function extractScriptIdFromUrl(url: string): string | null {
  const match = url.match(/tradingview\.com\/script\/([a-zA-Z0-9]+)/i) ||
                url.match(/\/script\/([a-zA-Z0-9]+)/i)
  return match ? match[1] : null
}

export function canonicalizeTradingViewScriptUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const scriptId = extractScriptIdFromUrl(url)
  if (!scriptId) return null
  return `https://www.tradingview.com/script/${scriptId}/`
}

export function selectExactTitleMatchScriptUrl(
  expectedTitle: string,
  results: ScriptApiResultItem[]
): string | null {
  const normalizedTitle = expectedTitle.trim().toLowerCase()
  const match = results.find((item) => item.name?.trim().toLowerCase() === normalizedTitle)
  if (!match) return null
  return canonicalizeTradingViewScriptUrl(match.chart_url || match.url || (match.image_url ? `https://www.tradingview.com/script/${match.image_url}/` : null))
}

/**
 * Convert user's cookie string/object to proper cookie format
 */
export function parseTVCookies(credentials: TVCredentials): Array<{
  name: string
  value: string
  domain: string
  path: string
  httpOnly: boolean
  secure: boolean
}> {
  return [
    {
      name: 'sessionid',
      value: credentials.sessionId,
      domain: '.tradingview.com',
      path: '/',
      httpOnly: true,
      secure: true,
    },
    {
      name: 'sessionid_sign',
      value: credentials.signature,
      domain: '.tradingview.com',
      path: '/',
      httpOnly: true,
      secure: true,
    },
  ]
}

// Dev mode bypass - skip actual TradingView operations
const DEV_BYPASS = process.env.NODE_ENV === 'development' && process.env.TV_DEV_BYPASS === 'true'

/**
 * Login to TradingView using server-configured credentials (TV_USERNAME/TV_PASSWORD)
 * First checks for a valid cached admin session to avoid CAPTCHA
 * If CAPTCHA is detected, automatically falls back to visible browser for manual solving
 * Note: This is for admin/server-level login only. User sessions are handled separately via kv.ts.
 * @param isVisibleRetry - Internal: true if this is a retry with visible browser for CAPTCHA
 */
export async function loginWithCredentials(isVisibleRetry: boolean = false): Promise<TVCredentials | null> {
  if (!TV_USERNAME || !TV_PASSWORD) {
    console.log('[TV] No username/password configured in environment')
    return null
  }

  // First, check for cached admin session (skip on visible retry since we need fresh login)
  if (!isVisibleRetry) {
    const cached = loadAdminCachedSession()
    if (cached) {
      console.log('[TV] Found cached admin session, verifying...')
      const isValid = await verifyTVSession({
        sessionId: cached.sessionId,
        signature: cached.signature,
        userId: 'admin',
      })

      if (isValid) {
        console.log('[TV] Cached admin session is valid, reusing...')
        return {
          sessionId: cached.sessionId,
          signature: cached.signature,
          userId: 'admin',
        }
      } else {
        console.log('[TV] Cached admin session is invalid, clearing...')
        clearAdminCachedSession()
      }
    }
  }

  let session: BrowserlessSession | null = null

  try {
    const mode = isVisibleRetry ? 'visible (for CAPTCHA)' : 'standard'
    console.log(`[TV] Attempting auto-login with environment credentials (${mode})`)
    session = await createBrowserSession({ forceVisible: isVisibleRetry })
    const { page } = session

    // Navigate to TradingView login page
    await navigateTo(page, 'https://www.tradingview.com/accounts/signin/')
    await delay(3000)

    // Check if already logged in (redirected away from signin page)
    let currentUrl = page.url()
    if (!currentUrl.includes('signin')) {
      console.log('[TV] Already logged in, checking for user menu...')

      // Check for user menu to confirm login
      const userMenuSelectors = [
        '[data-name="header-user-menu-button"]',
        '.tv-header__user-menu-button',
        'button[aria-label="Open user menu"]',
      ]

      let isLoggedIn = false
      for (const selector of userMenuSelectors) {
        const userMenu = await page.$(selector)
        if (userMenu) {
          isLoggedIn = true
          console.log(`[TV] Confirmed logged in, found user menu: ${selector}`)
          break
        }
      }

      if (isLoggedIn) {
        // Extract cookies directly
        const cookies = await page.cookies('https://www.tradingview.com')
        const sessionIdCookie = cookies.find(c => c.name === 'sessionid')
        const signatureCookie = cookies.find(c => c.name === 'sessionid_sign')

        if (sessionIdCookie && signatureCookie) {
          console.log('[TV] Cookies extracted from existing session')
          return {
            sessionId: sessionIdCookie.value,
            signature: signatureCookie.value,
            userId: 'auto-login',
          }
        }
      }

      console.log('[TV] Redirected but not logged in, navigating back to signin...')
      await navigateTo(page, 'https://www.tradingview.com/accounts/signin/')
      await delay(3000)
    }

    // TradingView shows social login buttons first, need to click "Email" tab
    // Try multiple selectors for the email tab
    const emailTabSelectors = [
      'button[name="Email"]',
      '[data-name="email"]',
      'button:has-text("Email")',
      '.tv-signin-dialog__toggle-email',
      'span:text("Email")',
    ]

    let emailTabClicked = false
    for (const selector of emailTabSelectors) {
      try {
        const element = await page.$(selector)
        if (element) {
          await element.click()
          emailTabClicked = true
          console.log(`[TV] Clicked email tab with selector: ${selector}`)
          await delay(1000)
          break
        }
      } catch {
        // Try next selector
      }
    }

    // If no email tab found, try clicking by text content
    if (!emailTabClicked) {
      try {
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, span, div'))
          const emailBtn = buttons.find(el => el.textContent?.trim().toLowerCase() === 'email')
          if (emailBtn) (emailBtn as HTMLElement).click()
        })
        console.log('[TV] Clicked email tab via text search')
        await delay(1000)
      } catch (e) {
        console.log('[TV] Could not find email tab, continuing anyway')
      }
    }

    // Try multiple selectors for username input
    const usernameSelectors = [
      'input[name="id_username"]',
      'input[name="username"]',
      'input[type="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="username" i]',
      '#id_username',
    ]

    let usernameInput = null
    for (const selector of usernameSelectors) {
      usernameInput = await page.$(selector)
      if (usernameInput) {
        console.log(`[TV] Found username input: ${selector}`)
        break
      }
    }

    if (!usernameInput) {
      console.error('[TV] Could not find username input')
      // Take screenshot for debugging
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-login-debug.png` })
      console.log(`[TV] Screenshot saved to ${SCREENSHOT_DIR}/tv-login-debug.png`)
      return null
    }

    // Type username
    await usernameInput.click()
    await delay(200)
    await usernameInput.type(TV_USERNAME, { delay: 50 })
    await delay(500)

    // Try multiple selectors for password input
    const passwordSelectors = [
      'input[name="id_password"]',
      'input[name="password"]',
      'input[type="password"]',
      '#id_password',
    ]

    let passwordInput = null
    for (const selector of passwordSelectors) {
      passwordInput = await page.$(selector)
      if (passwordInput) {
        console.log(`[TV] Found password input: ${selector}`)
        break
      }
    }

    if (!passwordInput) {
      console.error('[TV] Could not find password input')
      return null
    }

    // Type password
    await passwordInput.click()
    await delay(200)
    await passwordInput.type(TV_PASSWORD, { delay: 50 })
    await delay(500)

    // Try multiple selectors for submit button
    const submitSelectors = [
      'button[type="submit"]',
      'button[data-overflow-tooltip-text="Sign in"]',
      'button.tv-button__loader',
      'button:has-text("Sign in")',
      '.tv-button--primary',
    ]

    let submitClicked = false
    for (const selector of submitSelectors) {
      try {
        const btn = await page.$(selector)
        if (btn) {
          await btn.click()
          submitClicked = true
          console.log(`[TV] Clicked submit with selector: ${selector}`)
          break
        }
      } catch {
        // Try next
      }
    }

    // If no submit button found, try pressing Enter
    if (!submitClicked) {
      console.log('[TV] No submit button found, pressing Enter')
      await page.keyboard.press('Enter')
    }

    // Wait a moment for any CAPTCHA to appear
    await delay(2000)

    // Check for reCAPTCHA
    const hasCaptcha = await page.evaluate(() => {
      // Check for reCAPTCHA iframe
      const recaptchaFrame = document.querySelector('iframe[src*="recaptcha"]')
      if (recaptchaFrame) return true

      // Check for checkbox
      const checkbox = document.querySelector('.recaptcha-checkbox')
      if (checkbox) return true

      return false
    })

    if (hasCaptcha) {
      if (!isVisibleRetry) {
        // First attempt: retry with visible browser for manual CAPTCHA solving
        console.log('[TV] CAPTCHA detected - retrying with visible browser for manual solving...')
        await closeBrowserSession(session)
        session = null
        return loginWithCredentials(true)
      }

      // Already in visible mode - wait for user to solve CAPTCHA
      console.log('[TV] 🤖 CAPTCHA detected! Please solve it in the browser window...')
      console.log('[TV] Waiting up to 60 seconds for CAPTCHA to be solved...')

      // Wait for CAPTCHA to be solved (check every 2 seconds, up to 60 seconds)
      let captchaSolved = false
      for (let i = 0; i < 30; i++) {
        await delay(2000)

        // Check if we've been redirected away from signin page
        currentUrl = page.url()
        if (!currentUrl.includes('signin')) {
          console.log('[TV] ✅ CAPTCHA appears to be solved (redirected)')
          captchaSolved = true
          break
        }

        // Check if CAPTCHA disappeared
        const stillHasCaptcha = await page.evaluate(() => {
          const recaptchaFrame = document.querySelector('iframe[src*="recaptcha"]')
          return !!recaptchaFrame
        })

        if (!stillHasCaptcha) {
          console.log('[TV] ✅ CAPTCHA appears to be solved')
          captchaSolved = true
          break
        }
      }

      if (!captchaSolved) {
        console.error('[TV] CAPTCHA was not solved in time')
        await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-login-captcha-timeout.png` })
        return null
      }

      // Wait a bit more for login to process
      await delay(3000)
    } else {
      // No CAPTCHA, just wait for login to complete
      await delay(5000)
    }

    // Check if login was successful by looking for user menu or checking URL
    currentUrl = page.url()
    console.log(`[TV] Current URL after login: ${currentUrl}`)

    // Try to find user menu
    const userMenuSelectors = [
      '[data-name="header-user-menu-button"]',
      '.tv-header__user-menu-button',
      'button[aria-label="Open user menu"]',
    ]

    let isLoggedIn = false
    for (const selector of userMenuSelectors) {
      const userMenu = await page.$(selector)
      if (userMenu) {
        isLoggedIn = true
        console.log(`[TV] Found user menu: ${selector}`)
        break
      }
    }

    if (!isLoggedIn) {
      // Check if we're on a logged-in page (not signin page)
      if (!currentUrl.includes('signin')) {
        isLoggedIn = true
        console.log('[TV] Login appears successful (redirected from signin)')
      }
    }

    if (!isLoggedIn) {
      console.error('[TV] Login failed - could not verify login status')
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-login-failed.png` })
      console.log(`[TV] Screenshot saved to ${SCREENSHOT_DIR}/tv-login-failed.png`)
      return null
    }

    // Extract cookies
    const cookies = await page.cookies('https://www.tradingview.com')
    const sessionIdCookie = cookies.find(c => c.name === 'sessionid')
    const signatureCookie = cookies.find(c => c.name === 'sessionid_sign')

    if (!sessionIdCookie || !signatureCookie) {
      console.error('[TV] Login succeeded but could not extract session cookies')
      console.log('[TV] Available cookies:', cookies.map(c => c.name).join(', '))
      return null
    }

    console.log('[TV] Auto-login successful, cookies extracted')

    // Cache the admin session in memory for future use (no expiry)
    saveAdminCachedSession({
      sessionId: sessionIdCookie.value,
      signature: signatureCookie.value,
    })

    return {
      sessionId: sessionIdCookie.value,
      signature: signatureCookie.value,
      userId: 'admin',
    }
  } catch (error) {
    console.error('[TV] Auto-login failed:', error)
    return null
  } finally {
    if (session) {
      await closeBrowserSession(session)
    }
  }
}

/**
 * Verify TradingView session is valid
 */
export async function verifyTVSession(credentials: TVCredentials): Promise<boolean> {
  // Dev mode bypass
  if (DEV_BYPASS) {
    console.log('[TV] Dev bypass: Skipping session verification')
    return true
  }

  let session: BrowserlessSession | null = null

  try {
    session = await createBrowserSession()
    const { page } = session

    // Inject cookies
    const cookies = parseTVCookies(credentials)
    await injectCookies(page, cookies)

    // Navigate to TradingView
    await navigateTo(page, 'https://www.tradingview.com/chart/')

    // Wait for page to load and check for user menu (indicates logged in)
    const isLoggedIn = await waitForElement(page, TV_SELECTORS.auth.userMenu, 10000)

    return isLoggedIn
  } catch (error) {
    console.error('Session verification failed:', error)
    return false
  } finally {
    if (session) {
      await closeBrowserSession(session)
    }
  }
}

/**
 * Validate a Pine Script in TradingView's editor
 */
export async function validatePineScript(
  credentials: TVCredentials,
  script: string
): Promise<ValidationResult> {
  // Dev mode bypass
  if (DEV_BYPASS) {
    console.log('[TV] Dev bypass: Skipping script validation')
    return {
      isValid: true,
      errors: [],
      rawOutput: '[Dev Mode] Validation bypassed',
    }
  }

  // Use the faster /pine/ page if feature flag is enabled
  if (USE_PINE_EDITOR_PAGE) {
    console.log('[TV] Using /pine/ page for validation (TV_USE_PINE_PAGE=true)')
    return validatePineScriptV2(credentials, script)
  }

  // Legacy path: Use /chart/ page
  console.log('[TV] Using /chart/ page for validation (legacy)')
  let session: BrowserlessSession | null = null

  try {
    session = await createBrowserSession()
    const { page } = session

    // Inject cookies
    const cookies = parseTVCookies(credentials)
    await injectCookies(page, cookies)

    // Navigate to TradingView chart
    const navigated = await navigateTo(page, TV_URLS.chart)
    if (!navigated) {
      throw new Error('Failed to navigate to TradingView')
    }

    console.log('[TV] Enforcing /chart/ context and opening Pine Editor...')
    await delay(1500)
    await ensureChartPineEditorOpen(page, 'TV Validate')

    // Wait for Monaco editor to be ready
    console.log('[TV] Waiting for Monaco editor...')
    await waitForElement(page, TV_SELECTORS.pineEditor.editorArea, 10000)
    await delay(500) // Give editor time to fully initialize

    // Insert script via clipboard paste
    console.log('[TV] Inserting script via clipboard paste...')
    await page.click('.monaco-editor')
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')
    await delay(100)
    await page.evaluate((text) => navigator.clipboard.writeText(text), script)
    await page.keyboard.down('Control')
    await page.keyboard.press('v')
    await page.keyboard.up('Control')
    console.log('[TV] Script inserted via clipboard paste')

    // Wait for compilation (TradingView auto-compiles)
    await delay(3000)

    // Check console panel for errors
    const errors = await page.evaluate((selectors) => {
      const consolePanel = document.querySelector(selectors.consolePanel)
      if (!consolePanel) return []

      const errorLines = consolePanel.querySelectorAll(selectors.errorLine)
      const warningLines = consolePanel.querySelectorAll(selectors.warningLine)

      const parseConsoleLine = (element: Element, type: 'error' | 'warning') => {
        const text = element.textContent || ''
        // Try to extract line number from error message
        const lineMatch = text.match(/line (\d+)/i)
        return {
          line: lineMatch ? parseInt(lineMatch[1], 10) : 0,
          message: text.trim(),
          type,
        }
      }

      return [
        ...Array.from(errorLines).map((el) => parseConsoleLine(el, 'error')),
        ...Array.from(warningLines).map((el) => parseConsoleLine(el, 'warning')),
      ]
    }, TV_SELECTORS.pineEditor)

    // Get raw console output
    const rawOutput = await page.evaluate((selector) => {
      const panel = document.querySelector(selector)
      return panel?.textContent || ''
    }, TV_SELECTORS.pineEditor.consolePanel)

    return {
      isValid: errors.filter((e) => e.type === 'error').length === 0,
      errors,
      rawOutput,
    }
  } catch (error) {
    console.error('Script validation failed:', error)
    return {
      isValid: false,
      errors: [
        {
          line: 0,
          message: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          type: 'error',
        },
      ],
      rawOutput: '',
    }
  } finally {
    if (session) {
      await closeBrowserSession(session)
    }
  }
}

/**
 * Validate a Pine Script using the dedicated /pine/ editor page
 * This is faster than /chart/ as it doesn't load charting components
 */
async function validatePineScriptV2(
  credentials: TVCredentials,
  script: string
): Promise<ValidationResult> {
  let session: BrowserlessSession | null = null

  try {
    session = await createBrowserSession()
    const { page } = session

    // Inject cookies
    const cookies = parseTVCookies(credentials)
    await injectCookies(page, cookies)

    // Navigate to dedicated Pine Editor page (faster than chart)
    console.log('[TV v2] Navigating to /pine/ editor page...')
    const navigated = await navigateTo(page, TV_URLS.pine)
    if (!navigated) {
      throw new Error('Failed to navigate to Pine Editor page')
    }

    // Wait for Monaco editor to be ready (should be immediate on /pine/)
    console.log('[TV v2] Waiting for Monaco editor...')
    const editorReady = await waitForElement(page, TV_SELECTORS.pineEditorPage.editorArea, 15000)
    if (!editorReady) {
      // Take screenshot for debugging
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-pine-page-no-editor.png` })
      console.log(`[TV v2] Screenshot saved to ${SCREENSHOT_DIR}/tv-pine-page-no-editor.png`)
      throw new Error('Monaco editor did not load on /pine/ page')
    }

    // Allow Monaco to fully initialize
    await delay(500)

    // Insert script via clipboard paste (Monaco API not exposed on /pine/ page)
    console.log('[TV v2] Inserting script via clipboard paste...')
    await page.click('.monaco-editor')
    await delay(100)
    // Select all existing content
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')
    await delay(100)
    // Paste new content via clipboard
    await page.evaluate((text) => navigator.clipboard.writeText(text), script)
    await page.keyboard.down('Control')
    await page.keyboard.press('v')
    await page.keyboard.up('Control')
    console.log('[TV v2] Script inserted via clipboard paste')

    // Wait for auto-compilation
    await delay(1500)

    // Check for compile button and click if present (some versions may need manual trigger)
    const compileTriggered = await page.evaluate(() => {
      const compileSelectors = [
        '[data-name="compile-button"]',
        '[data-name="add-script-to-chart"]',
        '[aria-label*="compile" i]',
        '[aria-label*="Add to chart" i]',
        '[title*="compile" i]',
        '[title*="Add to chart" i]',
      ]

      for (const selector of compileSelectors) {
        try {
          const btn = document.querySelector(selector) as HTMLElement
          if (btn) {
            btn.click()
            return { clicked: true, selector }
          }
        } catch {
          // Invalid selector, skip
        }
      }

      // Fallback: search by text content
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      const addToChartBtn = buttons.find(btn => {
        const text = btn.textContent?.toLowerCase() || ''
        return text.includes('add to chart') || text.includes('compile')
      })
      if (addToChartBtn) {
        (addToChartBtn as HTMLElement).click()
        return { clicked: true, selector: 'text search: add to chart' }
      }

      return { clicked: false, selector: null }
    })

    if (compileTriggered.clicked) {
      console.log(`[TV v2] Clicked compile button: ${compileTriggered.selector}`)
      await delay(2500)
    }

    // Extract errors from console panel
    const errors = await page.evaluate((selectors) => {
      // Try primary console panel selector, then alternatives
      const consoleSelectors = [
        selectors.consolePanel,
        selectors.altConsolePanel,
        '.console-panel',
        '[class*="console"]',
      ]

      let consolePanel: Element | null = null
      for (const sel of consoleSelectors) {
        consolePanel = document.querySelector(sel)
        if (consolePanel) break
      }

      if (!consolePanel) return []

      // Find error and warning lines
      const errorSelectors = [selectors.errorLine, selectors.altErrorLine, '.error']
      const warningSelectors = [selectors.warningLine, selectors.altWarningLine, '.warning']

      const findElements = (sels: string[]) => {
        for (const sel of sels) {
          const els = consolePanel!.querySelectorAll(sel)
          if (els.length > 0) return Array.from(els)
        }
        return []
      }

      const errorLines = findElements(errorSelectors)
      const warningLines = findElements(warningSelectors)

      const parseConsoleLine = (element: Element, type: 'error' | 'warning') => {
        const text = element.textContent || ''
        // Try to extract line number from error message
        const lineMatch = text.match(/line (\d+)/i)
        return {
          line: lineMatch ? parseInt(lineMatch[1], 10) : 0,
          message: text.trim(),
          type,
        }
      }

      return [
        ...errorLines.map((el) => parseConsoleLine(el, 'error')),
        ...warningLines.map((el) => parseConsoleLine(el, 'warning')),
      ]
    }, TV_SELECTORS.pineEditorPage)

    // Get raw console output
    const rawOutput = await page.evaluate(() => {
      const selectors = [
        '[data-name="console-panel"]',
        '.pine-console',
        '.console-panel',
        '[class*="console"]',
      ]

      for (const sel of selectors) {
        const panel = document.querySelector(sel)
        if (panel?.textContent) return panel.textContent
      }
      return ''
    })

    console.log(`[TV v2] Validation complete: ${errors.filter(e => e.type === 'error').length} errors, ${errors.filter(e => e.type === 'warning').length} warnings`)

    return {
      isValid: errors.filter((e) => e.type === 'error').length === 0,
      errors,
      rawOutput,
    }
  } catch (error) {
    console.error('[TV v2] Script validation failed:', error)
    return {
      isValid: false,
      errors: [
        {
          line: 0,
          message: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          type: 'error',
        },
      ],
      rawOutput: '',
    }
  } finally {
    if (session) {
      await closeBrowserSession(session)
    }
  }
}

export type VisibilityLevel = 'open' | 'protected' | 'invite-only'

export interface PublishOptions {
  script: string
  title: string
  description: string
  visibility?: 'public' | 'private' // Default: 'public'
  visibilityLevel?: VisibilityLevel // Default: 'open' (only applies when visibility is 'public')
}

// ============ Publish Dialog Helper Functions ============
// These helpers implement the two-step publish workflow matching the TradingView UI

/**
 * Fill the title field in the publish dialog (Step 1)
 */
async function fillTitleField(
  page: import('puppeteer-core').Page,
  title: string
): Promise<boolean> {
  console.log(`[TV Publish Helper] Filling title: "${title}"`)

  // Wait for dialog to render
  await delay(2000)

  // Use CDP selectors (page.$) instead of page.evaluate to avoid JS execution hangs
  const titleSelectors = [
    'input[placeholder="Title"]',
    'input[value="My script"]',
    'input[placeholder="My script"]',
    'input[class*="title-input"]',
  ]

  for (const sel of titleSelectors) {
    try {
      const input = await Promise.race([
        page.$(sel),
        new Promise<null>((r) => setTimeout(() => r(null), 10000)),
      ])
      if (input) {
        console.log(`[TV Publish Helper] Found title input: ${sel}`)
        await input.click({ clickCount: 3 }) // Select all
        await delay(50)
        await page.keyboard.type(title, { delay: 10 })
        console.log(`[TV Publish Helper] Title filled: "${title}"`)
        return true
      }
    } catch (e) {
      console.log(`[TV Publish Helper] Selector ${sel} failed: ${e instanceof Error ? e.message : e}`)
    }
  }

  console.log('[TV Publish Helper] Warning: Could not find title input')
  return false
}

/**
 * Fill the rich text description editor in the publish dialog (Step 1)
 * The description is a contenteditable div, not a textarea
 */
async function fillRichTextDescription(
  page: import('puppeteer-core').Page,
  description: string
): Promise<boolean> {
  console.log(`[TV Publish Helper] Filling description: "${description.slice(0, 50)}..."`)

  // Use CDP selector to find contenteditable, then use keyboard
  try {
    const editable = await Promise.race([
      page.$('[contenteditable="true"]'),
      new Promise<null>((r) => setTimeout(() => r(null), 10000)),
    ])
    if (editable) {
      await editable.click()
      await delay(100)
      // Use keyboard shortcut to select all and replace
      await page.keyboard.down('Control')
      await page.keyboard.press('a')
      await page.keyboard.up('Control')
      await delay(50)
      // Type a short description (avoid slow char-by-char for long text)
      const shortDesc = description.length > 100 ? description.slice(0, 100) : description
      await page.keyboard.type(shortDesc, { delay: 5 })
      console.log('[TV Publish Helper] Description filled via CDP + keyboard')
      return true
    }
  } catch (e) {
    console.log(`[TV Publish Helper] Description fill failed: ${e instanceof Error ? e.message : e}`)
  }

  console.log('[TV Publish Helper] Warning: Could not fill description')
  return false
}

/**
 * Click the "Continue" button to move from Step 1 to Step 2
 * Returns true if successfully moved to Step 2
 */
async function clickContinueButton(
  page: import('puppeteer-core').Page
): Promise<boolean> {
  console.log('[TV Publish Helper] Clicking Continue to go to Step 2...')

  // Use XPath to find Continue button by text
  try {
    const buttons = await Promise.race([
      page.$$('xpath/.//button[contains(text(), "Continue")]'),
      new Promise<never[]>((r) => setTimeout(() => r([]), 10000)),
    ])
    if (buttons.length > 0) {
      await buttons[0].click()
      console.log('[TV Publish Helper] Clicked Continue button')
      await delay(400)
      return true
    }
  } catch (e) {
    console.log(`[TV Publish Helper] Continue button error: ${e instanceof Error ? e.message : e}`)
  }

  console.log('[TV Publish Helper] Warning: Could not find Continue button')
  return false
}

/**
 * Set privacy (Public/Private) and visibility level (Open/Protected/Invite-only) on Step 2
 */
async function setVisibilityOptions(
  page: import('puppeteer-core').Page,
  privacy: 'public' | 'private',
  visibilityLevel?: VisibilityLevel
): Promise<boolean> {
  console.log(`[TV Publish Helper] Setting visibility: ${privacy}${visibilityLevel ? ` + ${visibilityLevel}` : ''}`)

  // Click Public or Private button using XPath
  let privacyClicked = false
  try {
    const capitalPrivacy = privacy.charAt(0).toUpperCase() + privacy.slice(1)
    const buttons = await Promise.race([
      page.$$(`xpath/.//button[contains(text(), "${capitalPrivacy}")] | .//label[contains(text(), "${capitalPrivacy}")]`),
      new Promise<never[]>((r) => setTimeout(() => r([]), 10000)),
    ])
    if (buttons.length > 0) {
      await buttons[0].click()
      privacyClicked = true
      console.log(`[TV Publish Helper] Clicked ${privacy} option`)
    }
  } catch (e) {
    console.log(`[TV Publish Helper] Privacy click error: ${e instanceof Error ? e.message : e}`)
  }

  if (!privacyClicked) {
    console.log(`[TV Publish Helper] Warning: Could not find ${privacy} option`)
  }

  await delay(300)
  return privacyClicked
}

/**
 * Click the final "Publish public script" or "Publish private script" button
 */
async function clickFinalPublishButton(
  page: import('puppeteer-core').Page,
  privacy: 'public' | 'private'
): Promise<boolean> {
  const expectedText = privacy === 'public' ? 'Publish public script' : 'Publish private script'
  console.log(`[TV Publish Helper] Looking for "${expectedText}" button...`)

  // Use page.evaluate for reliable dialog-scoped search and exact text matching only.
  const clicked = await Promise.race([
    page.evaluate((args: { expected: string; privacy: 'public' | 'private' }) => {
      const { expected, privacy } = args
      // Scope strictly to visible publish dialog containers first.
      const dialogs = Array.from(
        document.querySelectorAll('[data-dialog-name="publish-script"], [class*="dialog"], [role="dialog"]')
      ).filter((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })

      const getVisibleButtons = (root: ParentNode) =>
        Array.from(root.querySelectorAll('button, [role="button"], input[type="submit"]'))
          .filter(el => (el as HTMLElement).getBoundingClientRect().width > 0)

      const clickButton = (btn: Element, matchType: string): string => {
        ;(btn as HTMLElement).click()
        const text = btn.textContent?.trim() || ''
        const tag = btn.tagName.toLowerCase()
        const role = (btn as HTMLElement).getAttribute('role') || ''
        return `${matchType}:${text}:tag=${tag}:role=${role || 'none'}:dialogScoped=true`
      }

      const findAndClick = (root: ParentNode): string | null => {
        const buttons = getVisibleButtons(root)

        // Try exact match first
        for (const btn of buttons) {
          const text = btn.textContent?.trim() || ''
          if (text.toLowerCase() === expected.toLowerCase()) {
            return clickButton(btn, 'exact')
          }
        }
        // Fallback: same privacy only, allowing text variants.
        for (const btn of buttons) {
          const text = btn.textContent?.trim().toLowerCase() || ''
          if (text.startsWith('publish') && text.includes(privacy.toLowerCase()) && text.includes('script')) {
            return clickButton(btn, 'partial')
          }
        }
        return null
      }

      for (const dialog of dialogs) {
        const clicked = findAndClick(dialog)
        if (clicked) return clicked
      }

      // Last fallback: no dialog found, search whole document.
      if (dialogs.length === 0) {
        const clicked = findAndClick(document)
        if (clicked) return clicked
      }

      const visibleBtnsInDialogs = dialogs
        .flatMap((dialog) =>
          Array.from(dialog.querySelectorAll('button, [role="button"], input[type="submit"]'))
            .filter((el) => (el as HTMLElement).getBoundingClientRect().width > 0)
            .map((el) => (el.textContent?.trim() || '(no-text)').slice(0, 50))
        )
        .slice(0, 20)

      if (dialogs.length > 0) {
        return `NOT_FOUND_DIALOG_SCOPED:expected=${expected}:buttons=[${visibleBtnsInDialogs.join('|')}]`
      }

      const visibleBtns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
        .filter((el) => (el as HTMLElement).getBoundingClientRect().width > 0)
        .map((el) => (el.textContent?.trim() || '(no-text)').slice(0, 50))
        .slice(0, 20)
      return `NOT_FOUND_NO_DIALOG:expected=${expected}:buttons=[${visibleBtns.join('|')}]`
    }, { expected: expectedText, privacy }),
    new Promise<string>((r) => setTimeout(() => r('TIMEOUT'), 5000)),
  ])

  if (clicked && !clicked.startsWith('NOT_FOUND') && clicked !== 'TIMEOUT') {
    console.log(`[TV Publish Helper] Clicked final publish button: ${clicked}`)
    return true
  }

  console.log(`[TV Publish Helper] Warning: Could not find exact final publish button: ${clicked}`)
  return false
}

interface CapturePublishedScriptUrlOptions {
  logTag: string
  title: string
  captureWindowMs?: number
}

async function capturePublishedScriptUrl(
  page: import('puppeteer-core').Page,
  options: CapturePublishedScriptUrlOptions
): Promise<{ url?: string; source?: PublishResult['captureSource'] }> {
  const captureWindowMs = options.captureWindowMs || URL_CAPTURE_WINDOW_MS
  const startedAt = Date.now()
  const deadline = startedAt + captureWindowMs
  console.log(`[${options.logTag}] Starting script URL capture (${captureWindowMs}ms budget)`)
  const serviceAccountUsername = resolveScriptsApiUsername()
  if (!serviceAccountUsername) {
    console.log(`[${options.logTag}] TV_SERVICE_ACCOUNT_USERNAME/TV_USERNAME is not set; skipping scripts API lookup`)
  }
  let capturedScriptId: string | null = null
  let newTabUrl: string | null = null
  let apiAttempt = 0

  const responseHandler = async (response: import('puppeteer-core').HTTPResponse) => {
    try {
      const url = response.url()
      const status = response.status()
      const isRelevantUrl = (
        url.includes('tradingview.com') &&
        (url.includes('pine-facade') || url.includes('/publish') || url.includes('/save') || url.includes('/create') || url.includes('/script') || url.includes('/api/'))
      )

      if (!isRelevantUrl || status < 200 || status >= 300 || capturedScriptId) return
      const text = await response.text().catch(() => '')
      const extracted = extractScriptIdFromText(text) || extractScriptIdFromUrl(url)
      if (extracted) {
        capturedScriptId = extracted
        console.log(`[${options.logTag}] Captured script ID from network: ${capturedScriptId}`)
      }
    } catch {
      // Ignore per-response parsing errors
    }
  }

  page.on('response', responseHandler)

  const browser = page.browser()
  let newPageListener: ((target: import('puppeteer-core').Target) => Promise<void>) | null = null
  let newPageTimeout: NodeJS.Timeout | null = null

  const newPagePromise = new Promise<void>((resolve) => {
    newPageTimeout = setTimeout(() => {
      resolve()
    }, captureWindowMs)

    newPageListener = async (target) => {
      if (target.type() !== 'page') return
      try {
        const newPage = await target.page()
        if (!newPage) return
        await newPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {})
        newTabUrl = canonicalizeTradingViewScriptUrl(newPage.url())
        if (newTabUrl) {
          console.log(`[${options.logTag}] Captured script URL from new tab: ${newTabUrl}`)
        }
        await newPage.close().catch(() => {})
      } catch {
        // Ignore new tab errors
      } finally {
        resolve()
      }
    }

    browser?.once('targetcreated', newPageListener)
  })

  try {
    while (Date.now() < deadline) {
      if (newTabUrl) return { url: newTabUrl, source: 'new-tab' }

      if (capturedScriptId) {
        return {
          url: `https://www.tradingview.com/script/${capturedScriptId}/`,
          source: 'network-id',
        }
      }

      const redirectUrl = canonicalizeTradingViewScriptUrl(page.url())
      if (redirectUrl) {
        console.log(`[${options.logTag}] Captured redirect URL: ${redirectUrl}`)
        return { url: redirectUrl, source: 'redirect' }
      }

      const domUrlRaw = await timedEvaluate<string | null>(
        page,
        () => {
          const toasts = document.querySelectorAll('[class*="toast"], [class*="notification"], [class*="snackbar"], [data-name*="toast"]')
          for (const toast of toasts) {
            const link = toast.querySelector('a[href*="/script/"]') as HTMLAnchorElement | null
            if (link?.href) return link.href
          }

          const links = Array.from(document.querySelectorAll('a[href*="/script/"]'))
          for (const link of links) {
            const href = (link as HTMLAnchorElement).href
            if (href.includes('tradingview.com/script/')) return href
          }

          const bodyText = document.body?.innerText || ''
          const match = bodyText.match(/tradingview\.com\/script\/([a-zA-Z0-9]+)/)
          if (match) return `https://www.tradingview.com/script/${match[1]}/`
          return null
        },
        undefined,
        3000,
        null,
      ).catch(() => null)
      const domUrl = canonicalizeTradingViewScriptUrl(domUrlRaw)
      if (domUrl) {
        console.log(`[${options.logTag}] Captured URL from DOM: ${domUrl}`)
        return { url: domUrl, source: 'dom' }
      }

      const now = Date.now()
      const elapsedMs = now - startedAt
      const isScheduledApiAttempt = (
        serviceAccountUsername &&
        apiAttempt < API_LOOKUP_ELAPSED_SCHEDULE_MS.length &&
        elapsedMs >= API_LOOKUP_ELAPSED_SCHEDULE_MS[apiAttempt]
      )

      if (isScheduledApiAttempt) {
        apiAttempt += 1
        console.log(
          `[${options.logTag}] Scripts API lookup attempt ${apiAttempt}/${API_LOOKUP_ELAPSED_SCHEDULE_MS.length} at ${elapsedMs}ms`
        )
        const apiResults = await timedEvaluate(
          page,
          async ({ username, expectedTitle }) => {
            try {
              const encodedTitle = encodeURIComponent(expectedTitle)
              const controller = new AbortController()
              const timeout = setTimeout(() => controller.abort(), 5000)
              const res = await fetch(
                `https://www.tradingview.com/api/v1/scripts/?page=1&per_page=10&by=${username}&q=${encodedTitle}`,
                { signal: controller.signal }
              )
              clearTimeout(timeout)
              if (!res.ok) return []
              const data = await res.json()
              if (!Array.isArray(data?.results)) return []
              return data.results.slice(0, 10)
            } catch {
              return []
            }
          },
          { username: serviceAccountUsername, expectedTitle: options.title },
          6000,
          [] as ScriptApiResultItem[],
        ).catch(() => [] as ScriptApiResultItem[])

        const canonicalApiUrl = selectExactTitleMatchScriptUrl(options.title, apiResults as ScriptApiResultItem[])
        if (canonicalApiUrl) {
          console.log(`[${options.logTag}] Captured URL from scripts API exact match: ${canonicalApiUrl}`)
          return { url: canonicalApiUrl, source: 'scripts-api' }
        }
        console.log(`[${options.logTag}] Scripts API attempt ${apiAttempt}: no exact title match (results=${apiResults.length})`)
      }

      await delay(250)
    }

    await newPagePromise.catch(() => {})
    if (newTabUrl) return { url: newTabUrl, source: 'new-tab' }
    if (capturedScriptId) {
      return {
        url: `https://www.tradingview.com/script/${capturedScriptId}/`,
        source: 'network-id',
      }
    }
    console.log(
      `[${options.logTag}] Script URL capture exhausted after ${Date.now() - startedAt}ms (apiAttempts=${apiAttempt})`
    )
    return {}
  } finally {
    page.off('response', responseHandler)
    if (newPageListener && browser) {
      browser.off('targetcreated', newPageListener)
    }
    if (newPageTimeout) {
      clearTimeout(newPageTimeout)
    }
  }
}

/**
 * Publish a Pine Script as a private indicator
 */
export async function publishPineScript(
  credentials: TVCredentials,
  options: PublishOptions
): Promise<PublishResult> {
  const { script, title, description } = options

  // Dev mode bypass
  if (DEV_BYPASS) {
    console.log('[TV] Dev bypass: Simulating script publish')
    const fakeId = Math.random().toString(36).substring(7)
    return {
      success: true,
      indicatorUrl: `https://www.tradingview.com/script/${fakeId}/dev-test-indicator`,
    }
  }

  console.log('[TV Publish] Using /chart/ page for publishing')
  let session: BrowserlessSession | null = null

  try {
    session = await createBrowserSession()
    const { page } = session

    // Inject cookies
    const cookies = parseTVCookies(credentials)
    await injectCookies(page, cookies)

    // Navigate to TradingView chart
    await navigateTo(page, TV_URLS.chart)
    console.log('[TV Publish] Navigated to chart, waiting for page load...')
    await delay(1500)

    await ensureChartPineEditorOpen(page, 'TV Publish')
    console.log('[TV Publish] Pine Editor ready on /chart/')

    // Insert script via clipboard paste
    console.log('[TV Publish] Inserting script via clipboard paste...')
    await page.click('.monaco-editor')
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')
    await delay(100)
    await page.evaluate((text) => navigator.clipboard.writeText(text), script)
    await page.keyboard.down('Control')
    await page.keyboard.press('v')
    await page.keyboard.up('Control')
    console.log('[TV Publish] Script inserted via clipboard paste')

    // Wait for initial compilation
    await delay(1000)

    // First, click "Add to chart" to verify the script compiles correctly
    console.log('[TV Publish] Clicking "Add to chart" to verify script...')
    const addToChartSelectors = [
      '[data-name="add-script-to-chart"]',
      '[aria-label*="Add to chart" i]',
      '[title*="Add to chart" i]',
      'button[class*="apply" i]',
    ]

    let addToChartClicked = false
    for (const selector of addToChartSelectors) {
      try {
        const btn = await page.$(selector)
        if (btn) {
          await btn.click()
          addToChartClicked = true
          console.log(`[TV Publish] Clicked "Add to chart": ${selector}`)
          break
        }
      } catch {
        // Try next selector
      }
    }

    if (!addToChartClicked) {
      // Fallback: search by text content
      addToChartClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
        const btn = buttons.find(b => {
          const text = b.textContent?.toLowerCase() || ''
          return text.includes('add to chart') || text.includes('apply')
        })
        if (btn) {
          (btn as HTMLElement).click()
          return true
        }
        return false
      })
      if (addToChartClicked) {
        console.log('[TV Publish] Clicked "Add to chart" via text search')
      }
    }

    if (!addToChartClicked) {
      console.log('[TV Publish] Warning: Could not find "Add to chart" button, continuing anyway...')
    }

    // Wait for script to be added to chart and verified
    await delay(1500)

    // Click publish button with strict selector allowlist
    console.log('[TV Publish] Looking for publish button...')
    const publishClicked = await clickPublishButtonInChart(page, 'TV Publish')

    if (!publishClicked) {
      // Take screenshot for debugging
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-chart-publish-no-button.png` })
      console.log(`[TV Publish] Screenshot saved to ${SCREENSHOT_DIR}/tv-chart-publish-no-button.png`)
      throw new Error('Could not find publish button')
    }
    console.log(`[TV Publish] Clicked publish button: ${publishClicked}`)

    // Wait for publish dialog
    const dialogFound = await waitForElement(page, TV_SELECTORS.publish.dialog, 10000)
    if (!dialogFound) {
      // Try alternative dialog selectors
      const altDialogFound = await waitForElement(page, '[class*="dialog"]', 5000)
      if (!altDialogFound) {
        console.log('[TV Publish] Publish dialog not found, continuing anyway...')
      }
    }

    // === STEP 1: Fill in title and description ===
    console.log('[TV Publish] Step 1: Filling title and description...')
    await delay(500)
    const { visibilityLevel } = options

    // Fill title using helper function
    await fillTitleField(page, title)

    // Fill description using helper function (handles contenteditable rich text editor)
    const descriptionText = description || title
    await fillRichTextDescription(page, descriptionText)

    // Click Continue to go to Step 2
    const movedToStep2 = await clickContinueButton(page)
    if (!movedToStep2) {
      console.log('[TV Publish] Warning: Continue button may have failed')
    }

    // === STEP 2: Set visibility and final submit ===
    console.log('[TV Publish] Step 2: Setting visibility options...')
    await delay(200)

    // Set privacy and visibility level using helper function
    const visibility = options.visibility || 'public'
    await setVisibilityOptions(page, visibility, visibilityLevel)

    // Check required checkboxes (terms, etc.)
    const checkboxes = await page.$$('input[type="checkbox"]:not(:checked)')
    for (const checkbox of checkboxes) {
      try {
        await checkbox.click()
        console.log('[TV Publish] Checked a required checkbox')
      } catch { /* ignore */ }
    }

    await delay(200)

    // Final submit using helper function
    console.log('[TV Publish] Clicking final Publish button...')
    const submitted = await clickFinalPublishButton(page, visibility)

    if (!submitted) {
      // Take screenshot for debugging
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-publish-step2-failed.png` })
      console.log(`[TV Publish] Screenshot saved to ${SCREENSHOT_DIR}/tv-publish-step2-failed.png`)
      throw new Error('Could not find final Publish button in step 2')
    }

    const captured = await capturePublishedScriptUrl(page, {
      logTag: 'TV Publish',
      title,
      captureWindowMs: URL_CAPTURE_WINDOW_MS,
    })

    if (captured.url) {
      return {
        success: true,
        indicatorUrl: captured.url,
        captureSource: captured.source,
      }
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-publish-no-url.png` }).catch(() => {})
    console.log(`[TV Publish] Screenshot saved to ${SCREENSHOT_DIR}/tv-publish-no-url.png`)
    console.log(`[TV Publish] Publish completed but script URL could not be captured within ${URL_CAPTURE_WINDOW_MS}ms`)
    return {
      success: false,
      errorCode: 'URL_CAPTURE_FAILED_AFTER_PUBLISH',
      publishedButUrlUnknown: true,
      error: `Publish likely succeeded, but script URL could not be captured within ${Math.round(URL_CAPTURE_WINDOW_MS / 1000)} seconds. Check TradingView profile and retry.`,
    }
  } catch (error) {
    console.error('Script publishing failed:', error)
    return {
      success: false,
      errorCode: 'PUBLISH_ACTION_FAILED',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  } finally {
    if (session) {
      await closeBrowserSession(session)
    }
  }
}

/**
 * Combined result for validate and publish
 */
export interface ValidateAndPublishResult {
  validation: ValidationResult
  publish?: PublishResult
  /** If true, failure was due to infrastructure (session disconnect, etc.) - don't retry with AI fix */
  infrastructureError?: boolean
}

/**
 * Validate and optionally publish a Pine Script using an existing warm session
 * This is the fastest path - browser already has TradingView loaded with Pine Editor open
 * Used when USE_WARM_LOCAL_BROWSER=true
 *
 * @param page - Pre-loaded page with Pine Editor already open
 * @param script - Pine Script code to validate
 * @param publishOptions - Optional publish settings
 * @returns Validation and optionally publish result
 */
export async function validateAndPublishWithWarmSession(
  page: import('puppeteer-core').Page,
  script: string,
  publishOptions?: {
    title: string
    description: string
    visibility?: 'public' | 'private'
    visibilityLevel?: VisibilityLevel
  }
): Promise<ValidateAndPublishResult> {
  const startTime = Date.now()
  console.log('[Warm Validate] Starting validation with warm session...')

  try {
    // Reset editor state (clear previous content)
    console.log('[Warm Validate] Resetting editor state...')
    await page.keyboard.press('Escape')
    await delay(100)
    await page.keyboard.press('Escape')
    await delay(100)

    await ensureChartContext(page, 'Warm Validate')

    // Check if Monaco editor is accessible (might have navigated away after last publish)
    let editorExists = await page.$('.monaco-editor')
    if (!editorExists) {
      console.log('[Warm Validate] Monaco editor not found, reopening from strict chart selectors...')
      await ensureChartPineEditorOpen(page, 'Warm Validate')
      editorExists = await page.$('.monaco-editor')
    }

    if (!editorExists) {
      throw new Error('Monaco editor not found after navigation')
    }

    // Remove existing indicators from the chart (TradingView free tier limits to 2)
    console.log('[Warm Validate] Removing existing indicators from chart...')
    const removedCount = await timedEvaluate<number>(
      page,
      () => {
        let removed = 0
        // Find all indicator legends/headers on the chart
        const indicatorHeaders = document.querySelectorAll('[data-name="legend-source-item"], [class*="legend-"] [class*="title"], .chart-controls-bar [data-name]')

        for (const header of indicatorHeaders) {
          // Look for close/remove button within or near the indicator
          const closeBtn = header.querySelector('[data-name="legend-delete-action"], [class*="close"], [class*="remove"], [aria-label*="Remove"]') as HTMLElement
          if (closeBtn) {
            closeBtn.click()
            removed++
          }
        }

        // Also try clicking any visible "Remove" buttons in indicator panels
        const removeButtons = document.querySelectorAll('[data-name="legend-delete-action"], button[aria-label*="Remove" i]')
        for (const btn of removeButtons) {
          try {
            (btn as HTMLElement).click()
            removed++
          } catch {
            // Ignore
          }
        }

        return removed
      },
      undefined,
      5000,
      0,
    ).catch(() => 0)

    if (removedCount > 0) {
      console.log(`[Warm Validate] Removed ${removedCount} existing indicators`)
      await delay(500)
    }

    // Click on Monaco editor to focus
    await page.click('.monaco-editor')
    await delay(100)

    // Select all and delete
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')
    await delay(50)
    await page.keyboard.press('Delete')
    await delay(100)

    // Insert script via clipboard paste
    console.log('[Warm Validate] Inserting script...')
    await timedEvaluate(page, (text) => navigator.clipboard.writeText(text), script, 3000, undefined)
    await page.keyboard.down('Control')
    await page.keyboard.press('v')
    await page.keyboard.up('Control')
    console.log('[Warm Validate] Script inserted')

    // Wait briefly for compilation signals without forcing a long fixed sleep.
    await Promise.race([
      page.waitForNetworkIdle({ idleTime: 300, timeout: 900 }),
      delay(600),
    ]).catch(() => {})

    // Click "Add to chart" to trigger validation
    const startUrl = page.url()
    console.log(`[Warm Validate] Clicking "Add to chart"... (current URL: ${startUrl})`)
    const addToChartClicked = await timedEvaluate<{ clicked: boolean; selector: string | null }>(
      page,
      () => {
        const selectors = [
          '[data-name="add-script-to-chart"]',
          '[aria-label*="Add to chart" i]',
          '[title*="Add to chart" i]',
        ]

        for (const selector of selectors) {
          try {
            const btn = document.querySelector(selector) as HTMLElement
            if (btn) {
              btn.click()
              return { clicked: true, selector }
            }
          } catch {
            // Try next
          }
        }

        // Fallback: search by text
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
        const btn = buttons.find(b => {
          const text = b.textContent?.toLowerCase() || ''
          return text.includes('add to chart')
        })
        if (btn) {
          (btn as HTMLElement).click()
          return { clicked: true, selector: 'text search' }
        }

        return { clicked: false, selector: null }
      },
      undefined,
      5000,
      { clicked: false, selector: null },
    ).catch(() => ({ clicked: false, selector: null }))

    if (addToChartClicked.clicked) {
      console.log(`[Warm Validate] Clicked "Add to chart": ${addToChartClicked.selector}`)
    }

    // Log current URL to detect navigation
    console.log(`[Warm Validate] URL after Add to chart: ${page.url()}`)

    // Wait for validation to complete, but keep this bounded for latency.
    await Promise.race([
      page.waitForNetworkIdle({ idleTime: 400, timeout: 2000 }),
      delay(1200),
    ]).catch(() => {})

    console.log(`[Warm Validate] URL after delay: ${page.url()}`)

    // If page navigated (e.g. /pine/ "Add to chart" navigates to /chart/), wait for load
    if (page.url() !== startUrl) {
      console.log(`[Warm Validate] Page navigated! Waiting for load...`)
      await page.waitForSelector('.monaco-editor', { timeout: 12000 }).catch(() => {})
      await delay(600)
    }

    // Extract errors from console panel (with timeout to prevent hanging)
    console.log('[Warm Validate] Extracting errors from console panel...')
    const errors = await Promise.race([
      page.evaluate((selectors) => {
        const consolePanel = document.querySelector(selectors.consolePanel)
        if (!consolePanel) return []

        const errorLines = consolePanel.querySelectorAll(selectors.errorLine)
        const warningLines = consolePanel.querySelectorAll(selectors.warningLine)

        const parseConsoleLine = (element: Element, type: 'error' | 'warning') => {
          const text = element.textContent || ''
          const lineMatch = text.match(/line (\d+)/i)
          return {
            line: lineMatch ? parseInt(lineMatch[1], 10) : 0,
            message: text.trim(),
            type,
          }
        }

        return [
          ...Array.from(errorLines).map((el) => parseConsoleLine(el, 'error')),
          ...Array.from(warningLines).map((el) => parseConsoleLine(el, 'warning')),
        ]
      }, TV_SELECTORS.pineEditor),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('page.evaluate timeout after 15s')), 15000)),
    ]).catch((err) => {
      console.log(`[Warm Validate] Error extracting errors: ${err instanceof Error ? err.message : err}`)
      return [] as Array<{ line: number; message: string; type: 'error' | 'warning' }>
    })
    console.log(`[Warm Validate] Extracted ${errors.length} errors`)

    // Get raw console output
    const rawOutput = await Promise.race([
      page.evaluate((selector) => {
        const panel = document.querySelector(selector)
        return panel?.textContent || ''
      }, TV_SELECTORS.pineEditor.consolePanel),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 10000)),
    ])

    const validationResult: ValidationResult = {
      isValid: errors.filter((e) => e.type === 'error').length === 0,
      errors,
      rawOutput,
    }

    const validationTime = Date.now() - startTime
    console.log(`[Warm Validate] Validation complete in ${validationTime}ms: isValid=${validationResult.isValid}`)

    // If validation failed or no publish options, return just validation result
    if (!validationResult.isValid || !publishOptions) {
      return { validation: validationResult }
    }

    // === PUBLISH PHASE ===
    console.log('[Warm Validate] Validation passed, proceeding to publish...')
    const { title, description, visibility = 'public' } = publishOptions

    // Wait for page to settle after Add to chart (chart page JS is very heavy)
    console.log('[Warm Validate] Waiting briefly for page settle before publish...')
    await Promise.race([
      page.waitForNetworkIdle({ idleTime: 500, timeout: 4000 }),
      delay(1500),
    ]).catch(() => {})

    // Dismiss any blocking dialogs by clicking their close buttons (NOT Escape, which closes Pine Editor)
    // IMPORTANT: Skip any dialog that contains .monaco-editor (that's the Pine Editor panel)
    console.log('[Warm Validate] Dismissing any blocking dialogs...')
    const hasPotentialDialog = await page
      .waitForSelector('[data-dialog-name], [role="dialog"]', { timeout: 1500 })
      .then(() => true)
      .catch(() => false)

    const dismissedDialogs = hasPotentialDialog
      ? await timedEvaluate<string[]>(
          page,
          () => {
            const dismissed: string[] = []
            const closeSelectors = [
              '[data-name="close-dialog"]',
              'button[aria-label="Close"]',
              'button[aria-label="close"]',
            ]
            const dialogs = document.querySelectorAll('[data-dialog-name], [role="dialog"], [class*="dialog"][class*="popup"], [class*="dialog"][class*="modal"]')
            for (const dialog of Array.from(dialogs)) {
              const rect = (dialog as HTMLElement).getBoundingClientRect()
              if (rect.width === 0 || rect.height === 0) continue
              if (dialog.querySelector('.monaco-editor')) continue
              for (const sel of closeSelectors) {
                const closeBtn = dialog.querySelector(sel) as HTMLElement | null
                if (closeBtn && closeBtn.getBoundingClientRect().width > 0) {
                  closeBtn.click()
                  dismissed.push(`${sel} in ${(dialog as HTMLElement).className?.toString().slice(0, 50)}`)
                  break
                }
              }
            }
            return dismissed
          },
          undefined,
          3000,
          [],
        ).catch(() => [])
      : []
    if (dismissedDialogs.length > 0) {
      console.log(`[Warm Validate] Dismissed ${dismissedDialogs.length} dialogs:`, dismissedDialogs)
      await delay(1000)
    } else {
      console.log('[Warm Validate] No blocking dialogs found')
    }

    // Click publish button with strict selector allowlist.
    console.log('[Warm Validate] Looking for publish button...')
    let publishClicked = await clickPublishButtonInChart(page, 'Warm Validate', { chartContextVerified: true })
    if (publishClicked) {
      console.log(`[Warm Validate] Clicked publish button: ${publishClicked}`)

      // Handle "Script is not on the chart" dialog - click its "Add to chart" button
      await delay(1500)
      const notOnChartHandled = await timedEvaluate<string | null>(
        page,
        () => {
        // Look for the "Script is not on the chart" dialog
          const allText = Array.from(document.querySelectorAll('div, span, p'))
          const notOnChart = allText.find(el => el.textContent?.includes('Script is not on the chart'))
          if (notOnChart) {
            // Find and click "Add to chart" button in the same dialog
            const buttons = Array.from(document.querySelectorAll('button'))
            const addBtn = buttons.find(b => b.textContent?.trim() === 'Add to chart')
            if (addBtn) {
              addBtn.click()
              return 'clicked-add-to-chart'
            }
            return 'dialog-found-no-button'
          }
          return null
        },
        undefined,
        3000,
        null,
      ).catch(() => null)
      if (notOnChartHandled) {
        console.log(`[Warm Validate] "Script not on chart" dialog: ${notOnChartHandled}`)
        if (notOnChartHandled === 'clicked-add-to-chart') {
          // Wait briefly for chart update, then re-click publish.
          await Promise.race([
            page.waitForNetworkIdle({ idleTime: 400, timeout: 2500 }),
            delay(700),
          ]).catch(() => {})
          console.log('[Warm Validate] Re-clicking publish button after adding to chart...')
          publishClicked = await clickPublishButtonInChart(page, 'Warm Validate', { chartContextVerified: true })
          if (publishClicked) {
            console.log(`[Warm Validate] Re-clicked publish: ${publishClicked}`)
            // Handle the "not on chart" dialog again if it reappears.
            await delay(400)
          }
        }
      }
    }

    if (!publishClicked) {
      // Debug: search for ANY element with "publish" anywhere
      const debugInfo = await timedEvaluate(
        page,
        () => {
        const monacoVisible = !!document.querySelector('.monaco-editor')
        // Search ALL elements for "publish" in text, attributes, class, data-name
        const allEls = Array.from(document.querySelectorAll('*'))
        const publishRelated = allEls
          .filter(el => {
            const text = el.textContent?.toLowerCase() || ''
            const className = el.className?.toString?.()?.toLowerCase() || ''
            const dataName = (el as HTMLElement).dataset?.name?.toLowerCase() || ''
            const ariaLabel = el.getAttribute('aria-label')?.toLowerCase() || ''
            const title = el.getAttribute('title')?.toLowerCase() || ''
            return (text.includes('publish') || className.includes('publish') ||
                    dataName.includes('publish') || ariaLabel.includes('publish') || title.includes('publish'))
          })
          .filter(el => (el as HTMLElement).getBoundingClientRect().width > 0)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            text: el.textContent?.trim().slice(0, 80),
            class: el.className?.toString?.().slice(0, 80),
            dataName: (el as HTMLElement).dataset?.name,
            ariaLabel: el.getAttribute('aria-label'),
            title: el.getAttribute('title'),
            rect: {
              w: Math.round((el as HTMLElement).getBoundingClientRect().width),
              h: Math.round((el as HTMLElement).getBoundingClientRect().height),
            },
            childCount: el.children.length,
          }))
        // Also get Pine Editor toolbar buttons specifically
        const pineEditorPanel = document.querySelector('.monaco-editor')?.closest('[class*="panel"]') ||
                                document.querySelector('.monaco-editor')?.parentElement?.parentElement?.parentElement
        const pineToolbarBtns = pineEditorPanel
          ? Array.from(pineEditorPanel.querySelectorAll('button, [role="button"]'))
              .filter(el => (el as HTMLElement).getBoundingClientRect().width > 0)
              .map(el => ({
                text: el.textContent?.trim().slice(0, 50),
                dataName: (el as HTMLElement).dataset?.name,
                ariaLabel: el.getAttribute('aria-label'),
                title: el.getAttribute('title'),
              }))
          : []
          return { monacoVisible, publishRelated: publishRelated.slice(0, 15), pineToolbarBtns: pineToolbarBtns.slice(0, 30) }
        },
        undefined,
        5000,
        { monacoVisible: false, publishRelated: [], pineToolbarBtns: [] as any[] },
      ).catch(() => ({ monacoVisible: false, publishRelated: [], pineToolbarBtns: [] }))
      console.log('[Warm Validate] Publish button not found. Debug:', JSON.stringify(debugInfo, null, 2))
      await page.screenshot({ path: `${SCREENSHOT_DIR}/warm-publish-no-button.png` }).catch(() => {})
      return {
        validation: validationResult,
        publish: { success: false, error: 'Publish button not found' },
      }
    }

    // Wait for publish dialog - check if a dropdown menu appeared first.
    console.log('[Warm Validate] Waiting for publish dialog or dropdown menu...')
    await Promise.race([
      page.waitForSelector('[data-dialog-name="publish-script"]', { timeout: 2500 }),
      page.waitForSelector('[role="menuitem"]', { timeout: 2500 }),
      delay(600),
    ]).catch(() => {})

    // Check if a dropdown/menu appeared (TradingView sometimes has a menu before dialog)
    let hasDropdownMenu = false
    try {
      const menuItems = await Promise.race([
        page.$$('[role="menuitem"]'),
        new Promise<never[]>((r) => setTimeout(() => r([]), 5000)),
      ])
      if (menuItems.length > 0) {
        // Click first menu item containing "publish"
        for (const item of menuItems) {
          try {
            const text = await item.evaluate(el => el.textContent?.toLowerCase() || '')
            if (text.includes('publish')) {
              await item.click()
              hasDropdownMenu = true
              break
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* no menu */ }
    if (hasDropdownMenu) {
      console.log('[Warm Validate] Clicked "Publish" in dropdown menu, waiting for dialog...')
      await Promise.race([
        page.waitForSelector('[data-dialog-name="publish-script"]', { timeout: 2500 }),
        delay(700),
      ]).catch(() => {})
    } else {
      console.log('[Warm Validate] No dropdown menu detected, dialog should be open')
      await delay(250)
    }

    // Check again for "Script is not on the chart" dialog - it may have appeared during the wait
    const notOnChartRetry = await timedEvaluate<string | null>(
      page,
      () => {
        const allText = Array.from(document.querySelectorAll('div, span, p'))
        const notOnChart = allText.find(el => el.textContent?.includes('Script is not on the chart'))
        if (notOnChart) {
          const buttons = Array.from(document.querySelectorAll('button'))
          const addBtn = buttons.find(b => b.textContent?.trim() === 'Add to chart')
          if (addBtn) {
            addBtn.click()
            return 'clicked-add-to-chart'
          }
          return 'dialog-found-no-button'
        }
        return null
      },
      undefined,
      3000,
      null,
    ).catch(() => null)
    if (notOnChartRetry) {
      console.log(`[Warm Validate] "Script not on chart" dialog (retry): ${notOnChartRetry}`)
      if (notOnChartRetry === 'clicked-add-to-chart') {
        // Wait for script to be added to chart, then re-click publish
        console.log('[Warm Validate] Waiting for script to be added to chart...')
        await Promise.race([
          page.waitForNetworkIdle({ idleTime: 400, timeout: 2500 }),
          delay(700),
        ]).catch(() => {})

        // Re-click the publish button
        console.log('[Warm Validate] Re-clicking publish button after adding to chart...')
        const rePublishClicked = await clickPublishButtonInChart(page, 'Warm Validate', { chartContextVerified: true })
        if (rePublishClicked) {
          console.log(`[Warm Validate] Re-clicked publish: ${rePublishClicked}`)
          await Promise.race([
            page.waitForSelector('[data-dialog-name="publish-script"]', { timeout: 2500 }),
            delay(700),
          ]).catch(() => {})
        } else {
          console.log('[Warm Validate] Failed to re-click publish button')
        }
      }
    }

    // === STEP 1: Fill title and description (broken into small steps with timeouts) ===
    console.log('[Warm Validate] Step 1: Filling title and description...')
    const { visibilityLevel } = publishOptions
    const descriptionText = description || title
    const fillResult: string[] = []

    // Helper for running page.evaluate with timeout
    const evalWithTimeout = async <T>(fn: () => Promise<T>, timeoutMs: number, fallback: T): Promise<T> => {
      try {
        return await Promise.race([
          fn(),
          new Promise<T>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs)),
        ])
      } catch (e) {
        return fallback
      }
    }

    // Step 1a: Wait for the publish dialog container to appear
    console.log('[Warm Validate] Waiting for publish dialog container...')
    const dialogContainer = await page.waitForSelector(
      '[data-dialog-name="publish-script"]',
      { visible: true, timeout: 8000 }
    ).catch(() => null)

    if (!dialogContainer) {
      console.log('[Warm Validate] Publish dialog did not appear — bailing out')
      await page.screenshot({ path: `${SCREENSHOT_DIR}/dialog-not-appeared.png` }).catch(() => {})
      return {
        validation: validationResult,
        publish: {
          success: false,
          errorCode: 'PUBLISH_DIALOG_NOT_FOUND',
          error: 'Publish dialog did not appear after clicking publish button',
        },
      }
    }
    console.log('[Warm Validate] Publish dialog container found')

    // Step 1b: Wait for dialog form inputs to load within the dialog
    console.log('[Warm Validate] Waiting for publish dialog form inputs...')
    const dialogReady = await evalWithTimeout(async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const ready = await page.evaluate(() => {
          const dialog = document.querySelector('[data-dialog-name="publish-script"]')
          if (!dialog) return false
          const inputs = Array.from(dialog.querySelectorAll('input'))
            .filter(el => el.getBoundingClientRect().width > 100)
          return inputs.length > 0
        })
        if (ready) {
          console.log(`[Warm Validate] Dialog form ready after ${attempt + 1} attempts`)
          return true
        }
        await delay(250)
      }
      return false
    }, 4000, false)

    if (!dialogReady) {
      console.log('[Warm Validate] Dialog form not ready - taking screenshot')
      await page.screenshot({ path: `${SCREENSHOT_DIR}/dialog-not-ready.png` }).catch(() => {})
      fillResult.push('dialog:NOT_READY')
    } else {
      fillResult.push('dialog:READY')
    }

    // Step 1c: Fill title (5 second timeout) — scoped to dialog
    console.log('[Warm Validate] Filling title...')
    const titleFilled = await evalWithTimeout(async () => {
      return await page.evaluate((titleText: string) => {
        const dialog = document.querySelector('[data-dialog-name="publish-script"]')
        if (!dialog) return null
        const selectors = [
          'input[placeholder="Title"]',
          'input[value="My script"]',
          'input[placeholder="My script"]',
          'input[class*="title"]',
        ]
        for (const sel of selectors) {
          const input = dialog.querySelector(sel) as HTMLInputElement
          if (input && input.getBoundingClientRect().width > 100) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            if (setter) setter.call(input, titleText)
            else input.value = titleText
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
            return sel
          }
        }
        // Fallback: try any visible input within dialog
        const inputs = Array.from(dialog.querySelectorAll('input'))
          .filter(el => el.getBoundingClientRect().width > 100) as HTMLInputElement[]
        if (inputs.length > 0) {
          const input = inputs[0]
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          if (setter) setter.call(input, titleText)
          else input.value = titleText
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
          return 'input[0]'
        }
        return null
      }, title)
    }, 5000, null)
    fillResult.push(titleFilled ? `title:${titleFilled}` : 'title:FAILED')

    // Step 1d: Fill description (5 second timeout) — scoped to dialog
    console.log('[Warm Validate] Filling description...')
    const descFilled = await evalWithTimeout(async () => {
      return await page.evaluate((descText: string) => {
        const dialog = document.querySelector('[data-dialog-name="publish-script"]')
        if (!dialog) return null
        // Try contenteditable first
        const editables = Array.from(dialog.querySelectorAll('[contenteditable="true"]'))
          .filter(el => el.getBoundingClientRect().height > 20 && el.getBoundingClientRect().width > 100) as HTMLElement[]
        if (editables.length > 0) {
          const el = editables[0]
          el.focus()
          el.innerText = descText
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return 'contenteditable'
        }
        // Try textarea
        const textareas = Array.from(dialog.querySelectorAll('textarea'))
          .filter(el => el.getBoundingClientRect().width > 100) as HTMLTextAreaElement[]
        if (textareas.length > 0) {
          const ta = textareas[0]
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
          if (setter) setter.call(ta, descText)
          else ta.value = descText
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          return 'textarea'
        }
        return null
      }, descriptionText)
    }, 5000, null)
    fillResult.push(descFilled ? `desc:${descFilled}` : 'desc:FAILED')

    // Step 1e: Click Continue button (5 second timeout) — scoped to dialog
    console.log('[Warm Validate] Looking for Continue button...')
    const continueClicked = await evalWithTimeout(async () => {
      return await page.evaluate(() => {
        const dialog = document.querySelector('[data-dialog-name="publish-script"]')
        if (!dialog) return false
        const buttons = Array.from(dialog.querySelectorAll('button'))
        const continueBtn = buttons.find(b => {
          const text = b.textContent?.toLowerCase() || ''
          return text.includes('continue') || text.includes('next')
        })
        if (continueBtn) {
          continueBtn.click()
          return true
        }
        return false
      })
    }, 5000, false)
    fillResult.push(continueClicked ? 'continue:OK' : 'continue:FAILED')

    // Wait for page transition after Continue
    if (continueClicked) {
      await Promise.race([
        page.waitForSelector('button, [role="button"]', { timeout: 1500 }),
        delay(500),
      ]).catch(() => {})
    }

    // Step 1f: Click Public/Private (5 second timeout) — scoped to dialog
    console.log(`[Warm Validate] Setting visibility to: ${visibility}...`)
    const privacySet = await evalWithTimeout(async () => {
      return await page.evaluate((privacy: string) => {
        const dialog = document.querySelector('[data-dialog-name="publish-script"]')
        if (!dialog) return false
        const elements = Array.from(dialog.querySelectorAll('button, [role="button"], [role="tab"], label, [role="radio"]'))
        const privacyBtn = elements.find(b => b.textContent?.toLowerCase().trim() === privacy)
        if (privacyBtn) {
          (privacyBtn as HTMLElement).click()
          return true
        }
        return false
      }, visibility)
    }, 5000, false)
    fillResult.push(privacySet ? `privacy:${visibility}` : 'privacy:FAILED')

    console.log(`[Warm Validate] Dialog fill result: ${JSON.stringify(fillResult)}`)

    // Check if all fills failed — retry once with a longer delay
    const allFailed = fillResult.every(r => r.includes('FAILED') || r.includes('NOT_READY'))
    if (allFailed) {
      console.log('[Warm Validate] All dialog fills failed — retrying after 3s delay...')
      await delay(3000)

      // Re-check dialog is still present
      const retryDialog = await page.evaluate(() => {
        const d = document.querySelector('[data-dialog-name="publish-script"]')
        if (!d) return null
        const inputs = Array.from(d.querySelectorAll('input'))
          .filter(el => el.getBoundingClientRect().width > 100)
        return { hasInputs: inputs.length > 0 }
      })
      if (!retryDialog?.hasInputs) {
        console.log('[Warm Validate] Dialog not ready on retry — bailing out')
        await page.screenshot({ path: `${SCREENSHOT_DIR}/dialog-retry-failed.png` }).catch(() => {})
        return {
          validation: validationResult,
          publish: {
            success: false,
            errorCode: 'DIALOG_FILL_FAILED',
            error: 'Publish dialog form could not be filled after retry',
          },
        }
      }

      // Retry title fill
      const retryTitle = await evalWithTimeout(async () => {
        return await page.evaluate((titleText: string) => {
          const dialog = document.querySelector('[data-dialog-name="publish-script"]')
          if (!dialog) return null
          const inputs = Array.from(dialog.querySelectorAll('input'))
            .filter(el => el.getBoundingClientRect().width > 100) as HTMLInputElement[]
          if (inputs.length > 0) {
            const input = inputs[0]
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            if (setter) setter.call(input, titleText)
            else input.value = titleText
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
            return 'retry:input[0]'
          }
          return null
        }, title)
      }, 5000, null)

      // Retry description fill
      const retryDesc = await evalWithTimeout(async () => {
        return await page.evaluate((descText: string) => {
          const dialog = document.querySelector('[data-dialog-name="publish-script"]')
          if (!dialog) return null
          const editables = Array.from(dialog.querySelectorAll('[contenteditable="true"]'))
            .filter(el => el.getBoundingClientRect().height > 20 && el.getBoundingClientRect().width > 100) as HTMLElement[]
          if (editables.length > 0) {
            const el = editables[0]
            el.focus()
            el.innerText = descText
            el.dispatchEvent(new Event('input', { bubbles: true }))
            return 'retry:contenteditable'
          }
          return null
        }, descriptionText)
      }, 5000, null)

      // Retry continue button
      const retryContinue = await evalWithTimeout(async () => {
        return await page.evaluate(() => {
          const dialog = document.querySelector('[data-dialog-name="publish-script"]')
          if (!dialog) return false
          const buttons = Array.from(dialog.querySelectorAll('button'))
          const continueBtn = buttons.find(b => {
            const text = b.textContent?.toLowerCase() || ''
            return text.includes('continue') || text.includes('next')
          })
          if (continueBtn) {
            continueBtn.click()
            return true
          }
          return false
        })
      }, 5000, false)

      if (retryContinue) {
        await Promise.race([
          page.waitForSelector('button, [role="button"]', { timeout: 1500 }),
          delay(500),
        ]).catch(() => {})
      }

      // Retry privacy
      const retryPrivacy = await evalWithTimeout(async () => {
        return await page.evaluate((privacy: string) => {
          const dialog = document.querySelector('[data-dialog-name="publish-script"]')
          if (!dialog) return false
          const elements = Array.from(dialog.querySelectorAll('button, [role="button"], [role="tab"], label, [role="radio"]'))
          const privacyBtn = elements.find(b => b.textContent?.toLowerCase().trim() === privacy)
          if (privacyBtn) {
            (privacyBtn as HTMLElement).click()
            return true
          }
          return false
        }, visibility)
      }, 5000, false)

      const retryResult = [
        retryTitle ? `title:${retryTitle}` : 'title:FAILED',
        retryDesc ? `desc:${retryDesc}` : 'desc:FAILED',
        retryContinue ? 'continue:OK' : 'continue:FAILED',
        retryPrivacy ? `privacy:${visibility}` : 'privacy:FAILED',
      ]
      console.log(`[Warm Validate] Retry fill result: ${JSON.stringify(retryResult)}`)

      const retryAllFailed = retryResult.every(r => r.includes('FAILED'))
      if (retryAllFailed) {
        console.log('[Warm Validate] Retry also failed — bailing out')
        await page.screenshot({ path: `${SCREENSHOT_DIR}/dialog-fill-retry-failed.png` }).catch(() => {})
        return {
          validation: validationResult,
          publish: {
            success: false,
            errorCode: 'DIALOG_FILL_FAILED',
            error: `Publish dialog form fill failed after retry: ${JSON.stringify(retryResult)}`,
          },
        }
      }
    }

    // Click final publish button (Step 2)
    const submitted = await clickFinalPublishButton(page, visibility)
    if (!submitted) {
      return {
        validation: validationResult,
        publish: {
          success: false,
          errorCode: 'PUBLISH_ACTION_FAILED',
          error: 'Could not find final publish button in step 2',
        },
      }
    }

    const captured = await capturePublishedScriptUrl(page, {
      logTag: 'Warm Validate',
      title,
      captureWindowMs: URL_CAPTURE_WINDOW_MS,
    })

    if (captured.url) {
      const totalTime = Date.now() - startTime
      console.log(`[Warm Validate] Published successfully in ${totalTime}ms via ${captured.source}: ${captured.url}`)
      return {
        validation: validationResult,
        publish: {
          success: true,
          indicatorUrl: captured.url,
          captureSource: captured.source,
        },
      }
    }

    const totalTime = Date.now() - startTime
    console.log(`[Warm Validate] Publish completed in ${totalTime}ms (URL not captured in ${URL_CAPTURE_WINDOW_MS}ms)`)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/warm-publish-no-url.png` }).catch(() => {})
    return {
      validation: validationResult,
      publish: {
        success: false,
        errorCode: 'URL_CAPTURE_FAILED_AFTER_PUBLISH',
        publishedButUrlUnknown: true,
        error: `Publish likely succeeded, but script URL could not be captured within ${Math.round(URL_CAPTURE_WINDOW_MS / 1000)} seconds. Check TradingView profile and retry.`,
      },
    }
  } catch (error) {
    console.error('[Warm Validate] Error:', error)
    return {
      validation: {
        isValid: false,
        errors: [
          {
            line: 0,
            message: `Warm session validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            type: 'error',
          },
        ],
        rawOutput: '',
      },
    }
  }
}
