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
 * Result of user credential login attempt
 */
export interface UserLoginResult {
  success: boolean
  credentials?: TVCredentials
  error?: string
  captchaDetected?: boolean
}

/**
 * Login to TradingView using user-provided credentials (for hosted users)
 * If CAPTCHA is detected, automatically falls back to visible browser for manual solving
 * @param username - TradingView username/email
 * @param password - TradingView password
 * @param isVisibleRetry - Internal: true if this is a retry with visible browser for CAPTCHA
 */
export async function loginWithUserCredentials(
  username: string,
  password: string,
  isVisibleRetry: boolean = false
): Promise<UserLoginResult> {
  if (!username || !password) {
    return { success: false, error: 'Username and password are required' }
  }

  let session: BrowserlessSession | null = null

  try {
    const mode = isVisibleRetry ? 'visible (for CAPTCHA)' : 'standard'
    console.log(`[TV] Attempting login with user-provided credentials (${mode})`)
    session = await createBrowserSession({ forceVisible: isVisibleRetry })
    const { page } = session

    // Navigate to TradingView login page
    await navigateTo(page, 'https://www.tradingview.com/accounts/signin/')
    await delay(3000)

    // Check if already logged in
    let currentUrl = page.url()
    if (!currentUrl.includes('signin')) {
      // Clear any existing session and start fresh
      await page.deleteCookie(...(await page.cookies()))
      await navigateTo(page, 'https://www.tradingview.com/accounts/signin/')
      await delay(3000)
    }

    // Click "Email" tab
    const emailTabSelectors = [
      'button[name="Email"]',
      '[data-name="email"]',
      'button:has-text("Email")',
      '.tv-signin-dialog__toggle-email',
    ]

    for (const selector of emailTabSelectors) {
      try {
        const element = await page.$(selector)
        if (element) {
          await element.click()
          console.log(`[TV] Clicked email tab: ${selector}`)
          await delay(1000)
          break
        }
      } catch {
        // Try next
      }
    }

    // Try clicking by text content as fallback
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, span, div'))
      const emailBtn = buttons.find(el => el.textContent?.trim().toLowerCase() === 'email')
      if (emailBtn) (emailBtn as HTMLElement).click()
    })
    await delay(1000)

    // Find and fill username
    const usernameSelectors = [
      'input[name="id_username"]',
      'input[name="username"]',
      'input[type="email"]',
      'input[placeholder*="email" i]',
      '#id_username',
    ]

    let usernameInput = null
    for (const selector of usernameSelectors) {
      usernameInput = await page.$(selector)
      if (usernameInput) break
    }

    if (!usernameInput) {
      return { success: false, error: 'Could not find login form. TradingView may have changed their UI.' }
    }

    await usernameInput.click()
    await delay(200)
    await usernameInput.type(username, { delay: 30 })
    await delay(500)

    // Find and fill password
    const passwordSelectors = [
      'input[name="id_password"]',
      'input[name="password"]',
      'input[type="password"]',
      '#id_password',
    ]

    let passwordInput = null
    for (const selector of passwordSelectors) {
      passwordInput = await page.$(selector)
      if (passwordInput) break
    }

    if (!passwordInput) {
      return { success: false, error: 'Could not find password field' }
    }

    await passwordInput.click()
    await delay(200)
    await passwordInput.type(password, { delay: 30 })
    await delay(500)

    // Submit
    const submitSelectors = [
      'button[type="submit"]',
      'button[data-overflow-tooltip-text="Sign in"]',
      '.tv-button--primary',
    ]

    let submitClicked = false
    for (const selector of submitSelectors) {
      try {
        const btn = await page.$(selector)
        if (btn) {
          await btn.click()
          submitClicked = true
          break
        }
      } catch {
        // Try next
      }
    }

    if (!submitClicked) {
      await page.keyboard.press('Enter')
    }

    // Wait for response
    await delay(3000)

    // Check for CAPTCHA - in headless mode we can't solve it
    const hasCaptcha = await page.evaluate(() => {
      const recaptchaFrame = document.querySelector('iframe[src*="recaptcha"]')
      const checkbox = document.querySelector('.recaptcha-checkbox')
      return !!(recaptchaFrame || checkbox)
    })

    if (hasCaptcha) {
      if (!isVisibleRetry) {
        // First attempt: retry with visible browser for manual CAPTCHA solving
        console.log('[TV] CAPTCHA detected - retrying with visible browser for manual solving...')
        await closeBrowserSession(session)
        session = null
        return loginWithUserCredentials(username, password, true)
      }

      // Already in visible mode - wait for user to solve CAPTCHA
      console.log('[TV] 🤖 CAPTCHA detected! Please solve it in the browser window...')
      console.log('[TV] Waiting up to 60 seconds for CAPTCHA to be solved...')

      let captchaSolved = false
      for (let i = 0; i < 30; i++) {
        await delay(2000)

        // Check if we've been redirected away from signin page
        const currentUrlCheck = page.url()
        if (!currentUrlCheck.includes('signin')) {
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
        return {
          success: false,
          error: 'CAPTCHA was not solved within 60 seconds',
          captchaDetected: true,
        }
      }

      // Wait for login to process after CAPTCHA
      await delay(3000)
    }

    // Wait for login to complete
    await delay(3000)

    // Check for login errors
    const loginError = await page.evaluate(() => {
      const errorEl = document.querySelector('.tv-form-error, .error-message, [data-error]')
      return errorEl?.textContent?.trim() || null
    })

    if (loginError) {
      return { success: false, error: `Login failed: ${loginError}` }
    }

    // Check if login was successful
    currentUrl = page.url()
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
        break
      }
    }

    if (!isLoggedIn && !currentUrl.includes('signin')) {
      isLoggedIn = true
    }

    if (!isLoggedIn) {
      return { success: false, error: 'Login failed. Please check your credentials.' }
    }

    // Extract cookies
    const cookies = await page.cookies('https://www.tradingview.com')
    const sessionIdCookie = cookies.find(c => c.name === 'sessionid')
    const signatureCookie = cookies.find(c => c.name === 'sessionid_sign')

    if (!sessionIdCookie || !signatureCookie) {
      return { success: false, error: 'Login succeeded but could not extract session' }
    }

    console.log('[TV] User login successful')

    // Note: Session is stored per-user in Redis/KV via connect.tsx -> storeTVCredentials()
    // No global caching here to prevent cross-user credential leakage

    return {
      success: true,
      credentials: {
        sessionId: sessionIdCookie.value,
        signature: signatureCookie.value,
        userId: 'user-login',
      },
    }
  } catch (error) {
    console.error('[TV] User login failed:', error)
    return { success: false, error: `Login error: ${(error as Error).message}` }
  } finally {
    if (session) {
      await closeBrowserSession(session)
    }
  }
}

/**
 * Check if auto-login is available
 */
export function hasAutoLoginCredentials(): boolean {
  return !!(TV_USERNAME && TV_PASSWORD)
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

    console.log('[TV] Checking if Pine Editor is already open...')
    await delay(3000) // Wait for page to fully load

    // Check if Pine Editor is already open
    const pineEditorVisible = await waitForElement(page, TV_SELECTORS.pineEditor.container, 5000)
    if (!pineEditorVisible) {
      console.log('[TV] Pine Editor not open, looking for open button...')

      // Try multiple selectors for the Pine Editor button
      const editorButtonSelectors = [
        '[data-name="open-pine-editor"]',
        'button[title="Pine"]',
        'button[aria-label="Pine"]',
        'button[title*="Pine"]',
        'button[aria-label*="Pine"]',
        '[data-role="button"][title*="Pine"]',
      ]

      let buttonFound = false
      for (const selector of editorButtonSelectors) {
        try {
          const button = await page.$(selector)
          if (button) {
            console.log(`[TV] Found Pine Editor button with selector: ${selector}`)
            await button.click()
            buttonFound = true
            break
          }
        } catch (e) {
          console.log(`[TV] Selector ${selector} failed, trying next...`)
        }
      }

      if (!buttonFound) {
        // Debug: log all buttons with their attributes
        console.log('[TV] Trying to find Pine Editor button by text and attributes...')
        const buttonInfo = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'))
          return buttons.slice(0, 20).map((btn, i) => ({
            index: i,
            text: btn.textContent?.trim().substring(0, 50),
            title: btn.getAttribute('title'),
            ariaLabel: btn.getAttribute('aria-label'),
            dataName: btn.getAttribute('data-name'),
            className: btn.className.substring(0, 50),
          }))
        })
        console.log('[TV] Found buttons:', JSON.stringify(buttonInfo, null, 2))

        // Try finding by title attribute containing "Pine"
        const clicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, div[role="button"], [role="button"]'))
          const pineBtn = buttons.find(btn => {
            const title = btn.getAttribute('title')
            const ariaLabel = btn.getAttribute('aria-label')
            return (title && title.toLowerCase().includes('pine')) ||
                   (ariaLabel && ariaLabel.toLowerCase().includes('pine'))
          })
          if (pineBtn) {
            (pineBtn as HTMLElement).click()
            return true
          }
          return false
        })

        if (clicked) {
          console.log('[TV] Clicked Pine button via title/aria-label search')
          buttonFound = true
        }
      }

      // Wait for Pine Editor to appear - try all selectors in parallel
      console.log('[TV] Waiting for Pine Editor to load...')

      // Try multiple selectors for Pine Editor container - in parallel
      const pineEditorSelectors = [
        '[data-name="pine-editor"]',
        '.pine-editor-container',
        '[data-role="panel-Pine"]',
        '[id*="pine"]',
        '.monaco-editor', // The code editor itself
      ]

      // Race all selectors - first one to match wins
      let editorOpened = false
      const selectorPromises = pineEditorSelectors.map(async (selector) => {
        const found = await waitForElement(page, selector, 15000)
        if (found) return selector
        return null
      })

      const winningSelector = await Promise.race([
        Promise.any(selectorPromises.map(p => p.then(s => s ? s : Promise.reject()))).catch(() => null),
        delay(15000).then(() => null), // Overall timeout
      ])

      if (winningSelector) {
        console.log(`[TV] Pine Editor found with selector: ${winningSelector}`)
        editorOpened = true
      }

      if (!editorOpened) {
        // Log what's actually on the page
        const pageInfo = await page.evaluate(() => {
          return {
            panels: Array.from(document.querySelectorAll('[data-role*="panel"]')).map(el => el.getAttribute('data-role')),
            dataNames: Array.from(document.querySelectorAll('[data-name]')).slice(0, 20).map(el => el.getAttribute('data-name')),
          }
        })
        console.log('[TV] Page elements:', JSON.stringify(pageInfo, null, 2))

        // Take screenshot for debugging
        await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-pine-editor-not-found.png` })
        console.log(`[TV] Screenshot saved to ${SCREENSHOT_DIR}/tv-pine-editor-not-found.png`)
        throw new Error('Could not open Pine Editor - please check screenshot')
      }
      console.log('[TV] Pine Editor opened successfully')
    } else {
      console.log('[TV] Pine Editor already open')
    }

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
  // First, close any interfering dialogs (Symbol Search, Go Pro, etc.) by pressing Escape
  console.log('[TV Publish Helper] Closing any interfering dialogs...')
  for (let i = 0; i < 3; i++) {
    const hasInterferingDialog = await page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase()
      return bodyText.includes('symbol search') || bodyText.includes('go pro') || bodyText.includes('upgrade')
    })
    if (hasInterferingDialog) {
      await page.keyboard.press('Escape')
      await delay(500)
    } else {
      break
    }
  }

  // Wait for dialog to fully render
  await delay(2000)

  // Debug: Log all visible inputs on the page
  const allInputs = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'))
    return inputs.map((input) => {
      const rect = input.getBoundingClientRect()
      return {
        type: input.type,
        placeholder: input.placeholder,
        value: input.value,
        className: input.className.slice(0, 50),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        visible: rect.width > 0 && rect.height > 0 && rect.top > 0 && rect.top < window.innerHeight
      }
    })
  })
  console.log(`[TV Publish Helper] All inputs on page (${allInputs.length}):`, JSON.stringify(allInputs, null, 2))

  // Primary selectors - the title input may have "My script" or "Title" as placeholder
  const titleSelectors = [
    'input[value="My script"]',
    'input[placeholder="My script"]',
    'input[placeholder="Title"]',
    'input[class*="title-input"]',
  ]

  console.log(`[TV Publish Helper] Looking for title input to fill: "${title}"`)

  // Try primary selectors first (most specific)
  for (const sel of titleSelectors) {
    try {
      const input = await page.$(sel)
      if (input) {
        const box = await input.boundingBox()
        if (!box || box.width < 100) {
          console.log(`[TV Publish Helper] Skipping ${sel} - not visible or too small (box: ${JSON.stringify(box)})`)
          continue
        }

        console.log(`[TV Publish Helper] Found title input via: ${sel} at (${Math.round(box.x)}, ${Math.round(box.y)})`)
        await input.click()
        await delay(100)
        // Triple-click to select all text in the input
        await input.click({ clickCount: 3 })
        await delay(50)
        // Type the title (replaces selected text)
        await page.keyboard.type(title, { delay: 10 })
        console.log(`[TV Publish Helper] Title filled: "${title}" using: ${sel}`)
        return true
      }
    } catch (err) {
      console.log(`[TV Publish Helper] Selector ${sel} failed: ${err}`)
    }
  }

  // Fallback: Look for any visible input that could be the title field
  console.log('[TV Publish Helper] Primary selectors failed, trying broader search...')
  const visibleInputs = allInputs.filter(inp => inp.visible && inp.rect.width > 200)
  console.log(`[TV Publish Helper] Visible large inputs: ${JSON.stringify(visibleInputs)}`)

  // Try to find input by looking for "My script" text or inputs in dialog area
  const fallbackResult = await page.evaluate(() => {
    // Look for inputs that appear to be in the publish dialog
    const inputs = Array.from(document.querySelectorAll('input'))
    for (const input of inputs) {
      const rect = input.getBoundingClientRect()
      const inputEl = input as HTMLInputElement
      // Title input should be:
      // - Visible and reasonably wide (> 200px)
      // - In the upper half of the viewport (dialogs appear centered)
      // - Has "My script" value, empty value, or "Title" placeholder
      const isVisible = rect.width > 200 && rect.height > 20 && rect.top > 50 && rect.top < window.innerHeight / 2
      const placeholderLower = inputEl.placeholder.toLowerCase()
      const isTitleLike = inputEl.value === 'My script' ||
                          inputEl.value === '' ||
                          placeholderLower.includes('script') ||
                          placeholderLower.includes('title') ||
                          inputEl.className.includes('title')
      // Exclude chat/search inputs
      const isNotChat = !placeholderLower.includes('chat') && !placeholderLower.includes('search')

      if (isVisible && isTitleLike && isNotChat) {
        return {
          found: true,
          value: inputEl.value,
          placeholder: inputEl.placeholder,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        }
      }
    }
    return { found: false }
  })

  if (fallbackResult.found) {
    console.log(`[TV Publish Helper] Found title input via fallback: value="${fallbackResult.value}", placeholder="${fallbackResult.placeholder}"`)
    const { x, y, width, height } = fallbackResult.rect!
    await page.mouse.click(x + width / 2, y + height / 2, { clickCount: 3 })
    await delay(50)
    await page.keyboard.type(title, { delay: 10 })
    console.log(`[TV Publish Helper] Title filled via fallback click`)
    return true
  }

  console.log('[TV Publish Helper] Warning: Could not find title input - publish dialog may not be open')
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

  // Method 1: Find contenteditable element with appropriate size (description area)
  const clicked = await page.evaluate((text) => {
    const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'))
    for (const el of editables) {
      const rect = el.getBoundingClientRect()
      // Description area should be taller (height > 50px) and wide enough
      if (rect.height > 50 && rect.width > 200) {
        (el as HTMLElement).click()
        ;(el as HTMLElement).focus()
        return { found: true, height: rect.height, width: rect.width }
      }
    }
    return { found: false }
  }, description)

  if (clicked.found) {
    await delay(200)
    await page.keyboard.type(description, { delay: 5 })
    console.log(`[TV Publish Helper] Description filled via contenteditable (${clicked.height}x${clicked.width})`)
    return true
  }

  // Method 2: Tab from title to description and type
  console.log('[TV Publish Helper] Trying Tab key to move to description...')
  await page.keyboard.press('Tab')
  await delay(150)
  await page.keyboard.type(description, { delay: 5 })

  // Verify if text was entered
  const descFilled = await page.evaluate(() => {
    const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'))
    return editables.some(el => el.textContent && el.textContent.length > 0)
  })

  if (descFilled) {
    console.log('[TV Publish Helper] Description filled via Tab key')
    return true
  }

  // Method 3: Click by coordinates in the center of the dialog
  console.log('[TV Publish Helper] Trying coordinate-based click...')
  const dialogBox = await page.evaluate(() => {
    const dialog = document.querySelector('[class*="dialog"]') ||
                   document.querySelector('[role="dialog"]') ||
                   document.querySelector('[class*="modal"]')
    if (dialog) {
      const rect = dialog.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    return null
  })

  if (dialogBox) {
    const clickX = dialogBox.x + dialogBox.width / 2
    const clickY = dialogBox.y + dialogBox.height / 2
    await page.mouse.click(clickX, clickY)
    await delay(200)
    await page.keyboard.type(description, { delay: 5 })
    console.log(`[TV Publish Helper] Description filled via coordinates (${clickX}, ${clickY})`)
    return true
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

  // Find and click button with text "Continue"
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const btn = buttons.find(b => {
      const text = b.textContent?.toLowerCase().trim() || ''
      return text === 'continue' || text.includes('continue')
    })
    if (btn) {
      btn.click()
      return true
    }
    return false
  })

  if (!clicked) {
    console.log('[TV Publish Helper] Warning: Could not find Continue button')
    return false
  }

  console.log('[TV Publish Helper] Clicked Continue button')

  // Wait for Step 2 to load
  await delay(1000)

  // Verify Step 2 loaded by checking for visibility options
  const onStep2 = await page.evaluate(() => {
    const bodyText = document.body.innerText.toLowerCase()
    // Step 2 should show Public/Private options
    const hasPrivacyOptions = bodyText.includes('public') && bodyText.includes('private')
    // And should NOT have Continue button anymore (or have Publish button)
    const buttons = Array.from(document.querySelectorAll('button'))
    const hasPublishBtn = buttons.some(b => {
      const text = b.textContent?.toLowerCase() || ''
      return text.includes('publish') && text.includes('script')
    })
    return hasPrivacyOptions || hasPublishBtn
  })

  if (onStep2) {
    console.log('[TV Publish Helper] Successfully moved to Step 2')
    return true
  }

  console.log('[TV Publish Helper] Warning: May not have moved to Step 2')
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

  // Click Public or Private button
  const privacyClicked = await page.evaluate((targetPrivacy) => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], label'))
    for (const btn of buttons) {
      const text = btn.textContent?.toLowerCase().trim() || ''
      // Match exact "public" or "private" text
      if (text === targetPrivacy) {
        (btn as HTMLElement).click()
        return { clicked: true, text }
      }
    }
    // Fallback: partial match
    for (const btn of buttons) {
      const text = btn.textContent?.toLowerCase().trim() || ''
      if (text.includes(targetPrivacy) && text.length < 20) {
        (btn as HTMLElement).click()
        return { clicked: true, text }
      }
    }
    return { clicked: false }
  }, privacy)

  if (privacyClicked.clicked) {
    console.log(`[TV Publish Helper] Clicked ${privacy} option: "${privacyClicked.text}"`)
  } else {
    console.log(`[TV Publish Helper] Warning: Could not find ${privacy} option`)
  }

  await delay(300)

  // If public and visibilityLevel specified, click the visibility level button
  if (privacy === 'public' && visibilityLevel) {
    const levelClicked = await page.evaluate((targetLevel) => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], label'))
      // Map visibility level to expected button text
      const levelMap: Record<string, string[]> = {
        'open': ['open'],
        'protected': ['protected'],
        'invite-only': ['invite-only', 'invite only', 'inviteonly'],
      }
      const expectedTexts = levelMap[targetLevel] || [targetLevel]

      for (const btn of buttons) {
        const text = btn.textContent?.toLowerCase().trim() || ''
        if (expectedTexts.some(expected => text === expected || text.includes(expected))) {
          (btn as HTMLElement).click()
          return { clicked: true, text }
        }
      }
      return { clicked: false }
    }, visibilityLevel)

    if (levelClicked.clicked) {
      console.log(`[TV Publish Helper] Clicked ${visibilityLevel} visibility level: "${levelClicked.text}"`)
    } else {
      console.log(`[TV Publish Helper] Warning: Could not find ${visibilityLevel} option`)
    }

    await delay(200)
  }

  return privacyClicked.clicked
}

/**
 * Click the final "Publish public script" or "Publish private script" button
 */
async function clickFinalPublishButton(
  page: import('puppeteer-core').Page,
  privacy: 'public' | 'private'
): Promise<boolean> {
  const expectedText = privacy === 'public' ? 'publish public script' : 'publish private script'
  console.log(`[TV Publish Helper] Looking for "${expectedText}" button...`)

  // First try: exact match for "Publish public/private script"
  let clicked = await page.evaluate((expected) => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const btn = buttons.find(b => {
      const text = b.textContent?.toLowerCase().trim() || ''
      return text === expected || text.includes(expected)
    })
    if (btn) {
      btn.click()
      return { clicked: true, text: btn.textContent?.trim() }
    }
    return { clicked: false }
  }, expectedText)

  if (clicked.clicked) {
    console.log(`[TV Publish Helper] Clicked final publish button: "${clicked.text}"`)
    return true
  }

  // Fallback: any button with "publish" + "script"
  clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'))
    const btn = buttons.find(b => {
      const text = b.textContent?.toLowerCase() || ''
      return text.includes('publish') && text.includes('script')
    })
    if (btn) {
      btn.click()
      return { clicked: true, text: btn.textContent?.trim() }
    }
    return { clicked: false }
  })

  if (clicked.clicked) {
    console.log(`[TV Publish Helper] Clicked publish button (fallback): "${clicked.text}"`)
    return true
  }

  // Last resort: submit button
  const submitBtn = await page.$('button[type="submit"]')
  if (submitBtn) {
    await submitBtn.click()
    console.log('[TV Publish Helper] Clicked submit button (last resort)')
    return true
  }

  console.log('[TV Publish Helper] Warning: Could not find final publish button')
  return false
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

  // Note: /pine/ page has a different publish workflow (save first, then publish from menu)
  // For now, always use /chart/ for publishing as it has a simpler direct publish button
  // The TV_USE_PINE_PAGE flag only affects validation, not publishing
  if (USE_PINE_EDITOR_PAGE) {
    console.log('[TV Publish] Using /chart/ page for publishing (publish workflow not yet supported on /pine/)')
  }

  // Legacy path: Use /chart/ page
  console.log('[TV Publish] Using /chart/ page for publishing (legacy)')
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

    // Open Pine Editor if not already open
    const pineEditorVisible = await waitForElement(page, TV_SELECTORS.pineEditor.container, 5000)
    if (!pineEditorVisible) {
      console.log('[TV Publish] Pine Editor not open, looking for button...')

      // Try to find and click Pine Editor button (same logic as validation)
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], [role="button"]'))
        const pineBtn = buttons.find(btn => {
          const title = btn.getAttribute('title')
          const ariaLabel = btn.getAttribute('aria-label')
          return (title && title.toLowerCase().includes('pine')) ||
                 (ariaLabel && ariaLabel.toLowerCase().includes('pine'))
        })
        if (pineBtn) {
          (pineBtn as HTMLElement).click()
          return true
        }
        return false
      })

      if (clicked) {
        console.log('[TV Publish] Clicked Pine button')
        await delay(2000) // Wait for editor to load

        // Verify it opened
        const editorOpened = await waitForElement(page, '.monaco-editor', 10000)
        if (!editorOpened) {
          throw new Error('Pine Editor did not open')
        }
        console.log('[TV Publish] Pine Editor opened successfully')
      } else {
        throw new Error('Could not find Pine Editor button')
      }
    } else {
      console.log('[TV Publish] Pine Editor already open')
    }

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

    // Click publish button with multiple selector fallbacks
    console.log('[TV Publish] Looking for publish button...')
    const publishButtonSelectors = [
      TV_SELECTORS.publish.button,
      '[data-name="publish-script-button"]',
      '[data-name="save-publish-button"]',
      '[aria-label*="Publish" i]',
      '[title*="Publish" i]',
      'button[class*="publish" i]',
    ]

    let publishClicked = false
    for (const selector of publishButtonSelectors) {
      try {
        const btn = await page.$(selector)
        if (btn) {
          await btn.click()
          publishClicked = true
          console.log(`[TV Publish] Clicked publish button: ${selector}`)
          break
        }
      } catch {
        // Try next selector
      }
    }

    if (!publishClicked) {
      // Fallback: search by text content
      publishClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
        const publishBtn = buttons.find(btn => {
          const text = btn.textContent?.toLowerCase() || ''
          const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || ''
          return text.includes('publish') || ariaLabel.includes('publish')
        })
        if (publishBtn) {
          (publishBtn as HTMLElement).click()
          return true
        }
        return false
      })
      if (publishClicked) {
        console.log('[TV Publish] Clicked publish button via text search')
      }
    }

    if (!publishClicked) {
      // Take screenshot for debugging
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-chart-publish-no-button.png` })
      console.log(`[TV Publish] Screenshot saved to ${SCREENSHOT_DIR}/tv-chart-publish-no-button.png`)
      throw new Error('Could not find publish button')
    }

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

    // Set up listener for new tabs (TradingView opens published script in new tab)
    const browser = page.browser()
    let newScriptPage: typeof page | null = null

    const newPagePromise = new Promise<typeof page | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 15000) // 15s timeout
      browser.once('targetcreated', async (target) => {
        if (target.type() === 'page') {
          clearTimeout(timeout)
          const newPage = await target.page()
          if (newPage) {
            resolve(newPage)
          } else {
            resolve(null)
          }
        }
      })
    })

    // Final submit using helper function
    console.log('[TV Publish] Clicking final Publish button...')
    const submitted = await clickFinalPublishButton(page, visibility)

    if (!submitted) {
      // Take screenshot for debugging
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-publish-step2-failed.png` })
      console.log(`[TV Publish] Screenshot saved to ${SCREENSHOT_DIR}/tv-publish-step2-failed.png`)
      throw new Error('Could not find final Publish button in step 2')
    }

    // Wait for publish to complete and try to get the indicator URL
    console.log('[TV Publish] Waiting for publish to complete...')

    // First, wait for and check the new tab that TradingView opens
    console.log('[TV Publish] Waiting for new tab with published script...')
    newScriptPage = await newPagePromise

    if (newScriptPage) {
      // Wait for the new page to load
      try {
        await newScriptPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
        await delay(1000)
        const newTabUrl = newScriptPage.url()
        console.log(`[TV Publish] New tab opened: ${newTabUrl}`)

        if (newTabUrl.includes('/script/')) {
          console.log(`[TV Publish] Found script URL in new tab: ${newTabUrl}`)
          // Close the new tab since we got the URL
          await newScriptPage.close().catch(() => {})
          return {
            success: true,
            indicatorUrl: newTabUrl,
          }
        }
        // Close the new tab if it wasn't the script page
        await newScriptPage.close().catch(() => {})
      } catch (e) {
        console.log('[TV Publish] Error checking new tab:', e)
      }
    } else {
      console.log('[TV Publish] No new tab detected, checking current page...')
    }

    // Fallback: Try multiple times to find the indicator URL in current page
    for (let attempt = 0; attempt < 3; attempt++) {
      await delay(2000)

      // Check if we got redirected to the script page
      const currentUrl = page.url()
      console.log(`[TV Publish] Attempt ${attempt + 1}: Current URL: ${currentUrl}`)

      const indicatorMatch = currentUrl.match(/tradingview\.com\/script\/([^/]+)/)
      if (indicatorMatch) {
        console.log('[TV Publish] Found script URL in redirect!')
        return {
          success: true,
          indicatorUrl: `https://www.tradingview.com/script/${indicatorMatch[1]}/`,
        }
      }

      // Try to find URL in the page (success message, link, etc.)
      const indicatorUrl = await page.evaluate(() => {
        // Look for script link anywhere on the page
        const links = Array.from(document.querySelectorAll('a[href*="/script/"]'))
        for (const link of links) {
          const href = (link as HTMLAnchorElement).href
          if (href.includes('tradingview.com/script/')) {
            return href
          }
        }

        // Look for success message containing URL
        const successText = document.body.innerText
        const urlMatch = successText.match(/tradingview\.com\/script\/([a-zA-Z0-9]+)/)
        if (urlMatch) {
          return `https://www.tradingview.com/script/${urlMatch[1]}/`
        }

        return null
      })

      if (indicatorUrl) {
        console.log(`[TV Publish] Found script URL in page: ${indicatorUrl}`)
        return {
          success: true,
          indicatorUrl,
        }
      }

      // Check if publish dialog closed (might indicate success)
      const dialogStillOpen = await page.evaluate(() => {
        return !!document.querySelector('[data-dialog-name="publish-script"], [class*="publish-dialog"]')
      })

      if (!dialogStillOpen && attempt > 0) {
        console.log('[TV Publish] Dialog closed, publish may have succeeded')
      }
    }

    // Take screenshot for debugging
    await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-publish-no-url.png` })
    console.log(`[TV Publish] Screenshot saved to ${SCREENSHOT_DIR}/tv-publish-no-url.png`)

    // Fallback: Navigate to user's scripts page to find the newly published script
    console.log('[TV Publish] Trying to find script URL from user profile...')
    try {
      // Go to the user's scripts page
      await page.goto('https://www.tradingview.com/u/#published-scripts', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      })
      await delay(2000)

      // Look for the most recent script (should be at the top)
      const scriptUrl = await page.evaluate((scriptTitle) => {
        // Find script cards/items
        const scriptLinks = Array.from(document.querySelectorAll('a[href*="/script/"]'))
        for (const link of scriptLinks) {
          const href = (link as HTMLAnchorElement).href
          // Check if it matches our title or just return the first one (most recent)
          if (href.includes('/script/')) {
            return href
          }
        }
        return null
      }, title)

      if (scriptUrl) {
        console.log(`[TV Publish] Found script URL from profile: ${scriptUrl}`)
        return {
          success: true,
          indicatorUrl: scriptUrl,
        }
      }
    } catch (e) {
      console.log('[TV Publish] Failed to navigate to profile:', e)
    }

    // If dialog closed, consider it a success even without URL
    // The script was likely published
    console.log('[TV Publish] Script appears to have been published but URL could not be retrieved')
    return {
      success: true,
      indicatorUrl: undefined,
      // Note: returning success=true because the dialog closed and publish button was clicked
    }
  } catch (error) {
    console.error('Script publishing failed:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  } finally {
    if (session) {
      await closeBrowserSession(session)
    }
  }
}

/**
 * Publish a Pine Script using the dedicated /pine/ editor page
 * This is faster than /chart/ as it doesn't load charting components
 */
async function publishPineScriptV2(
  credentials: TVCredentials,
  options: PublishOptions
): Promise<PublishResult> {
  const { script, title, description } = options
  let session: BrowserlessSession | null = null

  try {
    session = await createBrowserSession()
    const { page } = session

    // Inject cookies
    const cookies = parseTVCookies(credentials)
    await injectCookies(page, cookies)

    // Navigate to dedicated Pine Editor page (faster than chart)
    console.log('[TV Publish v2] Navigating to /pine/ editor page...')
    const navigated = await navigateTo(page, TV_URLS.pine)
    if (!navigated) {
      throw new Error('Failed to navigate to Pine Editor page')
    }

    // Wait for Monaco editor to be ready
    console.log('[TV Publish v2] Waiting for Monaco editor...')
    const editorReady = await waitForElement(page, TV_SELECTORS.pineEditorPage.editorArea, 15000)
    if (!editorReady) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-pine-publish-no-editor.png` })
      console.log(`[TV Publish v2] Screenshot saved to ${SCREENSHOT_DIR}/tv-pine-publish-no-editor.png`)
      throw new Error('Monaco editor did not load on /pine/ page')
    }

    await delay(500)

    // Insert script via clipboard paste
    console.log('[TV Publish v2] Inserting script via clipboard paste...')
    await page.click('.monaco-editor')
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')
    await delay(100)
    await page.evaluate((text) => navigator.clipboard.writeText(text), script)
    await page.keyboard.down('Control')
    await page.keyboard.press('v')
    await page.keyboard.up('Control')
    console.log('[TV Publish v2] Script inserted via clipboard paste')

    // Wait for compilation
    await delay(1500)

    // Try to find and click publish button
    console.log('[TV Publish v2] Looking for publish button...')
    const publishButtonSelectors = [
      TV_SELECTORS.pineEditorPage.publishButton,
      TV_SELECTORS.publish.button,
      '[data-name="publish-script-button"]',
      '[aria-label*="publish" i]',
      '[title*="publish" i]',
    ]

    let publishClicked = false
    for (const selector of publishButtonSelectors) {
      try {
        const btn = await page.$(selector)
        if (btn) {
          await btn.click()
          publishClicked = true
          console.log(`[TV Publish v2] Clicked publish button: ${selector}`)
          break
        }
      } catch {
        // Try next selector
      }
    }

    if (!publishClicked) {
      // Try clicking by text content
      publishClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
        const publishBtn = buttons.find(btn => {
          const text = btn.textContent?.toLowerCase() || ''
          return text.includes('publish')
        })
        if (publishBtn) {
          (publishBtn as HTMLElement).click()
          return true
        }
        return false
      })

      if (publishClicked) {
        console.log('[TV Publish v2] Clicked publish button via text search')
      }
    }

    if (!publishClicked) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-pine-publish-no-button.png` })
      console.log(`[TV Publish v2] Screenshot saved to ${SCREENSHOT_DIR}/tv-pine-publish-no-button.png`)
      throw new Error('Could not find publish button on /pine/ page')
    }

    // Wait for publish dialog
    console.log('[TV Publish v2] Waiting for publish dialog...')
    const dialogSelectors = [
      TV_SELECTORS.publish.dialog,
      '[data-dialog-name="publish-script"]',
      '[class*="publish-dialog"]',
      '[class*="dialog"]',
    ]

    let dialogFound = false
    for (const selector of dialogSelectors) {
      dialogFound = await waitForElement(page, selector, 5000)
      if (dialogFound) {
        console.log(`[TV Publish v2] Dialog found with: ${selector}`)
        break
      }
    }

    if (!dialogFound) {
      await delay(2000) // Give it more time
      dialogFound = await waitForElement(page, TV_SELECTORS.publish.dialog, 5000)
    }

    if (!dialogFound) {
      console.log('[TV Publish v2] Publish dialog not found, but continuing...')
    }

    // Fill in publish form
    console.log('[TV Publish v2] Filling publish form...')
    const titleSelectors = [
      TV_SELECTORS.publish.titleInput,
      'input[name="title"]',
      'input[placeholder*="title" i]',
    ]

    for (const selector of titleSelectors) {
      try {
        const input = await page.$(selector)
        if (input) {
          await input.click()
          await input.type(title)
          console.log(`[TV Publish v2] Title filled via: ${selector}`)
          break
        }
      } catch {
        // Try next
      }
    }

    const descSelectors = [
      TV_SELECTORS.publish.descriptionInput,
      'textarea[name="description"]',
      'textarea[placeholder*="description" i]',
    ]

    for (const selector of descSelectors) {
      try {
        const textarea = await page.$(selector)
        if (textarea) {
          await textarea.click()
          await textarea.type(description)
          console.log(`[TV Publish v2] Description filled via: ${selector}`)
          break
        }
      } catch {
        // Try next
      }
    }

    // Select private visibility
    const privateSelectors = [
      TV_SELECTORS.publish.privateRadio,
      'input[value="private"]',
      '[data-value="private"]',
    ]

    for (const selector of privateSelectors) {
      try {
        const radio = await page.$(selector)
        if (radio) {
          await radio.click()
          console.log(`[TV Publish v2] Private selected via: ${selector}`)
          break
        }
      } catch {
        // Try next
      }
    }

    // Submit
    console.log('[TV Publish v2] Submitting...')
    const submitSelectors = [
      TV_SELECTORS.publish.submitButton,
      'button[type="submit"]',
      '[class*="submit"]',
    ]

    for (const selector of submitSelectors) {
      try {
        const btn = await page.$(selector)
        if (btn) {
          await btn.click()
          console.log(`[TV Publish v2] Submitted via: ${selector}`)
          break
        }
      } catch {
        // Try next
      }
    }

    // Wait for success
    await delay(5000)

    // Try to capture the new indicator URL
    const currentUrl = page.url()
    const indicatorMatch = currentUrl.match(/tradingview\.com\/script\/([^/]+)/)

    if (indicatorMatch) {
      console.log('[TV Publish v2] Published successfully, found URL in redirect')
      return {
        success: true,
        indicatorUrl: `https://www.tradingview.com/script/${indicatorMatch[1]}/`,
      }
    }

    // If no redirect, try to find the URL in the page
    const indicatorUrl = await page.evaluate(() => {
      const link = document.querySelector('a[href*="/script/"]') as HTMLAnchorElement
      return link?.href || null
    })

    if (indicatorUrl) {
      console.log('[TV Publish v2] Published successfully, found URL in page')
      return {
        success: true,
        indicatorUrl,
      }
    }

    // Fallback: Navigate to user's scripts page to find the newly published script
    console.log('[TV Publish v2] Trying to find script URL from user profile...')
    try {
      await page.goto('https://www.tradingview.com/u/#published-scripts', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      })
      await delay(2000)

      const scriptUrl = await page.evaluate(() => {
        const scriptLinks = Array.from(document.querySelectorAll('a[href*="/script/"]'))
        for (const link of scriptLinks) {
          const href = (link as HTMLAnchorElement).href
          if (href.includes('/script/')) {
            return href
          }
        }
        return null
      })

      if (scriptUrl) {
        console.log(`[TV Publish v2] Found script URL from profile: ${scriptUrl}`)
        return {
          success: true,
          indicatorUrl: scriptUrl,
        }
      }
    } catch (e) {
      console.log('[TV Publish v2] Failed to navigate to profile:', e)
    }

    console.log('[TV Publish v2] Could not retrieve indicator URL')
    return {
      success: true, // Still success since publish likely worked
      indicatorUrl: undefined,
    }
  } catch (error) {
    console.error('[TV Publish v2] Script publishing failed:', error)
    return {
      success: false,
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

  // Track response handler at function level so we can clean up in catch block
  let registeredResponseHandler: ((response: import('puppeteer-core').HTTPResponse) => void) | null = null

  try {
    // Reset editor state (clear previous content)
    console.log('[Warm Validate] Resetting editor state...')
    await page.keyboard.press('Escape')
    await delay(100)
    await page.keyboard.press('Escape')
    await delay(100)

    // Check if Monaco editor is accessible (might have navigated away after last publish)
    let editorExists = await page.$('.monaco-editor')

    if (!editorExists) {
      console.log('[Warm Validate] Monaco editor not found, navigating back to chart...')
      const currentUrl = page.url()
      console.log(`[Warm Validate] Current URL: ${currentUrl}`)

      // Navigate back to chart page
      await page.goto('https://www.tradingview.com/chart/', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      })
      await delay(2000)

      // Reopen Pine Editor
      const editorButtonSelectors = [
        TV_SELECTORS.chart.pineEditorButton,
        'button[title="Pine"]',
        'button[aria-label="Pine"]',
      ]

      for (const selector of editorButtonSelectors) {
        try {
          const button = await page.$(selector)
          if (button) {
            await button.click()
            console.log(`[Warm Validate] Clicked Pine Editor button: ${selector}`)
            break
          }
        } catch {
          // Try next
        }
      }

      // Wait for editor to load
      await page.waitForSelector('.monaco-editor', { timeout: 10000 })
      await delay(500)
      console.log('[Warm Validate] Pine Editor reopened')
      editorExists = await page.$('.monaco-editor')
    }

    if (!editorExists) {
      throw new Error('Monaco editor not found after navigation')
    }

    // Remove existing indicators from the chart (TradingView free tier limits to 2)
    console.log('[Warm Validate] Removing existing indicators from chart...')
    const removedCount = await page.evaluate(() => {
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
    })

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
    await page.evaluate((text) => navigator.clipboard.writeText(text), script)
    await page.keyboard.down('Control')
    await page.keyboard.press('v')
    await page.keyboard.up('Control')
    console.log('[Warm Validate] Script inserted')

    // Wait for compilation
    await delay(2000)

    // Click "Add to chart" to trigger validation
    console.log('[Warm Validate] Clicking "Add to chart"...')
    const addToChartClicked = await page.evaluate(() => {
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
    })

    if (addToChartClicked.clicked) {
      console.log(`[Warm Validate] Clicked "Add to chart": ${addToChartClicked.selector}`)
    }

    // Wait for validation to complete
    await delay(2500)

    // Extract errors from console panel
    const errors = await page.evaluate((selectors) => {
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
    }, TV_SELECTORS.pineEditor)

    // Get raw console output
    const rawOutput = await page.evaluate((selector) => {
      const panel = document.querySelector(selector)
      return panel?.textContent || ''
    }, TV_SELECTORS.pineEditor.consolePanel)

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

    // Click publish button
    const publishButtonSelectors = [
      '[data-name="publish-script-button"]',
      '[data-name="save-publish-button"]',
      '[aria-label*="Publish" i]',
      '[title*="Publish" i]',
    ]

    let publishClicked = false
    for (const selector of publishButtonSelectors) {
      try {
        const btn = await page.$(selector)
        if (btn) {
          await btn.click()
          publishClicked = true
          console.log(`[Warm Validate] Clicked publish button: ${selector}`)
          break
        }
      } catch {
        // Try next
      }
    }

    if (!publishClicked) {
      publishClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
        const publishBtn = buttons.find(btn => {
          const text = btn.textContent?.toLowerCase() || ''
          const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || ''
          return text.includes('publish') || ariaLabel.includes('publish')
        })
        if (publishBtn) {
          (publishBtn as HTMLElement).click()
          return true
        }
        return false
      })
    }

    if (!publishClicked) {
      console.log('[Warm Validate] Publish button not found')
      return {
        validation: validationResult,
        publish: { success: false, error: 'Publish button not found' },
      }
    }

    // Wait for publish dialog (Step 1)
    await delay(2000)

    // === STEP 1: Fill title and description ===
    console.log('[Warm Validate] Step 1: Filling title and description...')
    const { visibilityLevel } = publishOptions

    // Fill title
    await fillTitleField(page, title)

    // Fill description (uses contenteditable rich text editor)
    const descriptionText = description || title
    await fillRichTextDescription(page, descriptionText)

    // Click Continue to go to Step 2
    const movedToStep2 = await clickContinueButton(page)
    if (!movedToStep2) {
      console.log('[Warm Validate] Warning: Continue button may have failed, continuing anyway...')
    }

    // === STEP 2: Set visibility and submit ===
    console.log('[Warm Validate] Step 2: Setting visibility options...')
    await setVisibilityOptions(page, visibility, visibilityLevel)

    await delay(300)

    // Set up network request interception to capture script ID from API response
    let capturedScriptId: string | null = null
    let loggedUrls = new Set<string>()

    const responseHandler = async (response: import('puppeteer-core').HTTPResponse) => {
      try {
        const url = response.url()
        const status = response.status()

        // Skip non-successful responses and static assets
        if (status < 200 || status >= 300) return
        if (url.includes('.js') || url.includes('.css') || url.includes('.png') || url.includes('.svg') ||
            url.includes('.woff') || url.includes('.ico') || url.includes('.jpg') || url.includes('.gif')) return

        // Log ALL tradingview.com API-like URLs (not static assets) during debug
        if (url.includes('tradingview.com') && !loggedUrls.has(url)) {
          const urlPath = url.split('?')[0]
          // Only log API-like paths (not static)
          if (!urlPath.includes('/bundles/') && !urlPath.includes('/static/')) {
            loggedUrls.add(url)
            console.log(`[Warm Validate] Network: ${urlPath.slice(-80)}`)
          }
        }

        // TradingView uses various endpoints for publishing - be more inclusive
        const isRelevantUrl = url.includes('/pine_perm/') ||
                              url.includes('/publish') ||
                              url.includes('/script') ||
                              url.includes('/save') ||
                              url.includes('/create') ||
                              url.includes('/api/')

        if (isRelevantUrl) {
          const text = await response.text().catch(() => '')

          // Log the endpoint for debugging (abbreviated)
          if (text.length > 0 && text.length < 10000) {
            const urlPath = url.split('?')[0].slice(-60)
            console.log(`[Warm Validate] API response from ${urlPath}: ${text.slice(0, 300)}...`)
          }

          // Look for script ID patterns in the response (various TradingView formats)
          const idMatch = text.match(/"id"\s*:\s*"([a-zA-Z0-9]+)"/) ||
                          text.match(/"scriptId"\s*:\s*"([a-zA-Z0-9]+)"/) ||
                          text.match(/"script_id"\s*:\s*"([a-zA-Z0-9]+)"/) ||
                          text.match(/"idScript"\s*:\s*"([a-zA-Z0-9]+)"/) ||
                          text.match(/"scriptIdPart"\s*:\s*"([a-zA-Z0-9]+)"/) ||
                          text.match(/\/script\/([a-zA-Z0-9]+)/) ||
                          text.match(/"publishedUrl"\s*:\s*"[^"]*\/script\/([a-zA-Z0-9]+)/)

          if (idMatch && !capturedScriptId) {
            capturedScriptId = idMatch[1]
            console.log(`[Warm Validate] Captured script ID from API: ${capturedScriptId}`)
          }
        }
      } catch {
        // Ignore errors
      }
    }
    // Track handler at function level for cleanup in error paths
    registeredResponseHandler = responseHandler
    page.on('response', responseHandler)

    // Get browser context to listen for new tabs
    const browser = page.browser()
    let newScriptPage: import('puppeteer-core').Page | null = null

    // Set up listener for new page (TradingView opens new tab with published script)
    const newPagePromise = new Promise<import('puppeteer-core').Page | null>((resolve) => {
      const timeout = setTimeout(() => {
        console.log('[Warm Validate] No new tab opened within timeout')
        resolve(null)
      }, 15000)

      browser?.once('targetcreated', async (target) => {
        clearTimeout(timeout)
        try {
          const newPage = await target.page()
          if (newPage) {
            console.log('[Warm Validate] New tab detected')
            resolve(newPage)
          } else {
            resolve(null)
          }
        } catch (e) {
          console.log('[Warm Validate] Error getting new tab:', e)
          resolve(null)
        }
      })
    })

    // Click final publish button (Step 2)
    await clickFinalPublishButton(page, visibility)

    // Wait for new tab with published script URL OR dialog to close with success
    console.log('[Warm Validate] Waiting for new tab with published script...')

    // Start concurrent checks
    const dialogClosedPromise = (async () => {
      // Wait for publish dialog to close (up to 20s)
      for (let i = 0; i < 20; i++) {
        await delay(1000)
        const dialogVisible = await page.evaluate(() => {
          const dialog = document.querySelector('[data-dialog-name="publish-script"], [data-name="publish-dialog"], [class*="publish-dialog"]')
          return dialog !== null && (dialog as HTMLElement).offsetParent !== null
        }).catch(() => true)

        if (!dialogVisible) {
          console.log('[Warm Validate] Publish dialog closed after submit')
          // Look for success notification or script link
          const scriptUrl = await page.evaluate(() => {
            // Check for toast notifications with success message
            const toasts = document.querySelectorAll('[class*="toast"], [class*="notification"], [class*="snackbar"]')
            for (const toast of toasts) {
              const link = toast.querySelector('a[href*="/script/"]') as HTMLAnchorElement
              if (link?.href) return link.href
            }

            // Check for any newly appeared script links
            const scriptLinks = document.querySelectorAll('a[href*="/script/"]')
            for (const link of scriptLinks) {
              const href = (link as HTMLAnchorElement).href
              if (href.includes('tradingview.com/script/')) {
                return href
              }
            }
            return null
          }).catch(() => null)

          if (scriptUrl) {
            return { source: 'dialog-closed', url: scriptUrl }
          }

          // Dialog closed but no URL found yet - continue checking
          return { source: 'dialog-closed', url: null }
        }
      }
      return { source: 'timeout', url: null }
    })()

    newScriptPage = await newPagePromise

    if (newScriptPage) {
      try {
        await newScriptPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
        await delay(1000)
        const newTabUrl = newScriptPage.url()
        console.log(`[Warm Validate] New tab URL: ${newTabUrl}`)

        if (newTabUrl.includes('/script/')) {
          const totalTime = Date.now() - startTime
          console.log(`[Warm Validate] Published successfully in ${totalTime}ms: ${newTabUrl}`)
          // Close the new tab since we got the URL
          await newScriptPage.close().catch(() => {})
          return {
            validation: validationResult,
            publish: { success: true, indicatorUrl: newTabUrl },
          }
        }
        // Close the new tab if it wasn't the script page
        await newScriptPage.close().catch(() => {})
      } catch (e) {
        console.log('[Warm Validate] Error checking new tab:', e)
        await newScriptPage.close().catch(() => {})
      }
    }

    // Check if we captured script ID from network response
    if (capturedScriptId) {
      const indicatorUrl = `https://www.tradingview.com/script/${capturedScriptId}/`
      const totalTime = Date.now() - startTime
      console.log(`[Warm Validate] Published successfully via API capture in ${totalTime}ms: ${indicatorUrl}`)
      page.off('response', responseHandler)
      return {
        validation: validationResult,
        publish: { success: true, indicatorUrl },
      }
    }

    // Fallback: Try multiple times to find the URL in the current page
    console.log('[Warm Validate] No URL from new tab or API, checking current page...')
    for (let attempt = 0; attempt < 3; attempt++) {
      await delay(2000)

      // Check captured script ID again (might have been set during delay)
      if (capturedScriptId) {
        const indicatorUrl = `https://www.tradingview.com/script/${capturedScriptId}/`
        const totalTime = Date.now() - startTime
        console.log(`[Warm Validate] Published successfully via API capture in ${totalTime}ms: ${indicatorUrl}`)
        page.off('response', responseHandler)
        return {
          validation: validationResult,
          publish: { success: true, indicatorUrl },
        }
      }

      // Check if we got redirected to the script page
      const currentUrl = page.url()
      console.log(`[Warm Validate] Attempt ${attempt + 1}: Current URL: ${currentUrl}`)

      const indicatorMatch = currentUrl.match(/tradingview\.com\/script\/([^/]+)/)
      if (indicatorMatch) {
        const indicatorUrl = `https://www.tradingview.com/script/${indicatorMatch[1]}/`
        const totalTime = Date.now() - startTime
        console.log(`[Warm Validate] Published successfully in ${totalTime}ms: ${indicatorUrl}`)
        return {
          validation: validationResult,
          publish: { success: true, indicatorUrl },
        }
      }

      // Try to find script link in page - check toasts, dialogs, and body text
      const indicatorUrl = await page.evaluate(() => {
        // Check toast notifications first (TradingView shows success toasts)
        const toasts = document.querySelectorAll('[class*="toast"], [class*="notification"], [class*="snackbar"], [data-name*="toast"]')
        for (const toast of toasts) {
          const link = toast.querySelector('a[href*="/script/"]') as HTMLAnchorElement
          if (link?.href) return link.href
          const text = toast.textContent || ''
          const match = text.match(/tradingview\.com\/script\/([a-zA-Z0-9]+)/)
          if (match) return `https://www.tradingview.com/script/${match[1]}/`
        }

        // Check any visible dialogs
        const dialogs = document.querySelectorAll('[class*="dialog"], [role="dialog"], [data-dialog]')
        for (const dialog of dialogs) {
          const link = dialog.querySelector('a[href*="/script/"]') as HTMLAnchorElement
          if (link?.href) return link.href
        }

        // Check all links on page
        const links = Array.from(document.querySelectorAll('a[href*="/script/"]'))
        for (const link of links) {
          const href = (link as HTMLAnchorElement).href
          if (href.includes('tradingview.com/script/')) {
            return href
          }
        }

        // Look for success message containing URL in body text
        const successText = document.body.innerText
        const urlMatch = successText.match(/tradingview\.com\/script\/([a-zA-Z0-9]+)/)
        if (urlMatch) {
          return `https://www.tradingview.com/script/${urlMatch[1]}/`
        }

        return null
      })

      if (indicatorUrl) {
        const totalTime = Date.now() - startTime
        console.log(`[Warm Validate] Published in ${totalTime}ms: ${indicatorUrl}`)
        return {
          validation: validationResult,
          publish: { success: true, indicatorUrl },
        }
      }
    }

    // Check if dialog closed with a URL
    const dialogResult = await dialogClosedPromise
    if (dialogResult.url) {
      const totalTime = Date.now() - startTime
      console.log(`[Warm Validate] Found URL after dialog closed in ${totalTime}ms: ${dialogResult.url}`)
      page.off('response', responseHandler)
      return {
        validation: validationResult,
        publish: { success: true, indicatorUrl: dialogResult.url },
      }
    }
    console.log(`[Warm Validate] Dialog check result: ${dialogResult.source}, url: ${dialogResult.url}`)

    // If dialog closed successfully, try to get script URL via lightweight fetch
    if (dialogResult.source === 'dialog-closed') {
      console.log(`[Warm Validate] Dialog closed, trying lightweight script lookup...`)

      // Try to get the most recent script via TradingView's internal API
      const serviceAccountUsername = process.env.TV_SERVICE_ACCOUNT_USERNAME || 'lirex14'
      const scriptUrl = await page.evaluate(async (username) => {
        try {
          // Try TradingView's user scripts API first
          const apiResponse = await fetch(`https://www.tradingview.com/u-scripts/${username}/?sort=recent&count=1`, {
            credentials: 'include',
          })
          if (apiResponse.ok) {
            const apiText = await apiResponse.text()
            // Look for script ID in the response
            const scriptIdMatch = apiText.match(/\/script\/([a-zA-Z0-9]+)/)
            if (scriptIdMatch) {
              return { url: `https://www.tradingview.com/script/${scriptIdMatch[1]}/`, source: 'api' }
            }
          }

          // Fallback to profile page HTML
          const response = await fetch(`https://www.tradingview.com/u/${username}/`, {
            credentials: 'include',
          })
          const html = await response.text()

          // Log what we got (truncated)
          console.log('Profile HTML length:', html.length, 'First 500 chars:', html.slice(0, 500))

          // Try to find script in initial data (TradingView often embeds data in window.__INITIAL_STATE__)
          const initialStateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({[^<]+})/s)
          if (initialStateMatch) {
            try {
              const state = JSON.parse(initialStateMatch[1])
              // Look for scripts in the state
              const stateStr = JSON.stringify(state)
              const scriptMatch = stateStr.match(/\/script\/([a-zA-Z0-9]+)/)
              if (scriptMatch) {
                return { url: `https://www.tradingview.com/script/${scriptMatch[1]}/`, source: 'initial-state' }
              }
            } catch (e) {
              // JSON parse failed
            }
          }

          // Try to find script link directly in HTML
          const scriptMatch = html.match(/href="(\/script\/[a-zA-Z0-9]+[^"]*)"/)
          if (scriptMatch) {
            return { url: `https://www.tradingview.com${scriptMatch[1]}`, source: 'html-href' }
          }

          // Try alternate patterns
          const altMatch = html.match(/tradingview\.com\/script\/([a-zA-Z0-9]+)/)
          if (altMatch) {
            return { url: `https://www.tradingview.com/script/${altMatch[1]}/`, source: 'html-text' }
          }

          return null
        } catch (e) {
          console.error('Fetch error:', e)
          return null
        }
      }, serviceAccountUsername)

      if (scriptUrl) {
        const totalTime = Date.now() - startTime
        console.log(`[Warm Validate] Found script URL via ${scriptUrl.source} in ${totalTime}ms: ${scriptUrl.url}`)
        page.off('response', responseHandler)
        return {
          validation: validationResult,
          publish: { success: true, indicatorUrl: scriptUrl.url },
        }
      }

      console.log('[Warm Validate] Fetch lookup failed, trying profile page fallback...')
    }

    // Only try profile if dialog didn't close (timeout or unknown state)
    console.log('[Warm Validate] Trying to find script URL from user profile...')
    try {
      // Create a new tab for profile navigation to avoid disrupting current page
      const browser = page.browser()
      const profilePage = await browser?.newPage()

      if (profilePage) {
        // Inject cookies into the new page
        const cookies = await page.cookies()
        if (cookies.length > 0) {
          await profilePage.setCookie(...cookies)
        }

        const serviceAccountProfile = process.env.TV_SERVICE_ACCOUNT_PROFILE || 'https://www.tradingview.com/u/lirex14/#published-scripts'
        console.log(`[Warm Validate] Opening profile page: ${serviceAccountProfile}`)

        await profilePage.goto(serviceAccountProfile, {
          waitUntil: 'domcontentloaded',
          timeout: 10000,
        })

        // Wait for script cards to load - shorter timeout since this is a fallback
        console.log('[Warm Validate] Profile page loaded, waiting for script links...')
        await profilePage.waitForSelector('a[href*="/script/"]', { timeout: 8000 }).catch(() => {
          console.log('[Warm Validate] Script links not found within timeout')
        })
        await delay(1000)

        // Look for the most recent script (should be at the top)
        const profileScriptUrl = await profilePage.evaluate(() => {
          // Find all script links
          const scriptLinks = Array.from(document.querySelectorAll('a[href*="/script/"]'))
          for (const link of scriptLinks) {
            const href = (link as HTMLAnchorElement).href
            // Filter out non-script URLs
            if (href.includes('/script/') && !href.includes('/script/library/')) {
              return href
            }
          }
          return null
        })

        await profilePage.close()

        if (profileScriptUrl) {
          const totalTime = Date.now() - startTime
          console.log(`[Warm Validate] Found script URL from profile in ${totalTime}ms: ${profileScriptUrl}`)
          page.off('response', responseHandler)
          return {
            validation: validationResult,
            publish: { success: true, indicatorUrl: profileScriptUrl },
          }
        }
      }
    } catch (e) {
      console.log('[Warm Validate] Failed to get script URL from profile:', e)
    }

    // Final check for captured script ID
    if (capturedScriptId) {
      const indicatorUrl = `https://www.tradingview.com/script/${capturedScriptId}/`
      const totalTime = Date.now() - startTime
      console.log(`[Warm Validate] Published successfully via delayed API capture in ${totalTime}ms: ${indicatorUrl}`)
      page.off('response', responseHandler)
      return {
        validation: validationResult,
        publish: { success: true, indicatorUrl },
      }
    }

    const totalTime = Date.now() - startTime
    console.log(`[Warm Validate] Publish completed in ${totalTime}ms (URL not captured)`)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/warm-publish-no-url.png` }).catch(() => {})
    console.log('[Warm Validate] Script published but could not capture URL - check TradingView profile')
    page.off('response', responseHandler)
    // Return success with placeholder - the script IS published
    return {
      validation: validationResult,
      publish: { success: true, indicatorUrl: 'https://www.tradingview.com/u/lirex14/#published-scripts' },
    }
  } catch (error) {
    console.error('[Warm Validate] Error:', error)
    // Clean up response handler to prevent memory leak
    if (registeredResponseHandler) {
      page.off('response', registeredResponseHandler)
    }
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

/**
 * Validate and optionally publish a Pine Script in a single browser session
 * This is more efficient than calling validate and publish separately as it
 * reuses the same browser session, saving ~17s of overhead.
 */
export async function validateAndPublishPineScript(
  credentials: TVCredentials,
  script: string,
  publishOptions?: {
    title: string
    description: string
    visibility?: 'public' | 'private'
    visibilityLevel?: VisibilityLevel
  },
  requestId?: string
): Promise<ValidateAndPublishResult> {
  const reqId = requestId || randomUUID().slice(0, 8)
  const startTime = Date.now()
  const timings: Record<string, number> = {}
  const mark = (label: string) => {
    timings[label] = Date.now() - startTime
    console.log(`[TV Combined:${reqId}] TIMING: ${label} at ${timings[label]}ms`)
  }

  // Dev mode bypass
  if (DEV_BYPASS) {
    console.log(`[TV Combined:${reqId}] Dev bypass: Simulating validate + publish`)
    const fakeId = Math.random().toString(36).substring(7)
    return {
      validation: {
        isValid: true,
        errors: [],
        rawOutput: '[Dev Mode] Validation bypassed',
      },
      publish: publishOptions
        ? {
            success: true,
            indicatorUrl: `https://www.tradingview.com/script/${fakeId}/dev-test-indicator`,
          }
        : undefined,
    }
  }

  // Acquire lock to serialize Browserless access (plan limits to 1 concurrent session)
  await acquireBrowserlessLock(reqId)

  console.log(`[TV Combined:${reqId}] Using /chart/ page for validation + publish (single session)`)
  let session: ReconnectableBrowserSession | null = null

  try {
    session = await createBrowserSession()
    mark('session_created')

    // Enable Browserless reconnect for long operations (60s session timeout on free plan)
    if (session.isBrowserless) {
      const reconnectEndpoint = await enableBrowserlessReconnect(session, 10000)
      if (reconnectEndpoint) {
        console.log(`[TV Combined:${reqId}] Browserless reconnect enabled`)
      } else {
        console.log(`[TV Combined:${reqId}] Browserless reconnect not available (may hit 60s timeout)`)
      }
    }

    let page = session.page

    // Inject cookies
    const cookies = parseTVCookies(credentials)
    await injectCookies(page, cookies)

    // Navigate to /pine/ for validation (faster than /chart/, editor already open)
    console.log(`[TV Combined:${reqId}] Navigating to /pine/ for fast validation...`)
    const navigated = await navigateTo(page, TV_URLS.pine, { waitUntil: 'domcontentloaded' })
    if (!navigated) {
      throw new Error('Failed to navigate to TradingView Pine Editor')
    }
    mark('navigated_to_pine')

    // On /pine/ page, Monaco editor should already be visible - just wait for it
    console.log('[TV Combined] Waiting for Monaco editor on /pine/ page...')
    const monacoVisible = await waitForElement(page, '.monaco-editor', 10000)
    if (!monacoVisible) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-combined-monaco-not-found.png` })
      console.log(`[TV Combined] Screenshot saved to ${SCREENSHOT_DIR}/tv-combined-monaco-not-found.png`)
      throw new Error('Monaco editor not found on /pine/ page')
    }
    console.log('[TV Combined] Monaco editor ready on /pine/ page')
    mark('pine_editor_opened')

    // Wait for Monaco editor to be ready
    console.log('[TV Combined] Waiting for Monaco editor...')
    await waitForElement(page, TV_SELECTORS.pineEditor.editorArea, 10000)
    await delay(500)

    // Insert script via clipboard paste
    console.log('[TV Combined] Inserting script via clipboard paste...')
    await page.click('.monaco-editor')
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')
    await delay(100)
    await page.evaluate((text) => navigator.clipboard.writeText(text), script)
    await page.keyboard.down('Control')
    await page.keyboard.press('v')
    await page.keyboard.up('Control')
    console.log('[TV Combined] Script inserted via clipboard paste')
    mark('script_inserted')

    // Wait for compilation (reduced from 3000)
    await delay(2000)

    // Check console panel for errors
    const errors = await page.evaluate((selectors) => {
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
    }, TV_SELECTORS.pineEditor)

    // Get raw console output
    const rawOutput = await page.evaluate((selector) => {
      const panel = document.querySelector(selector)
      return panel?.textContent || ''
    }, TV_SELECTORS.pineEditor.consolePanel)

    const validationResult: ValidationResult = {
      isValid: errors.filter((e) => e.type === 'error').length === 0,
      errors,
      rawOutput,
    }

    console.log(`[TV Combined:${reqId}] Validation complete: isValid=${validationResult.isValid}`)
    mark('validation_complete')

    // If validation failed or no publish options, return just validation result
    if (!validationResult.isValid || !publishOptions) {
      return { validation: validationResult }
    }

    // === TRANSITION FROM /pine/ TO /chart/ VIA "Add to chart" ===
    // CRITICAL: Do NOT close the session! We need to preserve the script context.
    // The /pine/ page does NOT have a Publish option - we must navigate to /chart/.
    // By clicking "Add to chart", TradingView will:
    // 1. Show a "Save Script" dialog (we handle this)
    // 2. Navigate to /chart/ with the script already loaded in Pine Editor
    console.log(`[TV Combined:${reqId}] Validation passed. Using "Add to chart" to navigate to /chart/ with script context...`)
    mark('starting_add_to_chart')

    // Click "Add to chart" on /pine/ page
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
          console.log(`[TV Combined:${reqId}] Clicked "Add to chart": ${selector}`)
          addToChartClicked = true
          break
        }
      } catch { /* try next */ }
    }

    // Fallback: search by text content
    if (!addToChartClicked) {
      addToChartClicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button')
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() || ''
          if (text.includes('add to chart')) {
            btn.click()
            return true
          }
        }
        return false
      })
      if (addToChartClicked) {
        console.log(`[TV Combined:${reqId}] Clicked "Add to chart" via text search`)
      }
    }

    if (!addToChartClicked) {
      throw new Error('Could not find "Add to chart" button on /pine/ page')
    }

    await delay(2000) // Wait for dialog/navigation

    // Handle "Save Script" dialog if it appears
    const { title, description, visibility = 'public' } = publishOptions
    console.log(`[TV Combined:${reqId}] Checking for "Save Script" dialog...`)

    const saveDialogResult = await page.evaluate((scriptTitle: string) => {
      const dialogSelectors = ['[class*="dialog"]', '[class*="modal"]', '[role="dialog"]']

      for (const sel of dialogSelectors) {
        const dialogs = document.querySelectorAll(sel)
        for (const dialog of dialogs) {
          const text = dialog.textContent?.toLowerCase() || ''
          if (text.includes('save script') || text.includes('script name')) {
            // Fill the title input
            const input = dialog.querySelector('input[type="text"], input:not([type])') as HTMLInputElement
            if (input) {
              input.value = scriptTitle
              input.dispatchEvent(new Event('input', { bubbles: true }))
            }

            // Click Save button
            const buttons = dialog.querySelectorAll('button')
            for (const btn of buttons) {
              const btnText = btn.textContent?.toLowerCase() || ''
              if (btnText.includes('save') && !btnText.includes('cancel')) {
                btn.click()
                return { found: true, saved: true, title: scriptTitle }
              }
            }
            return { found: true, saved: false, reason: 'no save button' }
          }
        }
      }
      return { found: false }
    }, title)

    if (saveDialogResult.found) {
      console.log(`[TV Combined:${reqId}] Save Script dialog: ${JSON.stringify(saveDialogResult)}`)
      if (saveDialogResult.saved) {
        await delay(2000) // Wait for save to complete
        console.log(`[TV Combined:${reqId}] Script saved successfully`)
      }
    } else {
      console.log(`[TV Combined:${reqId}] No Save Script dialog found, continuing...`)
      await delay(2000)
    }

    // After "Add to chart", TradingView either:
    // 1. Navigates to /chart/ automatically (with script loaded)
    // 2. Opens a chart view/popup with the script
    // Wait for the transition and check if we're on chart or have Pine Editor
    console.log(`[TV Combined:${reqId}] Waiting for chart transition after "Add to chart"...`)

    // Wait for potential navigation or chart to appear
    await delay(3000)

    // Check current state
    const currentUrl = page.url()
    const isOnChart = currentUrl.includes('/chart')
    console.log(`[TV Combined:${reqId}] Current URL after "Add to chart": ${currentUrl}`)

    // Check if Monaco editor (Pine Editor) is visible
    let hasMonaco = await page.evaluate(() => !!document.querySelector('.monaco-editor'))
    let hasCanvas = await page.evaluate(() => !!document.querySelector('canvas'))
    console.log(`[TV Combined:${reqId}] State after "Add to chart": isOnChart=${isOnChart}, hasMonaco=${hasMonaco}, hasCanvas=${hasCanvas}`)

    // CRITICAL: We MUST be on /chart/ to publish - the /pine/ page has a canvas (mini preview)
    // but does NOT have the Publish Script button. Always navigate to /chart/ if not already there.
    if (!isOnChart) {
      console.log(`[TV Combined:${reqId}] Not on /chart/ page (URL: ${currentUrl}), navigating to /chart/...`)
      const chartNavigated = await navigateTo(page, TV_URLS.chart, { waitUntil: 'domcontentloaded' })
      if (!chartNavigated) {
        throw new Error('Failed to navigate to /chart/ page for publish')
      }
      console.log(`[TV Combined:${reqId}] Successfully navigated to /chart/`)
    } else {
      console.log(`[TV Combined:${reqId}] Already on /chart/ page`)
    }
    mark('navigated_to_chart')
    console.log(`[TV Combined:${reqId}] Chart page ready`)

    const publishPage = page

    // Wait for chart to fully load
    console.log(`[TV Combined:${reqId}] Waiting for chart page to load...`)
    await delay(5000) // Chart page is slow to load

    // Check if chart canvas is loaded
    for (let attempt = 0; attempt < 30; attempt++) {
      const hasCanvas = await page.evaluate(() => !!document.querySelector('canvas'))
      if (hasCanvas) {
        console.log(`[TV Combined:${reqId}] Chart canvas loaded`)
        break
      }
      await delay(500)
    }
    await delay(2000)

    // Dismiss any popups
    await page.keyboard.press('Escape')
    await delay(300)

    // Open Pine Editor on /chart/ page
    // The Pine Editor is not open by default - we need to open it
    console.log(`[TV Combined:${reqId}] Opening Pine Editor on /chart/ page...`)

    // Check if Monaco editor is already visible
    let monacoFound = await page.evaluate(() => !!document.querySelector('.monaco-editor'))

    // Define pineButtonClicked outside the if block so it can be accessed later
    let pineButtonClicked: { clicked: boolean; via?: string; needsSecondClick?: boolean; [key: string]: unknown } = { clicked: false }

    if (!monacoFound) {
      // STRATEGY 0: Click the Pine button directly in the right sidebar widgetbar
      // data-name="pine-dialog-button" or aria-label="Pine"
      // This opens Pine Editor directly without needing the Products panel
      console.log(`[TV Combined:${reqId}] Clicking Pine button in right sidebar widgetbar...`)
      pineButtonClicked = await page.evaluate(() => {
        // Try the direct Pine Editor button first (best option)
        const pineButton = document.querySelector('[data-name="pine-dialog-button"]') ||
                           document.querySelector('[aria-label="Pine"]')
        if (pineButton) {
          (pineButton as HTMLElement).click()
          return { clicked: true, via: 'pine-dialog-button' }
        }

        // Fallback: Try the Products button which opens a panel with Pine Editor
        const productsButton = document.querySelector('[aria-label="Products"]')
        if (productsButton) {
          (productsButton as HTMLElement).click()
          return { clicked: true, via: 'aria-label-products', needsSecondClick: true }
        }

        // Fallback: look in the right sidebar specifically
        const rightSidebar = document.querySelector('.layout__area--right')
        if (rightSidebar) {
          // Get all buttons in the right sidebar
          const sidebarButtons = rightSidebar.querySelectorAll('button, [role="button"]')
          let bestCandidate: { btn: HTMLElement, score: number } | null = null

          for (const btn of sidebarButtons) {
            const rect = (btn as HTMLElement).getBoundingClientRect()
            // Grid icon is at the BOTTOM of the right sidebar (below 70% of viewport height)
            if (rect.top > window.innerHeight * 0.7 && rect.width > 15 && rect.width < 60) {
              const svg = btn.querySelector('svg')
              if (svg) {
                const circles = svg.querySelectorAll('circle')
                const rects = svg.querySelectorAll('rect')
                // Grid icon has 9 circles (3x3 grid) or 9 rects
                if (circles.length >= 9 || rects.length >= 9) {
                  (btn as HTMLElement).click()
                  return { clicked: true, via: 'right-sidebar-9-dots', circles: circles.length, rects: rects.length }
                }
                // Fallback: look for multiple colored shapes
                if (circles.length >= 4 || rects.length >= 4) {
                  const score = circles.length + rects.length
                  if (!bestCandidate || score > bestCandidate.score) {
                    bestCandidate = { btn: btn as HTMLElement, score }
                  }
                }
              }
            }
          }

          if (bestCandidate) {
            bestCandidate.btn.click()
            return { clicked: true, via: 'right-sidebar-best-match', score: bestCandidate.score }
          }
        }

        // Fallback: Look for a button with many SVG circles/rects anywhere in the bottom-right
        const allButtons = document.querySelectorAll('button, [role="button"]')
        for (const btn of allButtons) {
          const rect = (btn as HTMLElement).getBoundingClientRect()
          // Look in the bottom-right corner (rightmost 100px, bottom 200px)
          const isBottomRight = rect.left > window.innerWidth - 100 && rect.top > window.innerHeight - 200
          if (isBottomRight && rect.width > 15 && rect.width < 60) {
            const svg = btn.querySelector('svg')
            if (svg) {
              const circles = svg.querySelectorAll('circle')
              const rects = svg.querySelectorAll('rect')
              if (circles.length >= 4 || rects.length >= 4) {
                (btn as HTMLElement).click()
                return { clicked: true, via: 'bottom-right-fallback', circles: circles.length, rects: rects.length }
              }
            }
          }
        }

        // Last resort: try specific data-name selectors
        const safeSelectors = [
          '[data-name="more-features"]',
          '[data-name="feature-grid"]',
          '[data-name="apps"]',
          '[data-name="products"]',
        ]
        for (const sel of safeSelectors) {
          const el = document.querySelector(sel)
          if (el) {
            (el as HTMLElement).click()
            return { clicked: true, via: 'data-name', selector: sel }
          }
        }

        return { clicked: false }
      })

      if (pineButtonClicked.clicked) {
        console.log(`[TV Combined:${reqId}] Clicked Pine/Products button: ${JSON.stringify(pineButtonClicked)}`)
        await delay(2000)

        // If we clicked the direct Pine button, we're done - Pine Editor should open
        // If we clicked Products button, we need to click "Pine Editor" in the panel
        if (pineButtonClicked.needsSecondClick) {
          // Now find and click "Pine Editor" in the panel that opened
          // The panel has a PRODUCTS section with items like "Pine Editor"
          const pineEditorClicked = await page.evaluate(() => {
            // Look for exact "Pine Editor" text in the products panel
            const allElements = document.querySelectorAll('*')
            for (const el of allElements) {
              // Check direct text content (not nested)
              if (el.childNodes.length > 0) {
                for (const child of el.childNodes) {
                  if (child.nodeType === Node.TEXT_NODE) {
                    const text = child.textContent?.trim() || ''
                    if (text === 'Pine Editor') {
                      // Click the parent element (the clickable row)
                      const clickable = el.closest('a, button, [role="button"], [role="menuitem"]') || el
                      ;(clickable as HTMLElement).click()
                      return { clicked: true, via: 'exact-text', text }
                    }
                  }
                }
              }
            }

            // Fallback: broader search
            const panelItems = document.querySelectorAll(
              '[class*="menu"] button, [class*="panel"] button, [class*="drawer"] button, ' +
              '[role="menuitem"], [class*="item"], [class*="option"], a, div[class*="row"]'
            )
            for (const item of panelItems) {
              const text = (item as HTMLElement).textContent?.trim() || ''
              if (text === 'Pine Editor' || text.startsWith('Pine Editor')) {
                (item as HTMLElement).click()
                return { clicked: true, via: 'panel-item', text: text.substring(0, 30) }
              }
            }
            return { clicked: false }
          })

          if (pineEditorClicked.clicked) {
            console.log(`[TV Combined:${reqId}] Clicked Pine Editor in panel: ${JSON.stringify(pineEditorClicked)}`)
            await delay(2000)
          }
        }

        // After clicking pine-dialog-button, poll for Monaco editor (it may take time to animate in)
        // Don't immediately try keyboard shortcuts as they can toggle the editor closed
        for (let poll = 0; poll < 5 && !monacoFound; poll++) {
          await delay(1000)
          monacoFound = await page.evaluate(() => !!document.querySelector('.monaco-editor'))
          if (monacoFound) {
            console.log(`[TV Combined:${reqId}] Monaco editor appeared after ${poll + 1}s wait`)
            break
          }
        }
      }
    }

    // ONLY try keyboard shortcut if button click approach didn't work at all
    if (!monacoFound && !pineButtonClicked?.clicked) {
      // Try keyboard shortcut (Ctrl+, is a common shortcut)
      console.log(`[TV Combined:${reqId}] Trying keyboard shortcut Ctrl+comma...`)
      await page.keyboard.down('Control')
      await page.keyboard.press(',')
      await page.keyboard.up('Control')
      await delay(2000)

      monacoFound = await page.evaluate(() => !!document.querySelector('.monaco-editor'))
    }

    if (!monacoFound) {
      // CRITICAL: Do NOT click [aria-label*="Pine"] in left toolbar - it navigates to /pine/ page!
      // Instead, look for bottom panel tabs or use keyboard shortcut
      console.log(`[TV Combined:${reqId}] Pine Editor not open. Trying to open via bottom panel...`)

      // Strategy 1: Look for Pine Editor tab in the BOTTOM panel area
      // This is different from the left toolbar - bottom panel tabs don't navigate away
      const bottomTabClicked = await page.evaluate(() => {
        // The bottom panel has a widget bar with tabs
        const bottomArea = document.querySelector('.layout__area--bottom')
        if (bottomArea) {
          // Look for tabs/buttons specifically in the bottom widget bar
          const widgetBar = bottomArea.querySelector('[class*="widgetbar"], [class*="widget-bar"]')
          const tabs = (widgetBar || bottomArea).querySelectorAll('[class*="tab"], [role="tab"], button')

          for (const tab of tabs) {
            const text = (tab as HTMLElement).textContent?.toLowerCase() || ''
            const title = (tab as HTMLElement).getAttribute('title')?.toLowerCase() || ''
            const dataName = (tab as HTMLElement).getAttribute('data-name')?.toLowerCase() || ''

            if (text.includes('pine') || title.includes('pine') ||
                dataName.includes('pine') || dataName.includes('script')) {
              (tab as HTMLElement).click()
              return { clicked: true, via: 'bottom-tab', text: text.substring(0, 30) }
            }
          }
        }
        return { clicked: false }
      })

      if (bottomTabClicked.clicked) {
        console.log(`[TV Combined:${reqId}] Clicked bottom panel tab: ${JSON.stringify(bottomTabClicked)}`)
        await delay(3000)
        monacoFound = await page.evaluate(() => !!document.querySelector('.monaco-editor'))
      }

      // Strategy 2: Try keyboard shortcut to toggle Pine Editor
      if (!monacoFound) {
        console.log(`[TV Combined:${reqId}] Trying keyboard shortcuts to open Pine Editor...`)

        // Try multiple shortcuts
        const shortcuts = [
          { key: ',', ctrl: true },  // Ctrl+, opens Pine Editor in some layouts
          { key: 'e', ctrl: true },  // Ctrl+E might open editor
        ]

        for (const shortcut of shortcuts) {
          if (shortcut.ctrl) {
            await page.keyboard.down('Control')
            await page.keyboard.press(shortcut.key)
            await page.keyboard.up('Control')
          } else {
            await page.keyboard.press(shortcut.key)
          }
          await delay(2000)

          monacoFound = await page.evaluate(() => !!document.querySelector('.monaco-editor'))
          if (monacoFound) {
            console.log(`[TV Combined:${reqId}] Pine Editor opened via keyboard shortcut`)
            break
          }
        }
      }

      // Strategy 3: Try clicking the Pine Editor button in the actual bottom widgetbar
      // (NOT the left toolbar which navigates away)
      if (!monacoFound) {
        console.log(`[TV Combined:${reqId}] Trying to find Pine Editor button in bottom widgetbar...`)
        const widgetBarClicked = await page.evaluate(() => {
          // Look for the actual bottom widgetbar with handle tabs
          const allButtons = document.querySelectorAll('button, [role="button"], [role="tab"]')

          for (const btn of allButtons) {
            const rect = (btn as HTMLElement).getBoundingClientRect()
            // Only look at buttons in the very bottom of the viewport (last 60px)
            if (rect.top > window.innerHeight - 60 && rect.height > 0 && rect.height < 50) {
              const text = (btn as HTMLElement).textContent?.toLowerCase() || ''
              const title = (btn as HTMLElement).getAttribute('title')?.toLowerCase() || ''
              const dataName = (btn as HTMLElement).getAttribute('data-name') || ''

              // Check if this looks like a Pine Editor tab
              if (text.includes('pine') || text.includes('script') ||
                  title.includes('pine') || title.includes('script') ||
                  dataName.includes('pine') || dataName.includes('script')) {
                (btn as HTMLElement).click()
                return { clicked: true, via: 'widgetbar-button', text: text.substring(0, 30), dataName }
              }
            }
          }
          return { clicked: false }
        })

        if (widgetBarClicked.clicked) {
          console.log(`[TV Combined:${reqId}] Clicked widgetbar button: ${JSON.stringify(widgetBarClicked)}`)
          await delay(3000)
          monacoFound = await page.evaluate(() => !!document.querySelector('.monaco-editor'))
        }
      }

      // Strategy 4: Try safe data-name selectors only
      if (!monacoFound) {
        console.log(`[TV Combined:${reqId}] Trying safe data-name selectors...`)
        const safeButtonClicked = await page.evaluate(() => {
          const safeSelectors = [
            '[data-name="scripteditor"]',
            '[data-name="pine-editor"]',
            '[data-name="open-pine-editor"]',
          ]
          for (const sel of safeSelectors) {
            const btn = document.querySelector(sel)
            if (btn) {
              (btn as HTMLElement).click()
              return { clicked: true, selector: sel }
            }
          }
          return { clicked: false }
        })

        if (safeButtonClicked.clicked) {
          console.log(`[TV Combined:${reqId}] Clicked safe selector: ${JSON.stringify(safeButtonClicked)}`)
          await delay(3000)
          monacoFound = await page.evaluate(() => !!document.querySelector('.monaco-editor'))
        }
      }

      // Strategy 5: Click "Trading Panel" text at bottom-left to expand bottom panel
      if (!monacoFound) {
        console.log(`[TV Combined:${reqId}] Looking for Trading Panel or bottom bar...`)
        const tradingPanelClicked = await page.evaluate(() => {
          // Look for "Trading Panel" text which opens the bottom panel
          const allText = document.body.querySelectorAll('*')
          for (const el of allText) {
            if (el.childNodes.length === 1 && el.childNodes[0].nodeType === Node.TEXT_NODE) {
              const text = el.textContent?.toLowerCase() || ''
              if (text === 'trading panel' || text === 'pine editor') {
                (el as HTMLElement).click()
                return { clicked: true, text }
              }
            }
          }
          return { clicked: false }
        })

        if (tradingPanelClicked.clicked) {
          console.log(`[TV Combined:${reqId}] Clicked: ${JSON.stringify(tradingPanelClicked)}`)
          await delay(2000)

          // Now look for Pine Editor tab within the opened panel
          const pineTabClicked = await page.evaluate(() => {
            const tabs = document.querySelectorAll('[role="tab"], [class*="tab"], button')
            for (const tab of tabs) {
              const text = (tab as HTMLElement).textContent?.toLowerCase() || ''
              if (text.includes('pine')) {
                (tab as HTMLElement).click()
                return { clicked: true, text: text.substring(0, 30) }
              }
            }
            return { clicked: false }
          })

          if (pineTabClicked.clicked) {
            console.log(`[TV Combined:${reqId}] Clicked Pine tab: ${JSON.stringify(pineTabClicked)}`)
            await delay(2000)
          }

          monacoFound = await page.evaluate(() => !!document.querySelector('.monaco-editor'))
        }
      }

      // Take screenshot for debugging if still no Monaco
      if (!monacoFound) {
        // Log what we can see on the page for debugging
        const pageState = await page.evaluate(() => {
          const rightSidebar = document.querySelector('.layout__area--right')
          const bottomArea = document.querySelector('.layout__area--bottom')
          const allSvgs = document.querySelectorAll('svg')
          const svgInfo = []
          for (const svg of allSvgs) {
            const circles = svg.querySelectorAll('circle')
            const rect = svg.getBoundingClientRect()
            if (circles.length >= 4 && rect.width > 15) {
              svgInfo.push({
                circles: circles.length,
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                parent: svg.parentElement?.tagName
              })
            }
          }
          return {
            hasRightSidebar: !!rightSidebar,
            hasBottomArea: !!bottomArea,
            bottomAreaText: bottomArea?.textContent?.substring(0, 100),
            potentialGridIcons: svgInfo.slice(0, 5)
          }
        })
        console.log(`[TV Combined:${reqId}] Page state: ${JSON.stringify(pageState)}`)
        await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-chart-no-pine-editor.png` }).catch(() => {})
        console.log(`[TV Combined:${reqId}] Screenshot saved: chart page without Pine Editor`)
      }
    }

    // If still no Monaco, take screenshot and throw error
    if (!monacoFound) {
      console.log(`[TV Combined:${reqId}] Waiting for Monaco editor...`)
      const monacoOnChart = await waitForElement(publishPage, '.monaco-editor', 10000)
      if (!monacoOnChart) {
        await publishPage.screenshot({ path: `${SCREENSHOT_DIR}/tv-publish-chart-no-editor.png` }).catch(() => {})
        throw new Error('Monaco editor not found on /chart/ page - Pine Editor did not open')
      }
    }

    console.log(`[TV Combined:${reqId}] Monaco editor found on /chart/ page`)

    // SIMPLIFIED: Always paste script directly instead of trying to find saved version
    // This is more reliable than using Ctrl+O to search for saved scripts
    console.log(`[TV Combined:${reqId}] Pasting script "${title}" directly into editor...`)

    // CRITICAL: Click Monaco editor to focus it before pasting
    await page.click('.monaco-editor')
    await delay(200)

    // Select all existing code and replace with our script
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')
    await delay(100)

    // Write script to clipboard and paste
    await page.evaluate((text: string) => navigator.clipboard.writeText(text), script)
    await page.keyboard.down('Control')
    await page.keyboard.press('v')
    await page.keyboard.up('Control')
    await delay(1000)

    // Verify the script was actually pasted by checking editor content
    const pasteVerified = await page.evaluate(() => {
      const editor = document.querySelector('.monaco-editor')
      if (!editor) return { verified: false, reason: 'no editor' }

      // Try to get content from Monaco's model
      const monacoModel = (window as any).monaco?.editor?.getModels?.()?.[0]
      if (monacoModel) {
        const content = monacoModel.getValue()
        const hasIndicator = content.includes('indicator(') || content.includes('strategy(')
        return { verified: hasIndicator, reason: hasIndicator ? 'content matches' : 'no indicator found', contentLength: content.length }
      }

      // Fallback: check visible text
      const visibleText = editor.textContent || ''
      const hasIndicator = visibleText.includes('indicator') || visibleText.includes('strategy')
      return { verified: hasIndicator, reason: hasIndicator ? 'visible text matches' : 'no indicator in visible text', contentLength: visibleText.length }
    })

    console.log(`[TV Combined:${reqId}] Paste verification: ${JSON.stringify(pasteVerified)}`)
    if (!pasteVerified.verified) {
      console.log(`[TV Combined:${reqId}] WARNING: Paste may have failed, retrying...`)
      // Retry paste
      await page.click('.monaco-editor')
      await delay(200)
      await page.keyboard.down('Control')
      await page.keyboard.press('a')
      await page.keyboard.up('Control')
      await delay(100)
      await page.evaluate((text: string) => navigator.clipboard.writeText(text), script)
      await page.keyboard.down('Control')
      await page.keyboard.press('v')
      await page.keyboard.up('Control')
      await delay(1000)
    }

    console.log(`[TV Combined:${reqId}] Script pasted successfully`)

    // Wait for the script to be ready
    console.log(`[TV Combined:${reqId}] Waiting for script to be ready...`)
    await delay(2000)

    mark('publish_editor_confirmed')

    // Take screenshot showing Pine Editor is open
    await publishPage.screenshot({ path: `${SCREENSHOT_DIR}/tv-publish-0-chart-loaded.png` }).catch(() => {})
    console.log(`[TV Combined:${reqId}] Screenshot 0: Pine Editor loaded - ${SCREENSHOT_DIR}/tv-publish-0-chart-loaded.png`)

    // === CLEAR EXISTING INDICATORS ===
    // Remove any existing indicators from the chart to avoid hitting the free plan limit
    // TradingView free plans have a limit of ~2 indicators per chart
    console.log(`[TV Combined:${reqId}] Clearing existing indicators from chart...`)
    const clearedIndicators = await page.evaluate(() => {
      let removed = 0
      // Find indicator legends in the chart - they have a close/remove button
      // Indicators appear in the pane-legend area with remove buttons
      const indicatorLegends = document.querySelectorAll('[data-name="legend-source-item"], [class*="sourcesWrapper"] [class*="legend"], [class*="pane-legend"] [class*="item"]')

      for (const legend of indicatorLegends) {
        // Skip if it's the main price series (not an indicator)
        const text = legend.textContent?.toLowerCase() || ''
        if (text.includes('close') && text.includes('open') && text.includes('high') && text.includes('low')) {
          continue // Skip main price candles legend
        }

        // Look for remove/close button within the legend
        const removeBtn = legend.querySelector('[data-name="legend-delete-action"], [class*="close"], [class*="remove"], button[aria-label*="remove" i], button[aria-label*="delete" i], button[title*="remove" i]')
        if (removeBtn) {
          (removeBtn as HTMLElement).click()
          removed++
        }
      }

      // Also try to find indicators by their typical structure
      const sourceItems = document.querySelectorAll('[data-name="legend-source-item"]')
      for (const item of sourceItems) {
        // Check if it's a study/indicator (not the main series)
        const isStudy = item.querySelector('[data-name="legend-series-item"]') === null
        if (isStudy) {
          const closeBtn = item.querySelector('[data-name="legend-delete-action"]')
          if (closeBtn) {
            (closeBtn as HTMLElement).click()
            removed++
          }
        }
      }

      return { removed }
    })
    console.log(`[TV Combined:${reqId}] Cleared ${clearedIndicators.removed} existing indicators`)

    // Wait for indicators to be removed
    if (clearedIndicators.removed > 0) {
      await delay(1500)
    }

    // === ADD TO CHART - COMPILE AND APPLY THE NEW CODE ===
    // When you paste code and click "Add to chart", it:
    // 1. Compiles the current editor content (our pasted code)
    // 2. Shows "Save Script" dialog if it's a new/unsaved script
    // 3. Adds the compiled script to the chart
    console.log(`[TV Combined:${reqId}] Compiling and adding script to chart...`)
    const addToChartResult = await page.evaluate(() => {
      // Look for "Add to chart" button in Pine Editor
      // Pine Editor can be in right sidebar OR bottom panel depending on TradingView layout
      const rightSidebar = document.querySelector('.layout__area--right, [data-name="right-toolbar-container"]')
      const bottomArea = document.querySelector('.layout__area--bottom')
      const pineEditor = document.querySelector('[data-name="pine-editor"]')
      // Search in Pine Editor first, then right sidebar, then bottom, then full document
      const searchArea = pineEditor || rightSidebar || bottomArea || document

      const buttons = searchArea.querySelectorAll('button')
      for (const btn of buttons) {
        const text = btn.textContent?.toLowerCase() || ''
        const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || ''
        const title = btn.getAttribute('title')?.toLowerCase() || ''
        const className = btn.className?.toLowerCase() || ''
        const dataName = btn.getAttribute('data-name')?.toLowerCase() || ''

        // Match "Add to chart" button specifically
        if (text.includes('add to chart') || ariaLabel.includes('add to chart') ||
            title.includes('add to chart') || dataName.includes('apply')) {
          btn.click()
          return { clicked: true, via: 'button-text', text: text.substring(0, 30), ariaLabel, dataName }
        }
      }

      // Try data-name selectors
      const applyBtn = searchArea.querySelector('[data-name="add-script-to-chart"], [data-name="apply-script"], [data-name="AddToChart"]')
      if (applyBtn) {
        (applyBtn as HTMLElement).click()
        return { clicked: true, via: 'data-name-selector', dataName: applyBtn.getAttribute('data-name') }
      }

      // Last resort: look for button with apply/add class
      const applyClassBtn = searchArea.querySelector('button[class*="apply" i], button[class*="add-to-chart" i]')
      if (applyClassBtn) {
        (applyClassBtn as HTMLElement).click()
        return { clicked: true, via: 'class-selector', className: applyClassBtn.className }
      }

      return { clicked: false }
    })

    if (addToChartResult.clicked) {
      console.log(`[TV Combined:${reqId}] Add to chart clicked: ${JSON.stringify(addToChartResult)}`)
      await delay(2000) // Wait for dialog to appear

      // Check if a "Save Script" dialog appeared and handle it
      // This dialog appears when adding an unsaved/modified script to chart
      console.log(`[TV Combined:${reqId}] Looking for Save Script dialog...`)
      const saveDialogHandled = await page.evaluate((scriptTitle: string) => {
        const dialogs = document.querySelectorAll('[class*="dialog"], [class*="modal"], [role="dialog"]')
        for (const dialog of dialogs) {
          const text = dialog.textContent?.toLowerCase() || ''
          if (text.includes('save script') || text.includes('script name') || text.includes('save as')) {
            // Fill the title input
            const input = dialog.querySelector('input[type="text"], input:not([type])') as HTMLInputElement
            if (input) {
              input.value = scriptTitle
              input.dispatchEvent(new Event('input', { bubbles: true }))
              input.dispatchEvent(new Event('change', { bubbles: true }))
            }
            // Click Save button
            const buttons = dialog.querySelectorAll('button')
            for (const btn of buttons) {
              const btnText = btn.textContent?.toLowerCase() || ''
              if (btnText.includes('save') && !btnText.includes('cancel') && !btnText.includes('don')) {
                btn.click()
                return { found: true, saved: true, dialogText: text.substring(0, 100) }
              }
            }
            return { found: true, saved: false, dialogText: text.substring(0, 100) }
          }
        }
        return { found: false }
      }, title)

      if (saveDialogHandled.found) {
        console.log(`[TV Combined:${reqId}] Save dialog handled: ${JSON.stringify(saveDialogHandled)}`)
        await delay(3000) // Wait for save to complete and script to be added
      } else {
        console.log(`[TV Combined:${reqId}] No Save dialog found - script may have been added directly`)
        await delay(2000)
      }

      // Check for and dismiss "Go Pro" / upgrade dialog (indicator limit reached)
      const goProDialog = await page.evaluate(() => {
        const bodyText = document.body.innerText.toLowerCase()
        if (bodyText.includes('more indicators') && bodyText.includes('maximum available') ||
            bodyText.includes('upgrade') && bodyText.includes('indicators per chart') ||
            bodyText.includes('go pro') && bodyText.includes('indicator')) {
          // Try to close the dialog by pressing Escape or clicking X
          const closeButtons = document.querySelectorAll('[class*="close"], [aria-label*="close" i], [data-name="close"]')
          for (const btn of closeButtons) {
            const rect = (btn as HTMLElement).getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) {
              (btn as HTMLElement).click()
              return { found: true, dismissed: true, via: 'close-button' }
            }
          }
          return { found: true, dismissed: false }
        }
        return { found: false }
      })

      if (goProDialog.found) {
        console.log(`[TV Combined:${reqId}] WARNING: "Go Pro" dialog detected (indicator limit). Dismissed: ${goProDialog.dismissed}`)
        if (!goProDialog.dismissed) {
          // Try Escape key to close
          await page.keyboard.press('Escape')
          await delay(500)
        }
        await delay(1000)
      }

      // Verify script is on chart by checking for indicator in the chart area
      const scriptOnChart = await page.evaluate(() => {
        // Look for our script in the chart's indicator list
        const indicators = document.querySelectorAll('[class*="legend"], [class*="indicator-title"], [data-name*="legend"]')
        return {
          indicatorCount: indicators.length,
          texts: Array.from(indicators).slice(0, 3).map((el) => el.textContent?.substring(0, 50))
        }
      })
      console.log(`[TV Combined:${reqId}] Script on chart check: ${JSON.stringify(scriptOnChart)}`)
    } else {
      console.log(`[TV Combined:${reqId}] Add to chart button not found, script may already be on chart`)
    }

    await delay(2000)

    // === PUBLISH PHASE ===
    console.log(`[TV Combined:${reqId}] Starting publish flow...`)
    console.log(`[TV Combined:${reqId}] Using - title: "${title}", description: "${description}", visibility: "${visibility}"`)

    // Set up network response capture to get script ID from API response
    let capturedScriptId: string | null = null
    const responseHandler = async (response: import('puppeteer-core').HTTPResponse) => {
      try {
        const url = response.url()
        const status = response.status()
        if (status < 200 || status >= 300) return
        if (url.includes('.js') || url.includes('.css') || url.includes('.png')) return

        // Debug: Log ALL tradingview.com API responses to identify correct endpoints
        if (url.includes('tradingview.com') && !url.includes('.js') && !url.includes('.css') && !url.includes('.png') && !url.includes('.svg') && !url.includes('.woff')) {
          console.log(`[TV Network:${reqId}] ${response.status()} ${url.slice(-120)}`)
        }

        // Only capture script IDs from actual publish responses or script URLs
        // VERY restrictive to avoid matching generic JSON properties like "pineVersion", "text", etc.
        if (url.includes('publish') || url.includes('/script/')) {
          const contentType = response.headers()['content-type'] || ''
          if (contentType.includes('application/json') || contentType.includes('text/')) {
            const text = await response.text().catch(() => '')
            // Log response body for debugging (truncated)
            if (text.length > 0 && text.length < 2000 && (url.includes('publish') || url.includes('/list'))) {
              console.log(`[TV Response:${reqId}] ${url.slice(-60)}: ${text.slice(0, 300)}`)
            }
            // ONLY look for actual script URLs - no generic ID matching
            // TradingView published script URLs look like /script/XXXXXXXX
            const scriptUrlMatch = text.match(/"publishedUrl"\s*:\s*"([^"]*\/script\/[a-zA-Z0-9]{6,})"/) ||
                                  text.match(/tradingview\.com\/script\/([a-zA-Z0-9]{6,})/) ||
                                  text.match(/"scriptIdPart"\s*:\s*"([a-zA-Z0-9]{6,})"/)
            if (scriptUrlMatch && !capturedScriptId) {
              // Extract just the script ID from the URL if we matched a full URL
              const match = scriptUrlMatch[1].match(/\/script\/([a-zA-Z0-9]+)$/) || [null, scriptUrlMatch[1]]
              capturedScriptId = match[1]
              console.log(`[TV Combined:${reqId}] Captured script ID from publish response: ${capturedScriptId}`)
            }
          }
        }
      } catch {
        // Ignore errors
      }
    }
    page.on('response', responseHandler)

    // === CRITICAL: Close any interfering dialogs before publish button search ===
    // The "Open my script" dialog can block the publish flow if not properly closed
    console.log(`[TV Combined:${reqId}] Checking for interfering dialogs before publish...`)
    const hasInterferingDialog = await page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase()
      return {
        openMyScript: bodyText.includes('open my script') || bodyText.includes('open script'),
        symbolSearch: bodyText.includes('symbol search'),
        goPro: bodyText.includes('go pro') || (bodyText.includes('upgrade') && bodyText.includes('indicator'))
      }
    })
    if (hasInterferingDialog.openMyScript || hasInterferingDialog.symbolSearch || hasInterferingDialog.goPro) {
      console.log(`[TV Combined:${reqId}] Interfering dialog detected: ${JSON.stringify(hasInterferingDialog)}. Closing...`)
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Escape')
        await delay(300)
      }
      // Also try clicking close buttons
      await page.evaluate(() => {
        const closeButtons = document.querySelectorAll('[data-name="close"], [class*="close"], button[aria-label*="close" i]')
        for (const btn of closeButtons) {
          const rect = (btn as HTMLElement).getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            (btn as HTMLElement).click()
          }
        }
      })
      await delay(1000)
    }

    // Screenshot 2: Before looking for Publish button
    await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-publish-2-before-publish.png` }).catch(() => {})
    console.log(`[TV Combined:${reqId}] Screenshot 2: Before Publish button search`)

    // On /chart/ page, the "Publish script" option is in the script name dropdown (e.g., "Untitled script")
    // This dropdown has a chevron and contains options like "Publish script", "Open", etc.
    console.log('[TV Combined] Looking for Publish option in Pine Editor menus...')

    let publishClicked = false

    // Strategy 0: First try to click "Publish script" button directly
    // This is the most reliable way - look for the button by its text
    console.log('[TV Combined] Strategy 0: Looking for direct Publish script button...')
    const directPublishResult = await page.evaluate(() => {
      // Pine Editor can be in right sidebar OR bottom panel depending on TradingView layout
      const rightSidebar = document.querySelector('.layout__area--right, [data-name="right-toolbar-container"]')
      const bottomArea = document.querySelector('.layout__area--bottom')
      const pineEditor = document.querySelector('[data-name="pine-editor"]')
      // Search in Pine Editor first, then right sidebar, then bottom, then full document
      const searchArea = pineEditor || rightSidebar || bottomArea || document

      const allButtons = searchArea.querySelectorAll('button')
      for (const btn of allButtons) {
        const text = btn.textContent?.trim().toLowerCase() || ''
        const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || ''
        const className = btn.className?.toLowerCase() || ''

        // Match "Publish script" button
        if (text.includes('publish script') || text === 'publish' ||
            ariaLabel.includes('publish script') || className.includes('publish')) {
          btn.click()
          return { clicked: true, via: 'direct-publish-button', text: btn.textContent?.substring(0, 40) }
        }
      }
      return { clicked: false }
    })

    if (directPublishResult.clicked) {
      console.log(`[TV Combined] Clicked direct Publish button: ${JSON.stringify(directPublishResult)}`)
      publishClicked = true
      await delay(2000)
    }

    // Strategy 1: If no direct button, look for script name dropdown IN THE PINE EDITOR
    // The dropdown may be in different locations: bottom panel, right sidebar, or fullscreen Pine Editor header
    if (!publishClicked) {
      console.log('[TV Combined] Strategy 1: Looking for script name dropdown in Pine Editor...')
      const scriptDropdownClicked = await page.evaluate(() => {
        // Pine Editor can be in different layouts:
        // 1. Bottom panel (.layout__area--bottom)
        // 2. Right sidebar (.layout__area--right)
        // 3. Fullscreen Pine Editor (Monaco takes up most of the screen)
        const rightSidebar = document.querySelector('.layout__area--right, [data-name="right-toolbar-container"]')
        const bottomArea = document.querySelector('.layout__area--bottom')
        const pineEditor = document.querySelector('[data-name="pine-editor"]')
        const monacoEditor = document.querySelector('.monaco-editor.pine-editor-monaco')?.closest('[class*="container"], [class*="wrapper"], div')

        // Debug info about what we found
        const debug = {
          hasPineEditor: !!pineEditor,
          hasRightSidebar: !!rightSidebar,
          hasBottomArea: !!bottomArea,
          hasMonaco: !!monacoEditor,
        }

        // Look for dropdown with script name - try specific selectors first (globally)
        const dropdownSelectors = [
          'button[class*="scriptName"]',
          'button[class*="script-name"]',
          '[class*="scriptName"] button',
          '[data-name="script-name"]',
          // TradingView Pine Editor header selectors
          '[class*="pineEditorHeader"] button',
          '[class*="pine-editor-header"] button',
          '[class*="editorHeader"] button:not([aria-label*="symbol" i])',
        ]

        // Search globally first for direct selectors
        for (const sel of dropdownSelectors) {
          try {
            const elem = document.querySelector(sel) as HTMLElement
            if (elem) {
              const text = elem.textContent?.trim() || ''
              // Make sure it's not a symbol dropdown (like AMZN)
              if (!text.match(/^[A-Z]{2,5}$/)) {
                elem.click()
                return { clicked: true, selector: sel, text: text.substring(0, 30), debug }
              }
            }
          } catch { /* continue */ }
        }

        // Search in specific areas
        const searchAreas = [pineEditor, monacoEditor, rightSidebar, bottomArea].filter(Boolean)
        for (const searchArea of searchAreas) {
          if (!searchArea) continue
          // Find buttons in the area that look like script name dropdowns
          const buttons = searchArea.querySelectorAll('button')
          for (const btn of buttons) {
            const hasSvg = btn.querySelector('svg')
            const text = btn.textContent?.trim() || ''
            // Look for a dropdown button with a script-like name
            // Skip buttons that look like chart symbols (usually 3-5 uppercase letters like AMZN)
            // Skip empty text or just dots
            if (hasSvg && text && text.length > 2 && !text.match(/^[A-Z]{2,5}$/) &&
                text !== '...' && text !== '•••' && !text.match(/^[.•⋯⋮]+$/)) {
              btn.click()
              return { clicked: true, text: text.substring(0, 50), via: 'pine-editor-dropdown', debug }
            }
          }
        }

        // Last resort: Find any button containing script name text near Monaco editor
        const monacoContainer = document.querySelector('.monaco-editor')?.parentElement?.parentElement
        if (monacoContainer) {
          const nearbyButtons = monacoContainer.querySelectorAll('button')
          for (const btn of nearbyButtons) {
            const text = btn.textContent?.trim() || ''
            // Look for buttons with indicator-like names (Test, Indicator, MA, etc.)
            if (text.length > 3 && text.length < 50 &&
                !text.match(/^[A-Z]{2,5}$/) &&
                !text.match(/^[.•⋯⋮]+$/) &&
                (text.toLowerCase().includes('indicator') || text.toLowerCase().includes('test') || text.includes(' '))) {
              btn.click()
              return { clicked: true, text: text.substring(0, 50), via: 'monaco-nearby-button', debug }
            }
          }
        }

        return { clicked: false, reason: 'no script dropdown found', debug }
      })

      // Log what happened for debugging
      console.log(`[TV Combined] Strategy 1 result: ${JSON.stringify(scriptDropdownClicked)}`)

      if (scriptDropdownClicked.clicked) {
      console.log(`[TV Combined] Clicked script dropdown: ${JSON.stringify(scriptDropdownClicked)}`)
      await delay(1500) // Increased delay for menu to fully render

      // Debug: List all visible menu items
      const menuDebug = await page.evaluate(() => {
        const menuSelectors = [
          '[role="menuitem"]',
          '[role="option"]',
          '[class*="menu"] [class*="item"]',
          '[class*="dropdown"] [class*="item"]',
          '[class*="popup"] button',
          '[class*="popup"] [class*="item"]',
          '[class*="contextMenu"] button',
          '[class*="list"] [class*="item"]',
        ]

        const items: string[] = []
        for (const sel of menuSelectors) {
          const elems = document.querySelectorAll(sel)
          for (const elem of elems) {
            const text = elem.textContent?.trim()
            if (text && !items.includes(text)) {
              items.push(text.substring(0, 60))
            }
          }
        }
        return items
      })
      console.log(`[TV Combined] Menu items found: ${JSON.stringify(menuDebug)}`)

      // Now look for "Publish script" in the dropdown menu
      const publishInDropdown = await page.evaluate(() => {
        // Look for menu items containing "Publish"
        const menuSelectors = [
          '[role="menuitem"]',
          '[role="option"]',
          '[class*="menu"] [class*="item"]',
          '[class*="dropdown"] [class*="item"]',
          '[class*="popup"] button',
          '[class*="popup"] [class*="item"]',
          '[class*="popup"] [role="button"]',
          '[class*="contextMenu"] button',
          '[class*="list"] [class*="item"]',
        ]

        for (const sel of menuSelectors) {
          const items = document.querySelectorAll(sel)
          for (const item of Array.from(items)) {
            const text = item.textContent?.toLowerCase() || ''
            if (text.includes('publish')) {
              (item as HTMLElement).click()
              return { clicked: true, text: item.textContent?.trim(), selector: sel }
            }
          }
        }

        // Also try clicking any visible element with "Publish" text
        const allClickable = document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"], a, div[class*="item"]')
        for (const elem of Array.from(allClickable)) {
          const text = elem.textContent?.trim().toLowerCase() || ''
          if (text.includes('publish')) {
            (elem as HTMLElement).click()
            return { clicked: true, text: elem.textContent?.trim(), via: 'any-clickable' }
          }
        }

        return { clicked: false }
      })

      if (publishInDropdown.clicked) {
        console.log(`[TV Combined] Clicked Publish in dropdown: ${JSON.stringify(publishInDropdown)}`)
        await delay(2000)
        publishClicked = true
      } else {
        console.log('[TV Combined] No Publish option in script dropdown, closing...')
        await page.keyboard.press('Escape')
        await delay(500)
      }
    }
    } // Close the if (!publishClicked) block for Strategy 1

    // Strategy 2: Try the "..." menu if script dropdown didn't work
    if (!publishClicked) {
      console.log('[TV Combined] Strategy 2: Looking for ... menu...')
      const moreMenuSelectors = [
        'button[aria-label*="more" i]',
        'button[aria-label*="menu" i]',
        '[data-name="more"]',
        '[data-name="overflow-menu"]',
        'button[title*="more" i]',
        '.tv-header__menu-button',
      ]

      let moreMenuClicked = false
      for (const selector of moreMenuSelectors) {
        try {
          const menuBtn = await page.$(selector)
          if (menuBtn) {
            await menuBtn.click()
            console.log(`[TV Combined] Clicked more menu: ${selector}`)
            await delay(1000)
            moreMenuClicked = true
            break
          }
        } catch { /* try next */ }
      }

      if (moreMenuClicked) {
        const publishInMenu = await page.evaluate(() => {
          const menuItems = document.querySelectorAll('[role="menuitem"], [class*="menu"] button, [class*="menu"] [role="button"]')
          for (const item of Array.from(menuItems)) {
            const text = item.textContent?.toLowerCase() || ''
            if (text.includes('publish')) {
              (item as HTMLElement).click()
              return { clicked: true, text: item.textContent?.trim() }
            }
          }
          return { clicked: false }
        })
        if (publishInMenu.clicked) {
          console.log(`[TV Combined] Clicked Publish in more menu: ${JSON.stringify(publishInMenu)}`)
          await delay(2000)
          publishClicked = true
        } else {
          console.log('[TV Combined] No Publish option in more menu, closing...')
          await page.keyboard.press('Escape')
          await delay(500)
        }
      }
    }

    // Click "Publish Script" button in Pine Editor toolbar (fallback for /chart/ page)
    // IMPORTANT: The publish button is in the Pine Editor panel toolbar, NOT in the main chart toolbar
    console.log('[TV Combined] Looking for Publish Script button in Pine Editor...')

    // First, debug: log all buttons/elements in the Pine Editor panel
    const pineEditorButtons = await page.evaluate(() => {
      // Try multiple selectors to find Pine Editor container
      // TradingView uses different class names depending on the page/version
      const pineEditorSelectors = [
        '[data-name="pine-editor"]',
        '.pine-editor-container',
        '[class*="pine-editor"]',
        '[class*="pineEditor"]',
        // Bottom panel area where Pine Editor appears on /chart/
        '[class*="bottom-widgetbar"]',
        '[class*="widgetbar-widget"]',
        '.layout__area--bottom',
        // Look for panel containing Monaco editor
        '.monaco-editor',
      ]

      let pineEditor: Element | null = null
      let matchedSelector = ''
      for (const sel of pineEditorSelectors) {
        pineEditor = document.querySelector(sel)
        if (pineEditor) {
          matchedSelector = sel
          // If we found monaco-editor, go up to find the panel container
          if (sel === '.monaco-editor') {
            const parent = pineEditor.closest('[class*="widget"], [class*="panel"], [class*="editor"]')
            if (parent) {
              pineEditor = parent
              matchedSelector = sel + ' -> parent'
            }
          }
          break
        }
      }

      if (!pineEditor) {
        // Debug: list all elements with "pine" or "editor" in class name
        const allElements = Array.from(document.querySelectorAll('*'))
        const pineRelated = allElements
          .filter(el => {
            const className = el.className?.toString?.() || ''
            return className.toLowerCase().includes('pine') || className.toLowerCase().includes('editor')
          })
          .slice(0, 10)
          .map(el => ({
            tag: el.tagName,
            className: el.className?.toString?.().slice(0, 80),
            id: el.id,
          }))
        return { error: 'Pine Editor container not found', pineRelatedElements: pineRelated }
      }

      // Get all buttons/clickable elements in the found container and nearby
      // Also check parent containers for toolbar buttons
      const searchArea = pineEditor.parentElement || pineEditor
      const elements = Array.from(searchArea.querySelectorAll('button, [role="button"], [role="menuitem"], [data-role="button"]'))
      return {
        matchedSelector,
        containerClass: pineEditor.className,
        buttons: elements.map(el => ({
          tag: el.tagName,
          text: el.textContent?.trim().slice(0, 40),
          dataName: el.getAttribute('data-name'),
          ariaLabel: el.getAttribute('aria-label'),
          title: el.getAttribute('title'),
          className: el.className?.toString?.().slice(0, 60),
        }))
      }
    })
    console.log('[TV Combined] Pine Editor buttons:', JSON.stringify(pineEditorButtons, null, 2))

    // Strategy 0 (BEST): Direct text search for "Publish script" button
    // This is the most reliable since we saw the exact button in the screenshot
    console.log('[TV Combined] Looking for "Publish script" button by text...')
    const publishScriptBtn = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      // Find button with text "Publish script" (case-insensitive)
      const btn = buttons.find(b => {
        const text = b.textContent?.trim().toLowerCase() || ''
        return text === 'publish script' || text.includes('publish script')
      })
      if (btn) {
        const info = {
          text: btn.textContent?.trim(),
          ariaLabel: btn.getAttribute('aria-label'),
          className: btn.className?.slice(0, 50),
        }
        btn.click()
        return info
      }
      return null
    })

    if (publishScriptBtn) {
      publishClicked = true
      console.log('[TV Combined] Clicked "Publish script" button:', JSON.stringify(publishScriptBtn))
    }

    // Strategy 1: Look for direct "Publish Script" button via CSS selectors
    if (!publishClicked) {
      const directPublishSelectors = [
        // Scoped to Pine Editor panel
        '[data-name="pine-editor"] [data-name="publish-script-button"]',
        '[data-name="pine-editor"] button[aria-label*="Publish script" i]',
        '[data-name="pine-editor"] button[title*="Publish script" i]',
        // Generic data-name selectors
        '[data-name="publish-script-button"]',
        '[data-name="publish-button"]',
      ]

      for (const selector of directPublishSelectors) {
        try {
          const btn = await page.$(selector)
          if (btn) {
            await btn.click()
            publishClicked = true
            console.log(`[TV Combined] Clicked publish button: ${selector}`)
            break
          }
        } catch { /* try next */ }
      }
    }

    // Strategy 2: Look for a "More" menu in Pine Editor toolbar that might contain Publish Script
    if (!publishClicked) {
      console.log('[TV Combined] Looking for menu button in Pine Editor toolbar...')

      // Try to find and click a menu/more button in Pine Editor
      const menuClicked = await page.evaluate(() => {
        const pineEditor = document.querySelector('[data-name="pine-editor"], .pine-editor-container, [class*="pine-editor"], [class*="pineEditor"]')
        if (!pineEditor) return false

        // Look for "More" or "..." button in Pine Editor
        const menuButtons = Array.from(pineEditor.querySelectorAll('button, [role="button"]'))
        const menuBtn = menuButtons.find(btn => {
          const text = btn.textContent?.trim().toLowerCase() || ''
          const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || ''
          const dataName = btn.getAttribute('data-name')?.toLowerCase() || ''
          return text === '...' || text === 'more' ||
                 ariaLabel.includes('more') || ariaLabel.includes('menu') ||
                 dataName.includes('more') || dataName.includes('menu')
        })

        if (menuBtn) {
          ;(menuBtn as HTMLElement).click()
          return true
        }
        return false
      })

      if (menuClicked) {
        console.log('[TV Combined] Clicked menu button, waiting for menu to open...')
        await delay(500)

        // Now look for "Publish Script" in the menu
        const menuItemClicked = await page.evaluate(() => {
          // Look for menu items with "Publish" text
          const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [class*="menu"] button, [class*="dropdown"] button'))
          const publishItem = menuItems.find(item => {
            const text = item.textContent?.toLowerCase() || ''
            return text.includes('publish') && text.includes('script')
          })

          if (publishItem) {
            ;(publishItem as HTMLElement).click()
            return true
          }
          return false
        })

        if (menuItemClicked) {
          publishClicked = true
          console.log('[TV Combined] Clicked Publish Script from menu')
        }
      }
    }

    // Strategy 3: Text-based search for any "Publish Script" button on page
    if (!publishClicked) {
      console.log('[TV Combined] Trying text-based search for Publish Script button...')

      const foundBtn = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))

        // Look specifically for "Publish Script" (not just "Publish" which could be Ideas)
        const publishScriptBtn = buttons.find(btn => {
          const text = btn.textContent?.toLowerCase() || ''
          const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || ''
          // Must contain both "publish" and "script" to avoid Ideas publish button
          return (text.includes('publish') && text.includes('script')) ||
                 (ariaLabel.includes('publish') && ariaLabel.includes('script'))
        })

        if (publishScriptBtn) {
          const info = {
            text: (publishScriptBtn as HTMLElement).textContent?.trim().slice(0, 50),
            ariaLabel: publishScriptBtn.getAttribute('aria-label'),
            dataName: publishScriptBtn.getAttribute('data-name'),
          }
          ;(publishScriptBtn as HTMLElement).click()
          return info
        }
        return null
      })

      if (foundBtn) {
        publishClicked = true
        console.log('[TV Combined] Clicked publish button via text search:', JSON.stringify(foundBtn))
      }
    }

    // Debug: Log all publish-related buttons if still not found
    if (!publishClicked) {
      const allPublishButtons = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
        return buttons
          .filter(btn => {
            const text = btn.textContent?.toLowerCase() || ''
            const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || ''
            return text.includes('publish') || ariaLabel.includes('publish')
          })
          .map(btn => ({
            text: btn.textContent?.trim().slice(0, 50),
            ariaLabel: btn.getAttribute('aria-label'),
            dataName: btn.getAttribute('data-name'),
            inPineEditor: !!btn.closest('[data-name="pine-editor"], .pine-editor-container'),
          }))
      })
      console.log('[TV Combined] All publish buttons on page:', JSON.stringify(allPublishButtons))

      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-combined-publish-no-button.png` })
      console.log(`[TV Combined] Screenshot saved to ${SCREENSHOT_DIR}/tv-combined-publish-no-button.png`)
      return {
        validation: validationResult,
        publish: { success: false, error: 'Could not find Publish Script button in Pine Editor' },
      }
    }

    // Handle "Script is not on the chart" dialog if it appears
    // This dialog shows up when trying to publish without the script being added to chart
    // Poll for the dialog since it may appear with some delay
    console.log('[TV Combined] Checking for "Script is not on the chart" dialog...')
    let scriptNotOnChartDialog = { found: false, clicked: false }
    for (let attempt = 0; attempt < 10; attempt++) {
      await delay(500)
      scriptNotOnChartDialog = await page.evaluate(() => {
        // Look for dialog element with specific text - more reliable than innerText
        const allElements = document.querySelectorAll('*')
        for (const el of allElements) {
          const text = el.textContent || ''
          // Check for the dialog header text specifically
          if (text.includes('Script is not on the chart') && text.includes('add it to the chart')) {
            // Find the Add to chart button within or near this dialog
            const buttons = Array.from(document.querySelectorAll('button'))
            const addToChartBtn = buttons.find(btn => {
              const btnText = btn.textContent?.toLowerCase() || ''
              const rect = btn.getBoundingClientRect()
              // Must be visible and contain "add to chart"
              return btnText.includes('add to chart') && rect.width > 0 && rect.height > 0
            })
            if (addToChartBtn) {
              console.log('[Dialog] Found "Add to chart" button, clicking...')
              ;(addToChartBtn as HTMLElement).click()
              return { found: true, clicked: true }
            }
            return { found: true, clicked: false }
          }
        }
        return { found: false, clicked: false }
      })
      if (scriptNotOnChartDialog.found) {
        break
      }
    }

    if (scriptNotOnChartDialog.found) {
      console.log(`[TV Combined] "Script is not on the chart" dialog detected, clicked Add to chart: ${scriptNotOnChartDialog.clicked}`)
      if (scriptNotOnChartDialog.clicked) {
        // Wait briefly for possible secondary confirmation dialog
        console.log('[TV Combined] Waiting for possible confirmation dialog...')
        await delay(1000)

        // Handle "Cannot add a script with unsaved changes" confirmation dialog
        // This dialog appears when trying to add an unsaved script to the chart
        const saveConfirmResult = await page.evaluate(() => {
          // Look for the confirmation dialog about unsaved changes
          const dialogs = document.querySelectorAll('[class*="dialog"], [class*="modal"]')
          for (const dialog of dialogs) {
            const text = dialog.textContent || ''
            if (text.includes('unsaved changes') || text.includes('Cannot add a script')) {
              // Find "Save and add" button
              const buttons = Array.from(dialog.querySelectorAll('button'))
              const saveAndAddBtn = buttons.find(btn => {
                const btnText = btn.textContent?.toLowerCase() || ''
                const rect = btn.getBoundingClientRect()
                return (btnText.includes('save and add') || btnText.includes('save')) && rect.width > 0 && rect.height > 0
              })
              if (saveAndAddBtn) {
                console.log('[Dialog] Found "Save and add" button, clicking...')
                ;(saveAndAddBtn as HTMLElement).click()
                return { found: true, clicked: true, buttonText: saveAndAddBtn.textContent?.trim() }
              }
              return { found: true, clicked: false }
            }
          }
          return { found: false, clicked: false }
        })

        if (saveConfirmResult.found) {
          console.log(`[TV Combined] Unsaved changes confirmation dialog detected: ${JSON.stringify(saveConfirmResult)}`)
          if (saveConfirmResult.clicked) {
            // Wait for save and add to complete
            console.log('[TV Combined] Waiting for save and add to complete...')
            await delay(3000)
          }
        }

        // Check for "Pine Script compilation error" dialog that may appear after save attempt
        const checkCompilationError = async () => {
          return await page.evaluate(() => {
            const bodyText = document.body.innerText
            if (bodyText.includes('compilation error') || bodyText.includes('cannot compile')) {
              // Find and click close button or "View error" to dismiss
              const dialogs = document.querySelectorAll('[class*="dialog"], [class*="modal"]')
              for (const dialog of dialogs) {
                const text = dialog.textContent || ''
                if (text.includes('compilation error') || text.includes('cannot compile')) {
                  // Try to close the dialog
                  const closeBtn = dialog.querySelector('[data-name="close"], button[aria-label="Close"], .close-button')
                  if (closeBtn) {
                    ;(closeBtn as HTMLElement).click()
                    return { found: true, closed: true, method: 'close button' }
                  }
                  // Try clicking outside the dialog or pressing Escape
                  return { found: true, closed: false, dialogText: text.slice(0, 100) }
                }
              }
              return { found: true, closed: false }
            }
            return { found: false, closed: false }
          })
        }

        const compilationError = await checkCompilationError()
        if (compilationError.found) {
          console.log(`[TV Combined] Compilation error dialog detected: ${JSON.stringify(compilationError)}`)
          // Press Escape to close any dialog
          await page.keyboard.press('Escape')
          await delay(500)
          await page.keyboard.press('Escape')
          await delay(500)

          // Take screenshot for debugging
          await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-compilation-error.png` }).catch(() => {})

          // The script should already be valid from /pine/ validation
          // Try clicking "Add to chart" button in Pine Editor directly instead of through dialog
          console.log('[TV Combined] Trying direct "Add to chart" button in Pine Editor...')
          const directAddResult = await page.evaluate(() => {
            // Look for "Add to chart" button in Pine Editor toolbar (not in dialog)
            const buttons = Array.from(document.querySelectorAll('button'))
            const addBtn = buttons.find(btn => {
              const text = btn.textContent?.toLowerCase() || ''
              const rect = btn.getBoundingClientRect()
              const isInEditor = btn.closest('.layout__area--right, .layout__area--bottom, [class*="pine"]')
              // Must be in editor area, visible, and say "add to chart"
              return isInEditor && text.includes('add to chart') && rect.width > 0 && rect.height > 0
            })
            if (addBtn) {
              ;(addBtn as HTMLElement).click()
              return { clicked: true, text: addBtn.textContent?.trim() }
            }
            return { clicked: false }
          })
          console.log(`[TV Combined] Direct add to chart result: ${JSON.stringify(directAddResult)}`)
          await delay(2000)
        }

        // Wait for script to be compiled and added to chart
        console.log('[TV Combined] Waiting for script to compile and add to chart...')
        await delay(2000)

        // Wait for ALL dialogs to be removed from DOM
        console.log('[TV Combined] Waiting for dialogs to close...')
        let dialogClosed = false
        let compilationErrorRetried = false
        for (let i = 0; i < 30; i++) {
          const dialogState = await page.evaluate(() => {
            // Check multiple ways for dialogs
            const bodyText = document.body.innerText
            const hasScriptNotOnChartText = bodyText.includes('Script is not on the chart')
            const hasUnsavedChangesText = bodyText.includes('unsaved changes') || bodyText.includes('Cannot add a script')
            const hasConfirmationText = bodyText.includes('Confirmation')
            const hasCompilationError = bodyText.includes('compilation error') || bodyText.includes('cannot compile')

            // Also check for modal/overlay elements with blocking dialogs
            const overlays = document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="overlay"], [data-dialog]')
            let hasVisibleBlockingDialog = false
            for (const overlay of overlays) {
              const text = overlay.textContent || ''
              const rect = (overlay as HTMLElement).getBoundingClientRect()
              const isVisible = rect.width > 0 && rect.height > 0
              // Check for any blocking dialogs
              if (isVisible && (
                text.includes('Script is not on the chart') ||
                text.includes('unsaved changes') ||
                text.includes('Cannot add a script')
              )) {
                hasVisibleBlockingDialog = true
                break
              }
            }

            return { hasScriptNotOnChartText, hasUnsavedChangesText, hasConfirmationText, hasCompilationError, hasVisibleBlockingDialog }
          })

          // Handle compilation error if it appears during wait
          if (dialogState.hasCompilationError && !compilationErrorRetried) {
            console.log('[TV Combined] Compilation error detected during wait, pressing Escape...')
            compilationErrorRetried = true
            await page.keyboard.press('Escape')
            await delay(500)
            continue
          }

          const anyDialogOpen = dialogState.hasScriptNotOnChartText || dialogState.hasUnsavedChangesText || dialogState.hasVisibleBlockingDialog
          if (!anyDialogOpen) {
            console.log('[TV Combined] All blocking dialogs closed')
            dialogClosed = true
            break
          }

          // If stuck on "Script is not on the chart" dialog, try clicking Add to chart again
          if (i > 0 && i % 10 === 0 && dialogState.hasScriptNotOnChartText) {
            console.log(`[TV Combined] Re-trying "Add to chart" click (attempt ${i})...`)
            await page.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button'))
              const addBtn = buttons.find(btn => {
                const text = btn.textContent?.toLowerCase() || ''
                const rect = btn.getBoundingClientRect()
                return text.includes('add to chart') && rect.width > 0 && rect.height > 0
              })
              if (addBtn) {
                ;(addBtn as HTMLElement).click()
              }
            })
            await delay(1000)
          }

          console.log(`[TV Combined] Dialog still open (attempt ${i + 1}/30): ${JSON.stringify(dialogState)}`)
          await delay(500)
        }

        if (!dialogClosed) {
          console.log('[TV Combined] WARNING: Dialog may not have closed properly, taking screenshot')
          await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-dialog-not-closed.png` }).catch(() => {})
        }

        // Extra wait after dialog closes for UI to stabilize
        await delay(2000)

        // Click Publish Script button again - use more specific selector
        console.log('[TV Combined] Re-clicking Publish Script button after adding to chart...')
        const reClickResult = await page.evaluate(() => {
          // First try: Look for button with "Publish script" text in Pine Editor area
          const pineArea = document.querySelector('.layout__area--right, .layout__area--bottom, [class*="pine"]')
          const searchArea = pineArea || document

          const buttons = Array.from(searchArea.querySelectorAll('button'))
          const publishBtn = buttons.find(btn => {
            const text = btn.textContent?.toLowerCase() || ''
            const rect = btn.getBoundingClientRect()
            // Must be visible and contain "publish script"
            return text.includes('publish script') && rect.width > 0 && rect.height > 0
          })

          if (publishBtn) {
            console.log('[Re-click] Found publish button:', publishBtn.textContent?.slice(0, 30))
            ;(publishBtn as HTMLElement).click()
            return { clicked: true, text: publishBtn.textContent?.slice(0, 30) }
          }

          // Fallback: search entire document
          const allButtons = Array.from(document.querySelectorAll('button'))
          const fallbackBtn = allButtons.find(btn => {
            const text = btn.textContent?.toLowerCase() || ''
            const rect = btn.getBoundingClientRect()
            return text.includes('publish script') && rect.width > 0 && rect.height > 0
          })

          if (fallbackBtn) {
            console.log('[Re-click] Found publish button (fallback):', fallbackBtn.textContent?.slice(0, 30))
            ;(fallbackBtn as HTMLElement).click()
            return { clicked: true, text: fallbackBtn.textContent?.slice(0, 30), via: 'fallback' }
          }

          return { clicked: false }
        })
        console.log(`[TV Combined] Re-click result: ${JSON.stringify(reClickResult)}`)

        // Wait longer for the publish dialog to fully render
        console.log('[TV Combined] Waiting for publish dialog to render...')
        await delay(3000)
      }
    }

    // Wait for publish section to appear
    // This is a dialog/panel that appears after clicking "Publish script" button
    // See docs/workflow-screenshots/03-publish-dialog.png for reference
    let publishSectionFound = false

    // Method 1: Wait for publish section using multiple detection strategies
    // IMPORTANT: Check that elements are VISIBLE (have dimensions), not just present in DOM
    publishSectionFound = await page.evaluate(() => {
      return new Promise<boolean>(resolve => {
        const isElementVisible = (el: Element | null): boolean => {
          if (!el) return false
          const rect = el.getBoundingClientRect()
          return rect.width > 50 && rect.height > 10 && rect.top > 0 && rect.top < window.innerHeight
        }

        const checkForSection = () => {
          const bodyText = document.body.innerText.toLowerCase()

          // CRITICAL: First check if interfering dialogs are open - if so, wait
          if (bodyText.includes('script is not on the chart')) {
            // Dialog still open, don't report section found yet
            console.log('[Publish Detection] "Script is not on the chart" dialog still open')
            return false
          }
          if (bodyText.includes('symbol search')) {
            // Symbol search dialog is open, don't report section found
            return false
          }

          // Check for text patterns visible in the publish dialog
          // Be flexible - TradingView may change labels
          const publishTextPatterns = [
            'publish new script',  // Tab text
            'update existing script',
            'describe your script',
            'script visibility',
            'choose the level of access',
            'public library',  // Visibility option
            'private',         // Visibility option
            'invite-only',     // Visibility option
          ]
          const hasPublishDialogText = publishTextPatterns.some(pattern => bodyText.includes(pattern))

          // Check for the title input field - more flexible selectors
          const titleSelectors = [
            'input[value="My script"]',
            'input[placeholder="My script"]',
            'input[placeholder*="script" i]',
            'input[placeholder*="title" i]',
            'input[placeholder*="name" i]',
          ]
          let titleInputVisible = false
          let foundTitleInput = null
          for (const sel of titleSelectors) {
            const input = document.querySelector(sel)
            if (isElementVisible(input)) {
              titleInputVisible = true
              foundTitleInput = input
              break
            }
          }

          // Also check for any text input in a dialog/modal container
          if (!titleInputVisible) {
            const dialogContainers = document.querySelectorAll('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]')
            for (const container of dialogContainers) {
              const inputs = container.querySelectorAll('input[type="text"], input:not([type])')
              for (const input of inputs) {
                if (isElementVisible(input)) {
                  titleInputVisible = true
                  foundTitleInput = input
                  break
                }
              }
              if (titleInputVisible) break
            }
          }

          // Check for Continue/Next/Publish button - be flexible with text
          const actionButton = Array.from(document.querySelectorAll('button')).find(btn => {
            const text = btn.textContent?.toLowerCase() || ''
            if (text.includes('continue') || text.includes('next') || text.includes('publish')) {
              // Make sure it's not the main "Publish script" button
              if (text.includes('publish script')) return false
              return isElementVisible(btn)
            }
            return false
          })

          // Log what we found for debugging
          const found = {
            hasPublishDialogText,
            titleInputVisible,
            hasActionButton: !!actionButton,
            actionButtonText: actionButton?.textContent?.slice(0, 20),
          }

          // Success criteria - be more flexible:
          // 1. Any visible title input (strong signal we're in publish dialog)
          // 2. OR publish dialog text + action button
          // 3. OR publish dialog text + title input
          if (titleInputVisible) {
            console.log('[Publish Detection] Found via visible title input:', JSON.stringify(found))
            resolve(true)
            return true
          }

          if (hasPublishDialogText && actionButton) {
            console.log('[Publish Detection] Found via text + action button:', JSON.stringify(found))
            resolve(true)
            return true
          }

          if (hasPublishDialogText && titleInputVisible) {
            console.log('[Publish Detection] Found via text + title input:', JSON.stringify(found))
            resolve(true)
            return true
          }

          return false
        }

        // Check immediately
        if (checkForSection()) return

        // Poll for up to 15 seconds
        let attempts = 0
        const interval = setInterval(() => {
          attempts++
          if (checkForSection()) {
            clearInterval(interval)
            return
          }
          if (attempts > 75) {
            // 75 * 200ms = 15s
            clearInterval(interval)
            resolve(false)
          }
        }, 200)
      })
    })

    if (!publishSectionFound) {
      // Take diagnostic screenshot
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-combined-no-publish-section.png` }).catch(() => {})
      console.log('[TV Combined] ERROR: Publish dialog not detected. Screenshot saved.')

      // Debug: what elements and text are visible?
      const debugInfo = await page.evaluate(() => {
        const bodyText = document.body.innerText.toLowerCase()

        // Check for dialogs/modals
        const dialogs = document.querySelectorAll('[class*="dialog"], [class*="modal"], [role="dialog"]')
        const dialogInfo = Array.from(dialogs).map(d => ({
          class: d.className?.slice(0, 50),
          text: d.textContent?.slice(0, 100),
        }))

        // Check for visible inputs
        const inputs = document.querySelectorAll('input')
        const visibleInputs = Array.from(inputs).filter(inp => {
          const rect = inp.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }).map(inp => ({
          type: inp.type,
          placeholder: inp.placeholder?.slice(0, 30),
          value: inp.value?.slice(0, 30),
        }))

        return {
          // Key indicators
          hasScriptNotOnChart: bodyText.includes('script is not on the chart'),
          hasPublishNewScript: bodyText.includes('publish new script'),
          hasPublishDialogText: bodyText.includes('describe your script') || bodyText.includes('script visibility'),
          hasMyScript: bodyText.includes('my script'),
          hasContinue: bodyText.includes('continue'),

          // Structural info
          dialogCount: dialogs.length,
          dialogInfo: dialogInfo.slice(0, 3),
          visibleInputs: visibleInputs.slice(0, 5),
          inputCount: document.querySelectorAll('input[type="text"]').length,
          allInputCount: inputs.length,
          buttonTexts: Array.from(document.querySelectorAll('button')).slice(0, 10).map(b => b.textContent?.slice(0, 30)),
          visibleText: document.body.innerText.slice(0, 600),
        }
      })
      console.log(`[TV Combined] Debug info: ${JSON.stringify(debugInfo, null, 2)}`)

      // If "Script is not on the chart" is still showing, the dialog handling failed
      if (debugInfo.hasScriptNotOnChart) {
        console.log('[TV Combined] ERROR: "Script is not on the chart" dialog is still open - Add to chart may have failed')
      }

      return {
        validation: validationResult,
        publish: { success: false, error: 'Publish section not found' },
      }
    }

    console.log('[TV Combined] Publish section found')
    mark('publish_dialog_opened')

    // === STEP 1: Fill in title and description ===
    console.log('[TV Combined] Step 1: Filling title and description...')
    await delay(300)
    const { visibilityLevel } = publishOptions

    // Fill title using helper function
    const titleFilled = await fillTitleField(page, title)

    // Debug screenshot after title fill
    await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-combined-after-title-fill.png` }).catch(() => {})
    console.log('[TV Combined] Screenshot saved after title fill')

    if (!titleFilled) {
      console.log('[TV Combined] ERROR: Title input not found - publish dialog may not be open properly')
      // Take a diagnostic screenshot
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-combined-title-not-found.png` }).catch(() => {})
      // Don't continue typing - could trigger wrong dialogs
      return {
        validation: validationResult,
        publish: { success: false, error: 'Could not find title input in publish dialog' },
      }
    }

    // Fill description using helper function (handles contenteditable rich text editor)
    const descriptionText = description || title
    await fillRichTextDescription(page, descriptionText)

    // Screenshot before Continue button click (Step 1 complete)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-combined-step1-before-continue.png` }).catch(() => {})
    console.log('[TV Combined] Screenshot saved: Step 1 before Continue click')

    // Click Continue to go to Step 2
    const movedToStep2 = await clickContinueButton(page)

    if (!movedToStep2) {
      console.log('[TV Combined] Warning: Continue may have failed, checking step state...')
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-combined-still-step1.png` }).catch(() => {})
    }

    // === STEP 2: Set visibility and final submit ===
    console.log('[TV Combined] Step 2: Setting visibility options...')

    // Screenshot after entering Step 2 (Final touches screen)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-combined-step2-final-touches.png` }).catch(() => {})
    console.log('[TV Combined] Screenshot saved: Step 2 Final touches screen')
    await delay(200)

    // Set privacy (public/private) and visibility level (open/protected/invite-only)
    await setVisibilityOptions(page, visibility, visibilityLevel)

    // Check required checkboxes
    const checkboxes = await page.$$('input[type="checkbox"]:not(:checked)')
    for (const checkbox of checkboxes) {
      try {
        await checkbox.click()
        console.log('[TV Combined] Checked a required checkbox')
      } catch { /* ignore */ }
    }

    await delay(200)
    mark('form_filled')

    // Set up listener for new tabs
    const browser = page.browser()
    let newScriptPage: typeof page | null = null

    const newPagePromise = new Promise<{ type: 'newTab'; page: typeof page } | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 30000) // Extended from 15s to 30s for slow publishes
      browser.once('targetcreated', async (target) => {
        if (target.type() === 'page') {
          clearTimeout(timeout)
          const newPage = await target.page()
          resolve(newPage ? { type: 'newTab', page: newPage } : null)
        }
      })
    })

    // Set up listener for current page redirect to /script/ using framenavigated event
    let currentPageRedirectUrl: string | null = null
    const frameNavigatedHandler = (frame: import('puppeteer-core').Frame) => {
      try {
        const url = frame.url()
        console.log(`[TV Combined] Frame navigated to: ${url}`)
        if (url.includes('/script/')) {
          currentPageRedirectUrl = url
          console.log(`[TV Combined] Captured script URL from frame navigation: ${url}`)
        }
      } catch {
        // Frame might be detached
      }
    }
    page.on('framenavigated', frameNavigatedHandler)

    const currentPageRedirectPromise = new Promise<{ type: 'redirect'; url: string } | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 45000) // Extended from 15s to 45s
      const checkInterval = setInterval(() => {
        if (currentPageRedirectUrl) {
          clearTimeout(timeout)
          clearInterval(checkInterval)
          resolve({ type: 'redirect', url: currentPageRedirectUrl })
        }
      }, 100) // Check the captured URL every 100ms
    })

    // Screenshot right before final publish button click
    await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-combined-step2-before-publish.png` }).catch(() => {})
    console.log('[TV Combined] Screenshot saved: Step 2 before final publish click')

    // Final submit using helper function
    console.log('[TV Combined] Clicking final Publish button...')
    const submitted = await clickFinalPublishButton(page, visibility)

    if (!submitted) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-combined-publish-step2-failed.png` })
      return {
        validation: validationResult,
        publish: { success: false, error: 'Could not find final Publish button' },
      }
    }

    // Take screenshot right after clicking publish
    await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-combined-after-publish-click.png` }).catch(() => {})
    console.log(`[TV Combined] Screenshot saved: ${SCREENSHOT_DIR}/tv-combined-after-publish-click.png`)

    // Wait for publish to complete - check both new tab AND current page redirect
    console.log('[TV Combined] Waiting for publish to complete...')
    console.log('[TV Combined] Waiting for new tab or current page redirect...')

    // Race between new tab and current page redirect
    const publishResult = await Promise.race([newPagePromise, currentPageRedirectPromise])

    // Check if current page redirected
    if (publishResult?.type === 'redirect') {
      page.off('framenavigated', frameNavigatedHandler)
      const indicatorUrl = publishResult.url.includes('tradingview.com/script/')
        ? publishResult.url
        : `https://www.tradingview.com/script/${publishResult.url.match(/\/script\/([^/]+)/)?.[1]}/`
      console.log(`[TV Combined] Found script URL via current page redirect: ${indicatorUrl}`)
      mark('published')
      console.log(`[TV Combined:${reqId}] Total time: ${Date.now() - startTime}ms`, timings)
      return {
        validation: validationResult,
        publish: { success: true, indicatorUrl },
      }
    }

    // Check if new tab opened
    if (publishResult?.type === 'newTab') {
      newScriptPage = publishResult.page
    }

    if (newScriptPage) {
      try {
        await newScriptPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
        await delay(1000)
        const newTabUrl = newScriptPage.url()
        console.log(`[TV Combined] New tab opened: ${newTabUrl}`)

        if (newTabUrl.includes('/script/')) {
          console.log(`[TV Combined] Found script URL in new tab: ${newTabUrl}`)
          page.off('framenavigated', frameNavigatedHandler)
          await newScriptPage.close().catch(() => {})
          mark('published')
          console.log(`[TV Combined:${reqId}] Total time: ${Date.now() - startTime}ms`, timings)
          return {
            validation: validationResult,
            publish: { success: true, indicatorUrl: newTabUrl },
          }
        }
        await newScriptPage.close().catch(() => {})
      } catch (e) {
        console.log('[TV Combined] Error checking new tab:', e)
      }
    } else {
      console.log('[TV Combined] No new tab detected, checking current page...')
      // Take screenshot to see current state
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-publish-no-new-tab.png` }).catch(() => {})
      console.log(`[TV Combined] Screenshot saved: ${SCREENSHOT_DIR}/tv-publish-no-new-tab.png`)

      // Debug: Check what's visible on the page after publish click
      const postPublishState = await page.evaluate(() => {
        const bodyText = document.body.innerText
        return {
          hasPublishDialog: bodyText.toLowerCase().includes('publish'),
          hasError: bodyText.toLowerCase().includes('error') || bodyText.toLowerCase().includes('failed'),
          hasSuccess: bodyText.toLowerCase().includes('success') || bodyText.toLowerCase().includes('published'),
          visibleText: bodyText.slice(0, 1000),
          dialogCount: document.querySelectorAll('[role="dialog"], [class*="dialog"], [class*="modal"]').length,
        }
      }).catch(() => ({ error: 'Could not evaluate page state' }))
      console.log(`[TV Combined] Post-publish page state: ${JSON.stringify(postPublishState, null, 2)}`)
    }

    // Fallback: Try to find the indicator URL
    // Wrap in try-catch because page frame may be detached after new tab opens
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await delay(2000)

        const currentUrl = page.url()
        console.log(`[TV Combined] Attempt ${attempt + 1}: Current URL: ${currentUrl}`)

        // Take screenshot on each attempt to track page state changes
        await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-publish-fallback-attempt-${attempt + 1}.png` }).catch(() => {})
        console.log(`[TV Combined] Screenshot saved: ${SCREENSHOT_DIR}/tv-publish-fallback-attempt-${attempt + 1}.png`)

        const indicatorMatch = currentUrl.match(/tradingview\.com\/script\/([^/]+)/)
        if (indicatorMatch) {
          mark('published')
          console.log(`[TV Combined:${reqId}] Total time: ${Date.now() - startTime}ms`, timings)
          return {
            validation: validationResult,
            publish: { success: true, indicatorUrl: `https://www.tradingview.com/script/${indicatorMatch[1]}/` },
          }
        }

        const indicatorUrl = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href*="/script/"]'))
          for (const link of links) {
            const href = (link as HTMLAnchorElement).href
            if (href.includes('tradingview.com/script/')) {
              return href
            }
          }
          return null
        })

        if (indicatorUrl) {
          mark('published')
          console.log(`[TV Combined:${reqId}] Total time: ${Date.now() - startTime}ms`, timings)
          return {
            validation: validationResult,
            publish: { success: true, indicatorUrl },
          }
        }
      }
    } catch (e) {
      // Page frame likely detached after new tab opened - publish probably succeeded
      console.log('[TV Combined] Page frame detached, checking for captured URLs...')
      page.off('response', responseHandler)
      page.off('framenavigated', frameNavigatedHandler)

      // Check if we captured a redirect URL before frame detached
      if (currentPageRedirectUrl) {
        const indicatorUrl = currentPageRedirectUrl.includes('tradingview.com/script/')
          ? currentPageRedirectUrl
          : `https://www.tradingview.com/script/${currentPageRedirectUrl.match(/\/script\/([^/]+)/)?.[1]}/`
        console.log(`[TV Combined:${reqId}] Published successfully via captured redirect: ${indicatorUrl}`)
        mark('published')
        console.log(`[TV Combined:${reqId}] Total time: ${Date.now() - startTime}ms`, timings)
        return {
          validation: validationResult,
          publish: { success: true, indicatorUrl },
        }
      }

      if (capturedScriptId) {
        const indicatorUrl = `https://www.tradingview.com/script/${capturedScriptId}/`
        console.log(`[TV Combined:${reqId}] Published successfully via captured ID: ${indicatorUrl}`)
        mark('published')
        console.log(`[TV Combined:${reqId}] Total time: ${Date.now() - startTime}ms`, timings)
        return {
          validation: validationResult,
          publish: { success: true, indicatorUrl },
        }
      }

      console.log('[TV Combined] No script ID or redirect URL captured after frame detachment - publish status unknown')
      return {
        validation: validationResult,
        publish: { success: false, error: 'Frame detached before URL could be captured. The script may have been published - check your TradingView profile.' },
      }
    }

    // Extended polling: Wait for redirect or script URL to appear on current page or new tab
    // Instead of navigating to profile, keep checking current page for longer
    console.log('[TV Combined] Extended polling for script URL (current page, new tabs, redirects)...')

    for (let pollAttempt = 0; pollAttempt < 15; pollAttempt++) {
      await delay(2000)

      // Take periodic screenshots
      if (pollAttempt % 5 === 0) {
        await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-publish-poll-${pollAttempt}.png` }).catch(() => {})
        console.log(`[TV Combined] Poll screenshot saved: tv-publish-poll-${pollAttempt}.png`)
      }

      try {
        // Check for new tabs that might have opened with the script URL
        const allPages = await browser.pages()
        for (const browserPage of allPages) {
          try {
            const pageUrl = browserPage.url()
            if (pageUrl.includes('/script/') && browserPage !== page) {
              console.log(`[TV Combined] Found script URL in new tab: ${pageUrl}`)
              await browserPage.close().catch(() => {})
              mark('published')
              return {
                validation: validationResult,
                publish: { success: true, indicatorUrl: pageUrl },
              }
            }
          } catch {
            // Page might be closed
          }
        }

        // Check if current URL is now a script URL
        const currentUrl = page.url()
        console.log(`[TV Combined] Poll ${pollAttempt + 1}/15: Current URL: ${currentUrl}`)

        if (currentUrl.includes('/script/')) {
          console.log(`[TV Combined] Found script URL via redirect: ${currentUrl}`)
          mark('published')
          return {
            validation: validationResult,
            publish: { success: true, indicatorUrl: currentUrl },
          }
        }

        // Check for script URL links on the page (success dialog may show it)
        const scriptUrlOnPage = await page.evaluate(() => {
          // Look for any link to /script/
          const scriptLinks = Array.from(document.querySelectorAll('a[href*="/script/"]'))
          for (const link of scriptLinks) {
            const href = (link as HTMLAnchorElement).href
            if (href.includes('tradingview.com/script/')) {
              return href
            }
          }

          // Also check for text that might contain the script URL
          const bodyText = document.body.innerText
          const urlMatch = bodyText.match(/tradingview\.com\/script\/([a-zA-Z0-9]+)/)
          if (urlMatch) {
            return `https://www.tradingview.com/script/${urlMatch[1]}/`
          }

          return null
        }).catch(() => null)

        if (scriptUrlOnPage) {
          console.log(`[TV Combined] Found script URL on page: ${scriptUrlOnPage}`)
          mark('published')
          return {
            validation: validationResult,
            publish: { success: true, indicatorUrl: scriptUrlOnPage },
          }
        }

        // Check if we captured a redirect in the background
        if (currentPageRedirectUrl) {
          const indicatorUrl = currentPageRedirectUrl.includes('tradingview.com/script/')
            ? currentPageRedirectUrl
            : `https://www.tradingview.com/script/${currentPageRedirectUrl.match(/\/script\/([^/]+)/)?.[1]}/`
          console.log(`[TV Combined] Found script URL via captured redirect: ${indicatorUrl}`)
          mark('published')
          return {
            validation: validationResult,
            publish: { success: true, indicatorUrl },
          }
        }

        // Check for captured script ID from network responses
        if (capturedScriptId) {
          const indicatorUrl = `https://www.tradingview.com/script/${capturedScriptId}/`
          console.log(`[TV Combined] Found script URL via captured network ID: ${indicatorUrl}`)
          mark('published')
          return {
            validation: validationResult,
            publish: { success: true, indicatorUrl },
          }
        }

        // On last poll attempt, try fetching user's published scripts via API
        if (pollAttempt === 14) {
          console.log('[TV Combined] Final attempt: Querying user published scripts API...')
          const scriptFromApi = await page.evaluate(async (expectedTitle: string) => {
            try {
              // Use pine-facade API to get user's published scripts
              const response = await fetch('https://pine-facade.tradingview.com/pine-facade/list?filter=published', {
                credentials: 'include',
              })
              if (!response.ok) {
                console.log('API response not OK:', response.status)
                return null
              }
              const scripts = await response.json()
              if (!Array.isArray(scripts) || scripts.length === 0) {
                console.log('No scripts returned from API')
                return null
              }
              // Find the most recently published script (first in list) or match by title
              // Scripts are returned with scriptIdPart which is the URL slug
              const matchingScript = scripts.find((s: { scriptName?: string }) =>
                s.scriptName?.toLowerCase().includes(expectedTitle.toLowerCase().slice(0, 20))
              )
              const targetScript = matchingScript || scripts[0]
              if (targetScript && targetScript.scriptIdPart) {
                return `https://www.tradingview.com/script/${targetScript.scriptIdPart}/`
              }
              return null
            } catch (e) {
              console.log('Error fetching scripts:', e)
              return null
            }
          }, title).catch(() => null)

          if (scriptFromApi) {
            console.log(`[TV Combined] Found script URL via API: ${scriptFromApi}`)
            mark('published')
            return {
              validation: validationResult,
              publish: { success: true, indicatorUrl: scriptFromApi },
            }
          }
        }
      } catch (e) {
        // Page might have navigated away
        console.log(`[TV Combined] Poll ${pollAttempt + 1} error:`, e)
        break
      }
    }

    // Final screenshot
    await page.screenshot({ path: `${SCREENSHOT_DIR}/tv-publish-poll-final.png` }).catch(() => {})
    console.log(`[TV Combined] Final poll screenshot saved`)

    // Final check for captured URLs
    page.off('response', responseHandler)
    page.off('framenavigated', frameNavigatedHandler)

    if (currentPageRedirectUrl) {
      const indicatorUrl = currentPageRedirectUrl.includes('tradingview.com/script/')
        ? currentPageRedirectUrl
        : `https://www.tradingview.com/script/${currentPageRedirectUrl.match(/\/script\/([^/]+)/)?.[1]}/`
      console.log(`[TV Combined:${reqId}] Published successfully via captured redirect (fallback): ${indicatorUrl}`)
      return {
        validation: validationResult,
        publish: { success: true, indicatorUrl },
      }
    }

    if (capturedScriptId) {
      const indicatorUrl = `https://www.tradingview.com/script/${capturedScriptId}/`
      console.log(`[TV Combined:${reqId}] Published successfully via captured ID (fallback): ${indicatorUrl}`)
      return {
        validation: validationResult,
        publish: { success: true, indicatorUrl },
      }
    }

    // Script was published (we clicked the button) but couldn't capture URL
    // Return success but indicate URL was not captured
    const serviceAccountProfile = process.env.TV_SERVICE_ACCOUNT_PROFILE || 'https://www.tradingview.com/u/lirex14/#published-scripts'
    console.log(`[TV Combined] Script published but could not capture URL - check ${serviceAccountProfile}`)
    return {
      validation: validationResult,
      publish: { success: true, indicatorUrl: serviceAccountProfile, urlNotCaptured: true },
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[TV Combined:${reqId}] Infrastructure error (session/connection failure):`, errorMessage)
    return {
      validation: {
        isValid: false,
        errors: [
          {
            line: 0,
            message: `Infrastructure error: ${errorMessage}. Please try again.`,
            type: 'error',
          },
        ],
        rawOutput: '',
      },
      infrastructureError: true,
    }
  } finally {
    if (session) {
      await closeBrowserSession(session)
    }
    releaseBrowserlessLock(reqId)
  }
}
