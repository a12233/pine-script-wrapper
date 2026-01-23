import { randomUUID } from 'crypto'
import {
  createBrowserSession,
  closeBrowserSession,
  injectCookies,
  waitForElement,
  navigateTo,
  type BrowserlessSession,
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
    descriptionInput: 'textarea[name="description"]',
    privateRadio: 'input[value="private"]',
    submitButton: 'button[type="submit"]',
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
      await page.screenshot({ path: '/tmp/tv-login-debug.png' })
      console.log('[TV] Screenshot saved to /tmp/tv-login-debug.png')
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
        await page.screenshot({ path: '/tmp/tv-login-captcha-timeout.png' })
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
      await page.screenshot({ path: '/tmp/tv-login-failed.png' })
      console.log('[TV] Screenshot saved to /tmp/tv-login-failed.png')
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
        await page.screenshot({ path: '/tmp/tv-login-captcha-timeout.png' })
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
        await page.screenshot({ path: '/tmp/tv-pine-editor-not-found.png' })
        console.log('[TV] Screenshot saved to /tmp/tv-pine-editor-not-found.png')
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
      await page.screenshot({ path: '/tmp/tv-pine-page-no-editor.png' })
      console.log('[TV v2] Screenshot saved to /tmp/tv-pine-page-no-editor.png')
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

export interface PublishOptions {
  script: string
  title: string
  description: string
  visibility?: 'public' | 'private' // Default: 'public'
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
      await page.screenshot({ path: '/tmp/tv-chart-publish-no-button.png' })
      console.log('[TV Publish] Screenshot saved to /tmp/tv-chart-publish-no-button.png')
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

    // Wait a moment for the dialog to fully render
    await delay(500)

    // Fill title - clear first then type
    const titleSelectors = [TV_SELECTORS.publish.titleInput, 'input[name="title"]', 'input[placeholder*="title" i]', 'input[type="text"]']
    let titleFilled = false
    for (const sel of titleSelectors) {
      try {
        const input = await page.$(sel)
        if (input) {
          await input.click()
          await delay(100)
          // Clear existing content using keyboard
          await page.keyboard.down('Control')
          await page.keyboard.press('a')
          await page.keyboard.up('Control')
          await delay(50)
          await page.keyboard.type(title, { delay: 10 })
          titleFilled = true
          console.log(`[TV Publish] Title filled: "${title}" using: ${sel}`)
          break
        }
      } catch { /* try next */ }
    }
    if (!titleFilled) {
      console.log('[TV Publish] Warning: Could not find title input')
    }

    // Fill description - use title as description if none provided
    // (User requested description should be the script name/title)
    const descriptionText = description || title
    console.log(`[TV Publish] Will fill description with: "${descriptionText}"`)

    // The description is a rich text editor below the title
    // Simplest approach: Tab from title to description and type
    let descFilled = false

    // Method 1: Tab from title to description
    console.log('[TV Publish] Trying Tab key to move to description...')
    await page.keyboard.press('Tab')
    await delay(150)
    await page.keyboard.type(descriptionText, { delay: 5 })

    // Verify by checking if there's text in a contenteditable
    descFilled = await page.evaluate(() => {
      const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      return editables.some(el => el.textContent && el.textContent.length > 0)
    })

    if (descFilled) {
      console.log('[TV Publish] Description filled via Tab key')
    } else {
      // Method 2: Click directly into the editor area (large black area)
      console.log('[TV Publish] Tab method may have failed, trying direct click...')

      // Find the editor container by looking for the element after the toolbar
      const clicked = await page.evaluate((text) => {
        // Look for contenteditable elements
        const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'))
        for (const el of editables) {
          const rect = el.getBoundingClientRect()
          // Description area should be taller and below the title
          if (rect.height > 50 && rect.top > 100) {
            (el as HTMLElement).click()
            (el as HTMLElement).focus()
            return true
          }
        }

        // Try finding by placeholder text
        const placeholder = document.querySelector('[data-placeholder*="escribe"]') ||
                           document.querySelector('[placeholder*="escribe"]')
        if (placeholder && typeof (placeholder as HTMLElement).click === 'function') {
          (placeholder as HTMLElement).click()
          if (typeof (placeholder as HTMLElement).focus === 'function') {
            (placeholder as HTMLElement).focus()
          }
          return true
        }

        return false
      }, descriptionText)

      if (clicked) {
        await delay(200)
        await page.keyboard.type(descriptionText, { delay: 5 })
        descFilled = true
        console.log('[TV Publish] Description filled via direct click')
      }
    }

    if (!descFilled) {
      // Method 3: Click by coordinates (description area is roughly in the middle of dialog)
      console.log('[TV Publish] Trying coordinate-based click...')
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
        // Click in the middle of the description area (below title, above Continue button)
        const clickX = dialogBox.x + dialogBox.width / 2
        const clickY = dialogBox.y + dialogBox.height / 2
        await page.mouse.click(clickX, clickY)
        await delay(200)
        await page.keyboard.type(descriptionText, { delay: 5 })
        descFilled = true
        console.log(`[TV Publish] Description filled via coordinates (${clickX}, ${clickY})`)
      }
    }

    if (!descFilled) {
      // Take a debug screenshot
      await page.screenshot({ path: '/tmp/tv-publish-desc-failed.png' })
      console.log('[TV Publish] Warning: Could not find description input - screenshot saved')
    }

    // Click "Continue" button to go to step 2
    console.log('[TV Publish] Clicking Continue to go to step 2...')
    const continueSelectors = [
      'button[class*="continue" i]',
      'button[type="submit"]',
      '[data-name="continue-button"]',
    ]

    let continuedToStep2 = false
    for (const sel of continueSelectors) {
      try {
        const btn = await page.$(sel)
        if (btn) {
          await btn.click()
          continuedToStep2 = true
          console.log(`[TV Publish] Clicked Continue: ${sel}`)
          break
        }
      } catch { /* try next */ }
    }

    // Fallback: find button by text
    if (!continuedToStep2) {
      continuedToStep2 = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'))
        const btn = buttons.find(b => b.textContent?.toLowerCase().includes('continue'))
        if (btn) {
          btn.click()
          return true
        }
        return false
      })
      if (continuedToStep2) {
        console.log('[TV Publish] Clicked Continue via text search')
      }
    }

    if (!continuedToStep2) {
      console.log('[TV Publish] Warning: Could not find Continue button')
    }

    // Wait for step 2 to load
    await delay(1000)

    // === STEP 2: Set visibility and final submit ===
    console.log('[TV Publish] Step 2: Setting visibility options...')

    // First, dismiss any popup overlays (like "Ad blocker detected")
    console.log('[TV Publish] Checking for popup overlays...')
    await page.evaluate(() => {
      // Look for ad blocker or other popups and try to close them
      const closeButtons = document.querySelectorAll('[class*="close"], [aria-label*="close" i], [class*="dismiss"], button[class*="x"]')
      for (const btn of closeButtons) {
        const rect = (btn as HTMLElement).getBoundingClientRect()
        // Only click if visible and likely a popup close button
        if (rect.width > 0 && rect.height > 0 && rect.width < 50) {
          (btn as HTMLElement).click()
        }
      }

      // Try clicking outside popups to dismiss them
      const overlays = document.querySelectorAll('[class*="overlay"], [class*="backdrop"], [class*="modal-bg"]')
      for (const overlay of overlays) {
        (overlay as HTMLElement).click()
      }

      // Specifically look for ad blocker popup and close it
      const adBlockerPopup = document.querySelector('[class*="adblocker"], [class*="ad-blocker"]')
      if (adBlockerPopup) {
        const parent = adBlockerPopup.parentElement
        if (parent) {
          parent.remove()
        }
      }
    })
    await delay(200)

    // Select visibility (public or private)
    const visibility = options.visibility || 'public'
    console.log(`[TV Publish] Selecting ${visibility} visibility...`)

    const visibilitySelected = await page.evaluate((targetVisibility) => {
      // Look for visibility options - try to click the target visibility
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], [class*="tab"], label'))
      for (const btn of buttons) {
        const text = btn.textContent?.toLowerCase() || ''
        if (text === targetVisibility || text.includes(targetVisibility)) {
          (btn as HTMLElement).click()
          return true
        }
      }

      // Try radio buttons
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
      for (const radio of radios) {
        const value = (radio as HTMLInputElement).value?.toLowerCase() || ''
        const label = radio.closest('label')?.textContent?.toLowerCase() || ''
        if (value === targetVisibility || label.includes(targetVisibility)) {
          (radio as HTMLInputElement).click()
          return true
        }
      }

      return false
    }, visibility)

    if (visibilitySelected) {
      console.log(`[TV Publish] Selected ${visibility} visibility`)
    } else {
      console.log(`[TV Publish] Warning: Could not find ${visibility} visibility option`)
    }
    await delay(150)

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

    // Final submit - look for "publish private script" button specifically
    console.log('[TV Publish] Clicking final Publish button...')

    // First, try to find the specific publish button (public or private)
    let submitted = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      // Look for "publish script" button (public, private, or generic)
      const btn = buttons.find(b => {
        const text = b.textContent?.toLowerCase() || ''
        // Match "publish public script", "publish private script", or just "publish script"
        return text.includes('publish') && text.includes('script')
      })
      if (btn) {
        btn.click()
        return true
      }
      return false
    })

    if (submitted) {
      console.log('[TV Publish] Clicked publish script button')
    } else {
      // Try generic selectors
      const submitSelectors = [
        TV_SELECTORS.publish.submitButton,
        'button[class*="submit" i]',
        'button[type="submit"]',
      ]

      for (const sel of submitSelectors) {
        try {
          const btn = await page.$(sel)
          if (btn) {
            await btn.click()
            submitted = true
            console.log(`[TV Publish] Clicked submit: ${sel}`)
            break
          }
        } catch { /* try next */ }
      }
    }

    // Fallback: find any button containing "Publish" (but not "Continue")
    if (!submitted) {
      submitted = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'))
        const btn = buttons.find(b => {
          const text = b.textContent?.toLowerCase() || ''
          return text.includes('publish') && !text.includes('continue')
        })
        if (btn) {
          btn.click()
          return true
        }
        return false
      })
      if (submitted) {
        console.log('[TV Publish] Clicked Publish via text search')
      }
    }

    if (!submitted) {
      // Take screenshot for debugging
      await page.screenshot({ path: '/tmp/tv-publish-step2-failed.png' })
      console.log('[TV Publish] Screenshot saved to /tmp/tv-publish-step2-failed.png')
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
    await page.screenshot({ path: '/tmp/tv-publish-no-url.png' })
    console.log('[TV Publish] Screenshot saved to /tmp/tv-publish-no-url.png')

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
      await page.screenshot({ path: '/tmp/tv-pine-publish-no-editor.png' })
      console.log('[TV Publish v2] Screenshot saved to /tmp/tv-pine-publish-no-editor.png')
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
      await page.screenshot({ path: '/tmp/tv-pine-publish-no-button.png' })
      console.log('[TV Publish v2] Screenshot saved to /tmp/tv-pine-publish-no-button.png')
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

    // Wait for publish dialog
    await delay(2000)

    // Fill publish form
    console.log('[Warm Validate] Filling publish form...')

    // Try to find and fill title field
    const titleSelectors = [
      'input[name="title"]',
      'input[placeholder*="title" i]',
      'input[data-name="title"]',
    ]

    for (const selector of titleSelectors) {
      try {
        const input = await page.$(selector)
        if (input) {
          await input.click({ clickCount: 3 }) // Select all
          await input.type(title)
          console.log(`[Warm Validate] Filled title: ${selector}`)
          break
        }
      } catch {
        // Try next
      }
    }

    // Try to find and fill description field
    const descSelectors = [
      'textarea[name="description"]',
      'textarea[placeholder*="description" i]',
      'textarea[data-name="description"]',
    ]

    for (const selector of descSelectors) {
      try {
        const textarea = await page.$(selector)
        if (textarea) {
          await textarea.click({ clickCount: 3 })
          await textarea.type(description)
          console.log(`[Warm Validate] Filled description: ${selector}`)
          break
        }
      } catch {
        // Try next
      }
    }

    // Set visibility if private
    if (visibility === 'private') {
      try {
        const privateOption = await page.$('input[value="private"], input[name*="private" i], label:has-text("Private") input')
        if (privateOption) {
          await privateOption.click()
          console.log('[Warm Validate] Set visibility to private')
        }
      } catch {
        console.log('[Warm Validate] Could not find private visibility option')
      }
    }

    await delay(500)

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

    // Click submit button
    const submitSelectors = [
      'button[type="submit"]',
      'button[data-name="submit"]',
      'button:has-text("Publish")',
    ]

    let submitClicked = false
    for (const selector of submitSelectors) {
      try {
        const btn = await page.$(selector)
        if (btn) {
          await btn.click()
          submitClicked = true
          console.log(`[Warm Validate] Clicked submit: ${selector}`)
          break
        }
      } catch {
        // Try next
      }
    }

    if (!submitClicked) {
      // Try clicking any button with "Publish" text
      submitClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'))
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() || ''
          if (text.includes('publish') && !text.includes('cancel')) {
            btn.click()
            return true
          }
        }
        return false
      })
      if (submitClicked) {
        console.log('[Warm Validate] Clicked submit via text search')
      }
    }

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
    await page.screenshot({ path: '/tmp/warm-publish-no-url.png' }).catch(() => {})
    console.log('[Warm Validate] Screenshot saved to /tmp/warm-publish-no-url.png')
    page.off('response', responseHandler)
    return {
      validation: validationResult,
      publish: { success: false, error: 'Could not retrieve script URL after publish. The script may have been published - check your TradingView profile.' },
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
  },
  requestId?: string
): Promise<ValidateAndPublishResult> {
  const reqId = requestId || randomUUID().slice(0, 8)

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

    console.log('[TV Combined] Checking if Pine Editor is already open...')
    await delay(3000) // Wait for page to fully load

    // Check if Pine Editor is already open
    const pineEditorVisible = await waitForElement(page, TV_SELECTORS.pineEditor.container, 5000)
    if (!pineEditorVisible) {
      console.log('[TV Combined] Pine Editor not open, looking for open button...')

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
            console.log(`[TV Combined] Found Pine Editor button with selector: ${selector}`)
            await button.click()
            buttonFound = true
            break
          }
        } catch (e) {
          console.log(`[TV Combined] Selector ${selector} failed, trying next...`)
        }
      }

      if (!buttonFound) {
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
          console.log('[TV Combined] Clicked Pine button via title/aria-label search')
          buttonFound = true
        }
      }

      // Wait for Pine Editor to appear - try all selectors in parallel
      console.log('[TV Combined] Waiting for Pine Editor to load...')

      // Try multiple selectors for Pine Editor container - in parallel
      const pineEditorSelectors = [
        '[data-name="pine-editor"]',
        '.pine-editor-container',
        '[data-role="panel-Pine"]',
        '[id*="pine"]',
        '.monaco-editor',
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
        delay(15000).then(() => null),
      ])

      if (winningSelector) {
        console.log(`[TV Combined] Pine Editor found with selector: ${winningSelector}`)
        editorOpened = true
      }

      if (!editorOpened) {
        await page.screenshot({ path: '/tmp/tv-combined-pine-editor-not-found.png' })
        console.log('[TV Combined] Screenshot saved to /tmp/tv-combined-pine-editor-not-found.png')
        throw new Error('Could not open Pine Editor')
      }
      console.log('[TV Combined] Pine Editor opened successfully')
    } else {
      console.log('[TV Combined] Pine Editor already open')
    }

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

    // Wait for compilation
    await delay(3000)

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

    // If validation failed or no publish options, return just validation result
    if (!validationResult.isValid || !publishOptions) {
      return { validation: validationResult }
    }

    // === PUBLISH PHASE (reusing same session) ===
    console.log(`[TV Combined:${reqId}] Validation passed, proceeding to publish in same session...`)

    const { title, description, visibility = 'public' } = publishOptions

    // Set up network response capture to get script ID from API response
    let capturedScriptId: string | null = null
    const responseHandler = async (response: import('puppeteer-core').HTTPResponse) => {
      try {
        const url = response.url()
        const status = response.status()
        if (status < 200 || status >= 300) return
        if (url.includes('.js') || url.includes('.css') || url.includes('.png')) return

        // Check for publish-related API responses
        if (url.includes('/pine_facade/') || url.includes('/script/') || url.includes('publish')) {
          const contentType = response.headers()['content-type'] || ''
          if (contentType.includes('application/json') || contentType.includes('text/')) {
            const text = await response.text().catch(() => '')
            // Look for script ID patterns in response
            const idMatch = text.match(/"id"\s*:\s*"([a-zA-Z0-9]+)"/) ||
                          text.match(/"scriptId"\s*:\s*"([a-zA-Z0-9]+)"/) ||
                          text.match(/"idScript"\s*:\s*"([a-zA-Z0-9]+)"/) ||
                          text.match(/\/script\/([a-zA-Z0-9]+)/) ||
                          text.match(/"publishedUrl"\s*:\s*"[^"]*\/script\/([a-zA-Z0-9]+)/)
            if (idMatch && !capturedScriptId) {
              capturedScriptId = idMatch[1]
              console.log(`[TV Combined:${reqId}] Captured script ID from API: ${capturedScriptId}`)
            }
          }
        }
      } catch {
        // Ignore errors
      }
    }
    page.on('response', responseHandler)

    // Click "Add to chart" to verify the script compiles correctly
    console.log('[TV Combined] Clicking "Add to chart" to verify script...')
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
          console.log(`[TV Combined] Clicked "Add to chart": ${selector}`)
          break
        }
      } catch {
        // Try next selector
      }
    }

    if (!addToChartClicked) {
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
        console.log('[TV Combined] Clicked "Add to chart" via text search')
      }
    }

    await delay(1500)

    // Click publish button
    console.log('[TV Combined] Looking for publish button...')
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
          console.log(`[TV Combined] Clicked publish button: ${selector}`)
          break
        }
      } catch {
        // Try next selector
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
      if (publishClicked) {
        console.log('[TV Combined] Clicked publish button via text search')
      }
    }

    if (!publishClicked) {
      await page.screenshot({ path: '/tmp/tv-combined-publish-no-button.png' })
      console.log('[TV Combined] Screenshot saved to /tmp/tv-combined-publish-no-button.png')
      return {
        validation: validationResult,
        publish: { success: false, error: 'Could not find publish button' },
      }
    }

    // Wait for publish dialog
    await waitForElement(page, TV_SELECTORS.publish.dialog, 10000)

    // === STEP 1: Fill in title and description ===
    console.log('[TV Combined] Step 1: Filling title and description...')
    await delay(500)

    // Fill title
    const titleSelectors = [TV_SELECTORS.publish.titleInput, 'input[name="title"]', 'input[placeholder*="title" i]', 'input[type="text"]']
    for (const sel of titleSelectors) {
      try {
        const input = await page.$(sel)
        if (input) {
          await input.click()
          await delay(100)
          await page.keyboard.down('Control')
          await page.keyboard.press('a')
          await page.keyboard.up('Control')
          await delay(50)
          await page.keyboard.type(title, { delay: 10 })
          console.log(`[TV Combined] Title filled: "${title}" using: ${sel}`)
          break
        }
      } catch { /* try next */ }
    }

    // Fill description
    const descriptionText = description || title
    console.log(`[TV Combined] Will fill description with: "${descriptionText}"`)

    console.log('[TV Combined] Trying Tab key to move to description...')
    await page.keyboard.press('Tab')
    await delay(150)
    await page.keyboard.type(descriptionText, { delay: 5 })

    let descFilled = await page.evaluate(() => {
      const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      return editables.some(el => el.textContent && el.textContent.length > 0)
    })

    if (descFilled) {
      console.log('[TV Combined] Description filled via Tab key')
    } else {
      console.log('[TV Combined] Tab method may have failed, trying direct click...')
      const clicked = await page.evaluate(() => {
        const editables = Array.from(document.querySelectorAll('[contenteditable="true"]'))
        for (const el of editables) {
          const rect = el.getBoundingClientRect()
          if (rect.height > 50 && rect.top > 100) {
            (el as HTMLElement).click()
            (el as HTMLElement).focus()
            return true
          }
        }
        return false
      })

      if (clicked) {
        await delay(200)
        await page.keyboard.type(descriptionText, { delay: 5 })
        descFilled = true
        console.log('[TV Combined] Description filled via direct click')
      }
    }

    // Click "Continue" button to go to step 2
    console.log('[TV Combined] Clicking Continue to go to step 2...')
    let continuedToStep2 = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const btn = buttons.find(b => b.textContent?.toLowerCase().includes('continue'))
      if (btn) {
        btn.click()
        return true
      }
      return false
    })
    if (continuedToStep2) {
      console.log('[TV Combined] Clicked Continue via text search')
    }

    await delay(1000)

    // === STEP 2: Set visibility and final submit ===
    console.log('[TV Combined] Step 2: Setting visibility options...')

    // Dismiss any popup overlays
    console.log('[TV Combined] Checking for popup overlays...')
    await page.evaluate(() => {
      const closeButtons = document.querySelectorAll('[class*="close"], [aria-label*="close" i], [class*="dismiss"]')
      for (const btn of closeButtons) {
        const rect = (btn as HTMLElement).getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0 && rect.width < 50) {
          (btn as HTMLElement).click()
        }
      }
    })
    await delay(200)

    // Select visibility
    console.log(`[TV Combined] Selecting ${visibility} visibility...`)
    const visibilitySelected = await page.evaluate((targetVisibility) => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], [class*="tab"], label'))
      for (const btn of buttons) {
        const text = btn.textContent?.toLowerCase() || ''
        if (text === targetVisibility || text.includes(targetVisibility)) {
          (btn as HTMLElement).click()
          return true
        }
      }

      const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
      for (const radio of radios) {
        const value = (radio as HTMLInputElement).value?.toLowerCase() || ''
        const label = radio.closest('label')?.textContent?.toLowerCase() || ''
        if (value === targetVisibility || label.includes(targetVisibility)) {
          (radio as HTMLInputElement).click()
          return true
        }
      }

      return false
    }, visibility)

    if (visibilitySelected) {
      console.log(`[TV Combined] Selected ${visibility} visibility`)
    }
    await delay(150)

    // Check required checkboxes
    const checkboxes = await page.$$('input[type="checkbox"]:not(:checked)')
    for (const checkbox of checkboxes) {
      try {
        await checkbox.click()
        console.log('[TV Combined] Checked a required checkbox')
      } catch { /* ignore */ }
    }

    await delay(200)

    // Set up listener for new tabs
    const browser = page.browser()
    let newScriptPage: typeof page | null = null

    const newPagePromise = new Promise<typeof page | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 15000)
      browser.once('targetcreated', async (target) => {
        if (target.type() === 'page') {
          clearTimeout(timeout)
          const newPage = await target.page()
          resolve(newPage || null)
        }
      })
    })

    // Final submit
    console.log('[TV Combined] Clicking final Publish button...')
    let submitted = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const btn = buttons.find(b => {
        const text = b.textContent?.toLowerCase() || ''
        return text.includes('publish') && text.includes('script')
      })
      if (btn) {
        btn.click()
        return true
      }
      return false
    })

    if (submitted) {
      console.log('[TV Combined] Clicked publish script button')
    } else {
      submitted = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'))
        const btn = buttons.find(b => {
          const text = b.textContent?.toLowerCase() || ''
          return text.includes('publish') && !text.includes('continue')
        })
        if (btn) {
          btn.click()
          return true
        }
        return false
      })
      if (submitted) {
        console.log('[TV Combined] Clicked Publish via text search')
      }
    }

    if (!submitted) {
      await page.screenshot({ path: '/tmp/tv-combined-publish-step2-failed.png' })
      return {
        validation: validationResult,
        publish: { success: false, error: 'Could not find final Publish button' },
      }
    }

    // Wait for publish to complete
    console.log('[TV Combined] Waiting for publish to complete...')
    console.log('[TV Combined] Waiting for new tab with published script...')
    newScriptPage = await newPagePromise

    if (newScriptPage) {
      try {
        await newScriptPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
        await delay(1000)
        const newTabUrl = newScriptPage.url()
        console.log(`[TV Combined] New tab opened: ${newTabUrl}`)

        if (newTabUrl.includes('/script/')) {
          console.log(`[TV Combined] Found script URL in new tab: ${newTabUrl}`)
          await newScriptPage.close().catch(() => {})
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
    }

    // Fallback: Try to find the indicator URL
    // Wrap in try-catch because page frame may be detached after new tab opens
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await delay(2000)

        const currentUrl = page.url()
        console.log(`[TV Combined] Attempt ${attempt + 1}: Current URL: ${currentUrl}`)

        const indicatorMatch = currentUrl.match(/tradingview\.com\/script\/([^/]+)/)
        if (indicatorMatch) {
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
          return {
            validation: validationResult,
            publish: { success: true, indicatorUrl },
          }
        }
      }
    } catch (e) {
      // Page frame likely detached after new tab opened - publish probably succeeded
      console.log('[TV Combined] Page frame detached, checking for captured script ID...')
      page.off('response', responseHandler)

      if (capturedScriptId) {
        const indicatorUrl = `https://www.tradingview.com/script/${capturedScriptId}/`
        console.log(`[TV Combined:${reqId}] Published successfully via captured ID: ${indicatorUrl}`)
        return {
          validation: validationResult,
          publish: { success: true, indicatorUrl },
        }
      }

      console.log('[TV Combined] No script ID captured after frame detachment - publish status unknown')
      return {
        validation: validationResult,
        publish: { success: false, error: 'Frame detached before URL could be captured. The script may have been published - check your TradingView profile.' },
      }
    }

    // Fallback: Navigate to user's scripts page
    console.log('[TV Combined] Trying to find script URL from user profile...')
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
        console.log(`[TV Combined] Found script URL from profile: ${scriptUrl}`)
        return {
          validation: validationResult,
          publish: { success: true, indicatorUrl: scriptUrl },
        }
      }
    } catch (e) {
      console.log('[TV Combined] Failed to navigate to profile:', e)
    }

    // Final check for captured script ID
    page.off('response', responseHandler)
    if (capturedScriptId) {
      const indicatorUrl = `https://www.tradingview.com/script/${capturedScriptId}/`
      console.log(`[TV Combined:${reqId}] Published successfully via captured ID (fallback): ${indicatorUrl}`)
      return {
        validation: validationResult,
        publish: { success: true, indicatorUrl },
      }
    }

    console.log('[TV Combined] Could not retrieve script URL after publish attempt')
    return {
      validation: validationResult,
      publish: { success: false, error: 'Could not retrieve script URL after publish. The script may have been published - check your TradingView profile.' },
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
