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
const TV_SELECTORS = {
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

    // Wait for sidebar to render, then immediately click Pine Editor button.
    // CRITICAL: TradingView's React app re-renders the DOM rapidly after initial load.
    // The pine-dialog-button may only exist briefly before being replaced, so we must
    // click it the moment waitForSelector resolves — any delay (even checking other
    // selectors) risks the element being gone.
    console.log('[TV] Waiting for chart page sidebar to render...')
    const pineDialogBtn = await page.waitForSelector(
      '[data-name="pine-dialog-button"], [data-name="open-pine-editor"]',
      { timeout: 60000 }
    ).catch(() => null)

    if (pineDialogBtn) {
      // Check if Pine Editor is already open before clicking
      const alreadyOpen = await page.$('.monaco-editor')
      if (alreadyOpen) {
        console.log('[TV] Pine Editor already open')
      } else {
        const btnName = await pineDialogBtn.evaluate(el => el.getAttribute('data-name'))
        console.log(`[TV] Found sidebar button: ${btnName}, clicking immediately...`)
        await pineDialogBtn.click()
        console.log('[TV] Clicked Pine Editor button, waiting for Monaco editor...')
      }
    } else {
      console.log('[TV] No sidebar button found in 60s, trying fallback selectors...')
      // Fallback: try text/attribute-based search
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
        console.log('[TV] Clicked Pine button via title/aria-label fallback')
      } else {
        // Log what's actually on the page for debugging
        const pageInfo = await page.evaluate(() => ({
          panels: Array.from(document.querySelectorAll('[data-role*="panel"]')).map(el => el.getAttribute('data-role')),
          dataNames: Array.from(document.querySelectorAll('[data-name]')).slice(0, 20).map(el => el.getAttribute('data-name')),
        }))
        console.log('[TV] Page elements:', JSON.stringify(pageInfo, null, 2))
        await page.screenshot({ path: '/tmp/tv-pine-editor-not-found.png' })
        console.log('[TV] Screenshot saved to /tmp/tv-pine-editor-not-found.png')
        throw new Error('Could not open Pine Editor - no sidebar button found')
      }
    }

    // Wait for Monaco editor to appear (generous timeout for cold start)
    const monacoFound = await waitForElement(page, '.monaco-editor', 30000)
    if (!monacoFound) {
      const pageInfo = await page.evaluate(() => ({
        panels: Array.from(document.querySelectorAll('[data-role*="panel"]')).map(el => el.getAttribute('data-role')),
        dataNames: Array.from(document.querySelectorAll('[data-name]')).slice(0, 20).map(el => el.getAttribute('data-name')),
      }))
      console.log('[TV] Page elements after click:', JSON.stringify(pageInfo, null, 2))
      await page.screenshot({ path: '/tmp/tv-pine-editor-not-found.png' })
      console.log('[TV] Screenshot saved to /tmp/tv-pine-editor-not-found.png')
      throw new Error('Could not open Pine Editor - Monaco editor did not appear after clicking button')
    }
    console.log('[TV] Pine Editor opened successfully')

    // Wait for Monaco editor to be ready (30s for cold start on shared CPU VM)
    console.log('[TV] Waiting for Monaco editor...')
    await waitForElement(page, TV_SELECTORS.pineEditor.editorArea, 30000)
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

    // Wait for Monaco editor to be ready (30s for cold start on shared CPU VM)
    console.log('[TV v2] Waiting for Monaco editor...')
    const editorReady = await waitForElement(page, TV_SELECTORS.pineEditorPage.editorArea, 30000)
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
 * Publish a Pine Script as a private indicator.
 * When existingSession is provided (warm path), skips browser launch,
 * navigation, Pine Editor setup, script insertion, and "Add to chart" —
 * all of those were already done during validation.
 */
export async function publishPineScript(
  credentials: TVCredentials,
  options: PublishOptions,
  existingSession?: BrowserlessSession,
  needsSetup?: boolean
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

  // Three modes:
  // 1. existingSession + !needsSetup: warm session with script already loaded (skip all setup)
  // 2. existingSession + needsSetup: warm browser tab but fresh page (skip browser launch, do full page setup)
  // 3. no existingSession: cold path (launch browser + full page setup)
  const usingWarmSession = !!existingSession && !needsSetup
  const usingWarmTab = !!existingSession && !!needsSetup
  if (usingWarmSession) {
    console.log('[TV Publish] Using warm session (skipping browser setup, script insertion, add-to-chart)')
  } else if (usingWarmTab) {
    console.log('[TV Publish] Using warm browser tab (skipping browser launch, doing full page setup)')
  } else {
    if (USE_PINE_EDITOR_PAGE) {
      console.log('[TV Publish] Using /chart/ page for publishing (publish workflow not yet supported on /pine/)')
    }
    console.log('[TV Publish] Using /chart/ page for publishing (cold browser)')
  }

  let session: BrowserlessSession | null = null
  // Don't close the session if it was passed in (warm path owns it)
  const shouldCloseSession = !existingSession

  try {
    if (existingSession) {
      session = existingSession
    } else {
      session = await createBrowserSession()
    }
    const { page } = session

    if (!usingWarmSession) {
      // Cold path: full setup required
      // Inject cookies
      const cookies = parseTVCookies(credentials)
      await injectCookies(page, cookies)

      // Navigate to TradingView chart
      await navigateTo(page, TV_URLS.chart)
      console.log('[TV Publish] Navigated to chart, waiting for page load...')
      await delay(1500)

      // Wait for sidebar buttons to render (they appear before the chart fully loads)
      // 60s timeout for cold starts after warm browser shutdown on 2GB VM
      const sidebarReady = await waitForElement(page, '[data-name="pine-dialog-button"], [data-name="open-pine-editor"]', 60000)
      if (!sidebarReady) {
        throw new Error('Sidebar buttons did not render in 60s — TradingView page may not have loaded correctly')
      }

      // Open Pine Editor if not already open
      const pineEditorVisible = await waitForElement(page, TV_SELECTORS.pineEditor.container, 5000)
      if (!pineEditorVisible) {
        console.log('[TV Publish] Pine Editor not open, looking for button...')

        // Use the known-working selectors: open-pine-editor (if previously opened), pine-dialog-button (sidebar toggle)
        const pineButtonSelectors = ['[data-name="open-pine-editor"]', '[data-name="pine-dialog-button"]']
        let clicked = false
        for (const sel of pineButtonSelectors) {
          const btn = await page.$(sel)
          if (btn) {
            await btn.click()
            console.log(`[TV Publish] Clicked Pine button: ${sel}`)
            clicked = true
            break
          }
        }

        if (clicked) {
          // Wait for Monaco editor to load (longer timeout for cold start)
          const editorOpened = await waitForElement(page, '.monaco-editor', 30000)
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
    }
    // === From here, both warm and cold paths converge ===
    // Optimized publish flow: batches DOM operations into minimal page.evaluate()
    // calls to reduce Puppeteer IPC round-trips (~8 calls vs ~50+ before).

    const DIALOG_SEL = '[data-dialog-name="publish-script"]'

    // PRE-PUBLISH: Ensure clean chart state (only our script on chart)
    // The page.evaluate() indicator removal used during validation doesn't actually
    // work (JS dispatch doesn't trigger TradingView's React event handlers).
    // Use puppeteer native hover+click to reliably remove all indicators first,
    // then re-add our script. This prevents the "not on chart" / upgrade modals
    // that block the publish dialog.
    console.log('[TV Publish] Pre-publish cleanup: removing all indicators via puppeteer...')

    // First dismiss any modals that may be blocking the chart (upgrade modal from validation's "Add to chart")
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      for (const b of btns) {
        const t = (b as HTMLElement).textContent?.toLowerCase().trim() || ''
        if (t === 'not now' || t === 'maybe later' || t === 'no, thanks' || t === 'close' || t === 'ok' || t === 'cancel') {
          ;(b as HTMLElement).click()
          return
        }
      }
      // Also try close buttons by aria-label
      const closeButtons = Array.from(document.querySelectorAll('[aria-label="Close" i], [data-name="close"]'))
      for (const el of closeButtons) {
        const rect = (el as HTMLElement).getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) { ;(el as HTMLElement).click(); return }
      }
    }).catch(() => {})
    await delay(2000)

    let preRemoved = 0
    for (let i = 0; i < 20; i++) {
      const deleteBtn = await page.$('[data-qa-id="legend-delete-action"]')
      if (!deleteBtn) break
      try {
        // Use Promise.race with timeout to prevent hover from hanging on covered elements
        const hoverWithTimeout = Promise.race([
          deleteBtn.hover(),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('hover timeout')), 5000)),
        ])
        await hoverWithTimeout.catch(() => {})
        await delay(300)
        const clickWithTimeout = Promise.race([
          deleteBtn.click(),
          new Promise<void>((_, reject) => setTimeout(() => reject(new Error('click timeout')), 5000)),
        ])
        await clickWithTimeout
        preRemoved++
        await delay(500)
        // Dismiss any modal that appears during deletion (upgrade, etc.)
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
          for (const b of btns) {
            const t = (b as HTMLElement).textContent?.toLowerCase().trim() || ''
            if (t === 'not now' || t === 'maybe later' || t === 'no, thanks' || t === 'close' || t === 'ok' || t === 'cancel') {
              ;(b as HTMLElement).click()
              return
            }
          }
        }).catch(() => {})
      } catch {
        // If hover/click timed out (modal blocking), dismiss modal and retry
        console.log(`[TV Publish] Pre-publish: indicator ${i} blocked — dismissing modal`)
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
          for (const b of btns) {
            const t = (b as HTMLElement).textContent?.toLowerCase().trim() || ''
            if (t === 'not now' || t === 'maybe later' || t === 'no, thanks' || t === 'close' || t === 'ok' || t === 'cancel') {
              ;(b as HTMLElement).click()
              return
            }
          }
        }).catch(() => {})
        await delay(1000)
      }
    }
    if (preRemoved > 0) {
      console.log(`[TV Publish] Pre-publish: removed ${preRemoved} indicator(s)`)
      await delay(1000)
    }

    // Re-add script to chart (Pine Editor must be open from validation)
    const addToChartSels = ['[title*="Add to chart" i]', '[data-name="add-script-to-chart"]', '[aria-label*="Add to chart" i]']
    let preAdded = false
    for (const sel of addToChartSels) {
      const btn = await page.$(sel)
      if (btn) {
        await btn.click()
        console.log(`[TV Publish] Pre-publish: added to chart via ${sel}`)
        preAdded = true
        break
      }
    }
    if (!preAdded) {
      // Pine Editor may have closed when we removed its indicator — re-open it
      console.log('[TV Publish] Pre-publish: "Add to chart" not found, checking Pine Editor...')
      const editorOpen = await page.$('.monaco-editor')
      if (!editorOpen) {
        console.log('[TV Publish] Pre-publish: re-opening Pine Editor...')
        for (const sel of ['[data-name="open-pine-editor"]', '[data-name="pine-dialog-button"]']) {
          const btn = await page.$(sel)
          if (btn) {
            await btn.click()
            console.log(`[TV Publish] Pre-publish: clicked ${sel}`)
            await waitForElement(page, '.monaco-editor', 15000)
            break
          }
        }
        await delay(2000)
      }
      // Retry add-to-chart
      for (const sel of addToChartSels) {
        const btn = await page.$(sel)
        if (btn) {
          await btn.click()
          console.log(`[TV Publish] Pre-publish: added to chart via ${sel} (after re-open)`)
          preAdded = true
          break
        }
      }
    }
    if (preAdded) {
      await delay(3000) // Wait for "Add to chart" to complete + compile
      // Handle upgrade modal if it appears (shouldn't since we removed all indicators)
      const hasUpgradeAfterAdd = await page.evaluate(() => {
        const containers = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="overlay"], [class*="popup"]'))
        for (const c of containers) {
          const rect = (c as HTMLElement).getBoundingClientRect()
          if (rect.width < 100 || rect.height < 50) continue
          const text = c.textContent?.toLowerCase() || ''
          if (text.includes('more indicators') || text.includes('upgrade your plan') || text.includes('maximum available') || text.includes('upgrade now')) {
            return true
          }
        }
        return false
      })
      if (hasUpgradeAfterAdd) {
        console.log('[TV Publish] Pre-publish: upgrade modal after add — something went wrong with removal')
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
          for (const b of btns) {
            const t = (b as HTMLElement).textContent?.toLowerCase().trim() || ''
            if (t === 'not now' || t === 'maybe later' || t === 'no, thanks') {
              ;(b as HTMLElement).click()
              return
            }
          }
        }).catch(() => {})
        await delay(2000)
      }
    }

    // STEP 1: Click publish button in Pine Editor panel
    // IMPORTANT: Must scope search to Pine Editor to avoid clicking the chart
    // toolbar's generic "Publish" button (which opens idea publishing, not script publishing).
    console.log('[TV Publish] Clicking publish button...')
    const publishButtonResult = await page.evaluate(() => {
      // TradingView Pine Editor uses data-qa-id (not data-name) for button identification
      const selectors = [
        '[data-qa-id="publish-script"]',          // Primary: Pine Editor publish button
        '[data-name="publish-script-button"]',     // Legacy fallback
        '[data-name="save-publish-button"]',       // Legacy fallback
      ]
      for (const sel of selectors) {
        const btn = document.querySelector(sel) as HTMLElement
        if (btn) { btn.click(); return sel }
      }

      // Scope fallback searches to Pine Editor panel to avoid chart toolbar
      const pineEditor = document.querySelector('[data-name="pine-editor"]')
        || document.querySelector('#pine-editor-dialog')
        || document.querySelector('[class*="pine-editor"]')
      const searchRoot = pineEditor || document

      // Attribute search within Pine Editor
      const allBtns = Array.from(searchRoot.querySelectorAll('button, [role="button"]'))
      const byAttr = allBtns.find(btn => {
        const qaId = btn.getAttribute('data-qa-id')?.toLowerCase() || ''
        const aria = btn.getAttribute('aria-label')?.toLowerCase() || ''
        const title = btn.getAttribute('title')?.toLowerCase() || ''
        return qaId.includes('publish') || aria.includes('publish') || title.includes('publish')
      })
      if (byAttr) { (byAttr as HTMLElement).click(); return `attr-in-pine:${byAttr.getAttribute('data-qa-id') || byAttr.getAttribute('aria-label') || byAttr.getAttribute('title')}` }

      // Text search within Pine Editor only (exclude "continue", "idea")
      const byText = allBtns.find(btn => {
        const text = btn.textContent?.toLowerCase() || ''
        return text.includes('publish') && !text.includes('continue') && !text.includes('idea')
      })
      if (byText) { (byText as HTMLElement).click(); return 'text-in-pine' }

      // Debug: log Pine Editor button info to help diagnose
      const btnInfo = allBtns.slice(0, 20).map(b => ({
        text: b.textContent?.trim().substring(0, 40),
        dataName: b.getAttribute('data-name'),
        dataQaId: b.getAttribute('data-qa-id'),
        ariaLabel: b.getAttribute('aria-label'),
      }))
      console.log('[TV Publish] Pine Editor buttons:', JSON.stringify(btnInfo))

      return null
    })

    if (!publishButtonResult) {
      await page.screenshot({ path: '/data/screenshots/tv-chart-publish-no-button.png' }).catch(() => {})
      return { success: false, error: 'Could not find publish button in Pine Editor' }
    }
    console.log(`[TV Publish] Clicked publish button: ${publishButtonResult}`)

    // After clicking publish button, check what happened.
    // The publish button should open a dialog directly, but on some TradingView
    // versions it may require saving the script first, or open a menu.
    await delay(2000)

    // Check if a dropdown/menu appeared (common pattern: the publish button
    // opens a menu with options like "Publish Script...", "Manage Scripts...")
    const menuResult = await page.evaluate(() => {
      // Also check if dialog already appeared (no menu needed)
      const dialog = document.querySelector('[data-dialog-name="publish-script"]')
      if (dialog) return { found: 'dialog-direct' }

      // Look for any recently appeared menus/dropdowns/popups
      const menuSelectors = [
        '[class*="menuWrap"]',
        '[class*="dropdown"]',
        '[class*="popup"]',
        '[role="menu"]',
        '[role="listbox"]',
        '[data-name*="menu"]',
      ]
      for (const sel of menuSelectors) {
        const menus = Array.from(document.querySelectorAll(sel))
        for (const menu of menus) {
          const rect = (menu as HTMLElement).getBoundingClientRect()
          if (rect.width < 10 || rect.height < 10) continue

          // Search ALL descendants (not just specific roles) for "publish" text
          const allDescendants = Array.from(menu.querySelectorAll('*'))
          // Find clickable-looking elements with "publish" in text
          for (const el of allDescendants) {
            const text = el.textContent?.toLowerCase() || ''
            if (!text.includes('publish')) continue
            // Skip if it has children with "publish" (prefer leaf/near-leaf nodes)
            const childrenWithPublish = Array.from(el.children).filter(c =>
              c.textContent?.toLowerCase().includes('publish')
            )
            if (childrenWithPublish.length > 0) continue

            // This is a leaf-level element with "publish" text — click it
            ;(el as HTMLElement).click()
            return { found: 'menu-item', text: el.textContent?.trim(), menuSel: sel }
          }

          // Menu found but no "publish" text — dump details for debugging
          const allChildren = Array.from(menu.querySelectorAll('*'))
          const childTexts = allChildren
            .filter(c => {
              const t = c.textContent?.trim()
              return t && t.length > 0 && t.length < 100
            })
            .map(c => ({
              tag: c.tagName,
              text: c.textContent?.trim().substring(0, 60),
              class: c.className?.toString().substring(0, 60),
              role: c.getAttribute('role'),
              dataName: c.getAttribute('data-name'),
            }))
            .slice(0, 20)
          return {
            found: 'menu-no-publish',
            items: childTexts,
            menuSel: sel,
            menuRect: { w: rect.width, h: rect.height, x: rect.x, y: rect.y },
            menuHtml: (menu as HTMLElement).innerHTML.substring(0, 500),
            menuChildCount: menu.children.length,
          }
        }
      }

      return { found: 'nothing' }
    })

    console.log(`[TV Publish] After click: ${JSON.stringify(menuResult)}`)

    if (menuResult.found === 'menu-item') {
      // Clicked a menu item — now wait for dialog or save prompt
      console.log(`[TV Publish] Clicked menu item: "${menuResult.text}"`)
    } else if (menuResult.found === 'menu-no-publish') {
      // A menu appeared but no "publish script" option
      console.log(`[TV Publish] Menu found but no publish option. Items: ${JSON.stringify((menuResult as any).items)}`)
      await page.screenshot({ path: '/data/screenshots/tv-publish-menu-debug.png' }).catch(() => {})
    } else if (menuResult.found === 'nothing') {
      // No menu, no dialog — take screenshot for debugging
      await page.screenshot({ path: '/data/screenshots/tv-publish-after-click.png' }).catch(() => {})
    }
    // If 'dialog-direct', the dialog is already open — proceed

    // STEP 1b: Handle "Unsaved script changes" modal
    // TradingView requires scripts to be saved before publishing.
    // If the script is unsaved, a modal appears with "Save script" button.
    await delay(2000)
    const saveModalResult = await page.evaluate(() => {
      // Check for the "Unsaved script changes" modal
      // Look for modal with "Save script" or "Save" button
      const allButtons = Array.from(document.querySelectorAll('button'))
      const saveBtn = allButtons.find(btn => {
        const text = btn.textContent?.toLowerCase() || ''
        return text.includes('save script') || text === 'save'
      })
      if (saveBtn) {
        // Verify it's in a modal context (not the Pine Editor toolbar save button)
        const parent = saveBtn.closest('[class*="modal"], [class*="dialog"], [class*="overlay"], [role="dialog"]')
        if (parent) {
          saveBtn.click()
          return { found: 'save-modal', text: saveBtn.textContent?.trim() }
        }
        // Also check if there's nearby text about "unsaved" or "save changes"
        const nearbyText = saveBtn.parentElement?.textContent?.toLowerCase() || ''
        if (nearbyText.includes('unsaved') || nearbyText.includes('save your changes') || nearbyText.includes('continue publishing')) {
          saveBtn.click()
          return { found: 'save-prompt', text: saveBtn.textContent?.trim() }
        }
      }

      // Also check for publish dialog (might have appeared directly)
      const dialog = document.querySelector('[data-dialog-name="publish-script"]')
      if (dialog) return { found: 'dialog-already' }

      return { found: 'nothing' }
    })

    console.log(`[TV Publish] Save check: ${JSON.stringify(saveModalResult)}`)

    if (saveModalResult.found === 'save-modal' || saveModalResult.found === 'save-prompt') {
      console.log(`[TV Publish] Clicked "${saveModalResult.text}" — waiting for save dialog...`)
      await delay(5000)

      // Check if publish dialog appeared directly (no save needed after all)
      const dialogAppearedEarly = await page.evaluate((sel: string) => {
        return !!document.querySelector(sel)
      }, DIALOG_SEL)

      if (dialogAppearedEarly) {
        console.log('[TV Publish] Publish dialog appeared directly after save click — skipping save flow')
      }

      // Handle save-as dialog (only if publish dialog didn't appear directly)
      // The save-as dialog (class "popupDialog") has a name input and Save/Cancel buttons.
      // The input is pre-filled with the script's indicator() name (e.g. "Test Indicator").
      // We just need to click "Save" — no need to retype the name.
      const saveDialogResult = !dialogAppearedEarly ? await page.evaluate((fallbackName: string) => {
        // Find the save-as popup dialog (small dialog with Save/Cancel buttons)
        const containers = Array.from(document.querySelectorAll(
          '[class*="popupDialog"], [class*="dialog-qyCw0PaN"], [role="dialog"], [class*="modal"]'
        ))
        for (const container of containers) {
          const rect = (container as HTMLElement).getBoundingClientRect()
          if (rect.width < 100 || rect.height < 50) continue
          const buttons = Array.from(container.querySelectorAll('button'))
          const saveBtn = buttons.find(b => b.textContent?.trim().toLowerCase() === 'save')
          const cancelBtn = buttons.find(b => b.textContent?.trim().toLowerCase() === 'cancel')
          if (!saveBtn || !cancelBtn) continue // Not the save-as dialog

          // Found the save-as dialog! Check input value
          const input = container.querySelector('input[type="text"], input:not([type])') as HTMLInputElement
          if (input && !input.value.trim()) {
            // Input is empty — fill with fallback name using native setter for React
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            if (nativeSetter) nativeSetter.call(input, fallbackName)
            else input.value = fallbackName
            input.dispatchEvent(new Event('input', { bubbles: true }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
          }
          const inputValue = input?.value || '(no input found)'

          // Click Save
          saveBtn.click()
          return { found: true, inputValue, clicked: 'save' }
        }

        // No save-as dialog found — maybe save completed directly?
        return { found: false }
      }, title || 'Pine Script') : { found: false } as { found: boolean }

      if (!dialogAppearedEarly) {
        console.log(`[TV Publish] Save dialog result: ${JSON.stringify(saveDialogResult)}`)

        if (saveDialogResult.found) {
          await delay(5000) // Wait for save to complete (network request)
        } else {
          console.log('[TV Publish] No save-as dialog found — save may have completed directly')
          await delay(2000)
        }

        // Dismiss any remaining modals (e.g., "unsaved changes" might reappear)
        await page.evaluate(() => {
          const allButtons = Array.from(document.querySelectorAll('button'))
          for (const btn of allButtons) {
            const text = btn.textContent?.toLowerCase() || ''
            const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || ''
            if (ariaLabel.includes('close') || text === '×' || text === 'x') {
              const parent = btn.closest('[role="dialog"], [class*="modal"], [class*="overlay"]')
              if (parent) {
                btn.click()
                break
              }
            }
          }
        })
        await delay(1000)

        // After saving, re-trigger the publish flow
        console.log('[TV Publish] Re-clicking publish after save...')
        await page.evaluate(() => {
          const btn = document.querySelector('[data-qa-id="publish-script"]') as HTMLElement
          if (btn) btn.click()
        })
        await delay(2000)
        // Click "Publish" in the dropdown menu
        const reMenuResult = await page.evaluate(() => {
          const menuSelectors = ['[class*="menuWrap"]', '[role="menu"]']
          for (const sel of menuSelectors) {
            const menus = Array.from(document.querySelectorAll(sel))
            for (const menu of menus) {
              const rect = (menu as HTMLElement).getBoundingClientRect()
              if (rect.width < 10 || rect.height < 10) continue
              const allDescendants = Array.from(menu.querySelectorAll('*'))
              for (const el of allDescendants) {
                const text = el.textContent?.toLowerCase() || ''
                if (!text.includes('publish')) continue
                const childrenWithPublish = Array.from(el.children).filter(c =>
                  c.textContent?.toLowerCase().includes('publish')
                )
                if (childrenWithPublish.length > 0) continue
                ;(el as HTMLElement).click()
                return { clicked: true, text: el.textContent?.trim() }
              }
            }
          }
          return { clicked: false }
        })
        console.log(`[TV Publish] Re-publish menu: ${JSON.stringify(reMenuResult)}`)
        await delay(2000)

        // Check if the "unsaved changes" modal reappeared
        const stillUnsaved = await page.evaluate(() => {
          const modalContainers = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="overlay"]'))
          for (const container of modalContainers) {
            const rect = (container as HTMLElement).getBoundingClientRect()
            if (rect.width < 100 || rect.height < 50) continue
            const text = container.textContent?.toLowerCase() || ''
            if (text.includes('unsaved') || text.includes('save your changes') || text.includes('save script')) {
              return true
            }
          }
          return false
        })
        if (stillUnsaved) {
          console.log('[TV Publish] Unsaved changes modal still present — save may have failed')
          await page.screenshot({ path: '/data/screenshots/tv-publish-save-failed.png' }).catch(() => {})
          await page.evaluate(() => {
            const modalContainers = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="overlay"]'))
            for (const container of modalContainers) {
              const text = container.textContent?.toLowerCase() || ''
              if (text.includes('unsaved') || text.includes('save your changes')) {
                const cancelBtn = Array.from(container.querySelectorAll('button')).find(b =>
                  b.textContent?.toLowerCase().includes('cancel') || b.textContent?.toLowerCase().includes('close')
                )
                if (cancelBtn) cancelBtn.click()
                break
              }
            }
          })
          await delay(1000)
        }
      } // end if (!dialogAppearedEarly)
    }

    // STEP 2: Wait for publish dialog, handling intermediate modals
    console.log('[TV Publish] Waiting for publish dialog...')

    // Helper: dismiss upgrade/limit modal
    const dismissUpgradeModal = async (): Promise<void> => {
      await page.evaluate(() => {
        const allClickable = Array.from(document.querySelectorAll('a, button, [role="button"]'))
        for (const el of allClickable) {
          const text = el.textContent?.toLowerCase().trim() || ''
          if (text === 'not now' || text === 'maybe later' || text === 'no, thanks' || text === 'close' || text === 'cancel' || text === 'ok') {
            ;(el as HTMLElement).click()
            return
          }
        }
        const closeButtons = Array.from(document.querySelectorAll('[aria-label="Close" i], [data-name="close"]'))
        for (const el of closeButtons) {
          const rect = (el as HTMLElement).getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            ;(el as HTMLElement).click()
            return
          }
        }
      })
    }

    // Helper: add script to chart via Pine Editor toolbar
    const addScriptToChart = async (): Promise<boolean> => {
      const addSels = ['[title*="Add to chart" i]', '[data-name="add-script-to-chart"]', '[aria-label*="Add to chart" i]']
      for (const sel of addSels) {
        const btn = await page.$(sel)
        if (btn) {
          await btn.click()
          console.log(`[TV Publish] Added to chart: ${sel}`)
          return true
        }
      }
      return false
    }

    // Helper: trigger publish (click publish button + menu item)
    const triggerPublish = async (): Promise<void> => {
      await page.evaluate(() => {
        const btn = document.querySelector('[data-qa-id="publish-script"]') as HTMLElement
        if (btn) btn.click()
      })
      await delay(2000)
      await page.evaluate(() => {
        const menus = Array.from(document.querySelectorAll('[class*="menuWrap"]'))
        for (const menu of menus) {
          const rect = (menu as HTMLElement).getBoundingClientRect()
          if (rect.width < 10 || rect.height < 10) continue
          const items = Array.from(menu.querySelectorAll('*'))
          for (const el of items) {
            const text = el.textContent?.toLowerCase() || ''
            if (!text.includes('publish')) continue
            if (Array.from(el.children).some(c => c.textContent?.toLowerCase().includes('publish'))) continue
            ;(el as HTMLElement).click()
            return
          }
        }
      })
      await delay(3000)
    }

    // Check page state after publish trigger
    await delay(3000)
    const pageState = await page.evaluate(() => {
      // Check for "not on chart" modal — scope to visible modal containers to avoid false positives
      let hasNotOnChart = false
      const notOnChartContainers = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="overlay"], [class*="popup"]'))
      for (const c of notOnChartContainers) {
        const rect = (c as HTMLElement).getBoundingClientRect()
        if (rect.width < 100 || rect.height < 50) continue
        const text = c.textContent?.toLowerCase() || ''
        if (text.includes('not on the chart') || text.includes('add it to the chart') || text.includes('must add it')) {
          hasNotOnChart = true
          break
        }
      }
      const hasPublishDialog = !!document.querySelector('[data-dialog-name="publish-script"]')
      // Check for upgrade modal — look in visible modals/dialogs only, not full page text
      // (full page text has false positives from TradingView's static UI text)
      let hasUpgrade = false
      let upgradeText = ''
      const modalContainers = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="overlay"], [class*="popup"]'))
      for (const container of modalContainers) {
        const rect = (container as HTMLElement).getBoundingClientRect()
        if (rect.width < 100 || rect.height < 50) continue
        const text = container.textContent?.toLowerCase() || ''
        if (text.includes('more indicators') || text.includes('upgrade your plan') || text.includes('maximum available') || text.includes('upgrade now')) {
          hasUpgrade = true
          upgradeText = text.substring(0, 200)
          break
        }
      }
      const legendItems = Array.from(document.querySelectorAll('[data-qa-id="legend-delete-action"]'))
      return { hasNotOnChart, hasPublishDialog, hasUpgrade, upgradeText, legendCount: legendItems.length }
    })
    console.log(`[TV Publish] Page state: ${JSON.stringify(pageState)}`)

    // If publish dialog already appeared, great — skip straight to form fill
    if (!pageState.hasPublishDialog) {
      // Indicators were already cleaned up in PRE-PUBLISH step, so this is unexpected.
      // Try simpler recovery: dismiss any modal, handle "not on chart", re-trigger.
      const reason = pageState.hasUpgrade ? `upgrade modal (${pageState.upgradeText?.substring(0, 80)})` : pageState.hasNotOnChart ? '"not on chart" modal' : 'no publish dialog'
      console.log(`[TV Publish] ${reason} — taking screenshot and attempting recovery`)
      await page.screenshot({ path: '/data/screenshots/tv-publish-no-dialog-state.png' }).catch(() => {})

      // Step 1: Dismiss any blocking modal first
      await page.evaluate(() => {
        // Close "not on chart" modal, upgrade modal, or any other dialog
        const closeSelectors = ['[aria-label="Close" i]', '[data-name="close"]', 'button[class*="close"]']
        for (const sel of closeSelectors) {
          const el = document.querySelector(sel) as HTMLElement
          if (el && el.getBoundingClientRect().width > 0) { el.click(); return }
        }
        const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        for (const b of btns) {
          const t = (b as HTMLElement).textContent?.toLowerCase().trim() || ''
          if (t === 'not now' || t === 'maybe later' || t === 'no, thanks' || t === 'close' || t === 'ok' || t === 'cancel') {
            ;(b as HTMLElement).click()
            return
          }
        }
      }).catch(() => {})
      await delay(2000)

      // Step 2: Remove ALL remaining indicators via puppeteer to clear chart for add-to-chart
      if (pageState.hasNotOnChart && pageState.legendCount > 0) {
        console.log(`[TV Publish] Removing ${pageState.legendCount} remaining indicators before re-add...`)
        for (let i = 0; i < 10; i++) {
          const deleteBtn = await page.$('[data-qa-id="legend-delete-action"]')
          if (!deleteBtn) break
          try {
            await Promise.race([deleteBtn.hover(), new Promise<void>((_, r) => setTimeout(() => r(new Error('t')), 5000))])
            await delay(300)
            await Promise.race([deleteBtn.click(), new Promise<void>((_, r) => setTimeout(() => r(new Error('t')), 5000))])
            await delay(500)
            // Dismiss any modal that appears
            await page.evaluate(() => {
              const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
              for (const b of btns) {
                const t = (b as HTMLElement).textContent?.toLowerCase().trim() || ''
                if (t === 'not now' || t === 'maybe later' || t === 'no, thanks' || t === 'close' || t === 'ok' || t === 'cancel') {
                  ;(b as HTMLElement).click()
                  return
                }
              }
            }).catch(() => {})
          } catch {
            await page.evaluate(() => {
              const btns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
              for (const b of btns) {
                const t = (b as HTMLElement).textContent?.toLowerCase().trim() || ''
                if (t === 'not now' || t === 'maybe later' || t === 'no, thanks' || t === 'close' || t === 'ok' || t === 'cancel') {
                  ;(b as HTMLElement).click()
                  return
                }
              }
            }).catch(() => {})
            await delay(1000)
          }
        }
        await delay(1000)
        // Now add script to chart with clean chart state
        console.log('[TV Publish] Adding script to chart after clearing...')
        for (const sel of ['[title*="Add to chart" i]', '[data-name="add-script-to-chart"]']) {
          const btn = await page.$(sel)
          if (btn) { await btn.click(); console.log(`[TV Publish] Clicked ${sel}`); break }
        }
        await delay(5000)
        await dismissUpgradeModal()
        await delay(2000)
      } else if (pageState.hasNotOnChart) {
        // No legend items but "not on chart" — just click "add to chart"
        console.log('[TV Publish] Clicking "add to chart" from the modal...')
        await page.evaluate(() => {
          const allClickable = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"]'))
          for (const el of allClickable) {
            const text = (el as HTMLElement).textContent?.toLowerCase().trim() || ''
            if (text.includes('add') && text.includes('chart')) {
              ;(el as HTMLElement).click()
              return
            }
          }
        })
        await delay(5000)
        await dismissUpgradeModal()
        await delay(2000)
      } else {
        await dismissUpgradeModal()
        await delay(2000)
      }

      // Step 2: Re-trigger publish
      console.log('[TV Publish] Re-triggering publish...')
      await triggerPublish()
      await page.screenshot({ path: '/data/screenshots/tv-publish-after-retrigger.png' }).catch(() => {})
    }

    const dialogAppeared = await waitForElement(page, DIALOG_SEL, 30000)
    if (!dialogAppeared) {
      // If still no dialog, try re-triggering publish one more time
      console.log('[TV Publish] Dialog not yet visible — retrying publish trigger...')
      await page.evaluate(() => {
        const btn = document.querySelector('[data-qa-id="publish-script"]') as HTMLElement
        if (btn) btn.click()
      })
      await delay(2000)
      await page.evaluate(() => {
        const menus = Array.from(document.querySelectorAll('[class*="menuWrap"]'))
        for (const menu of menus) {
          const rect = (menu as HTMLElement).getBoundingClientRect()
          if (rect.width < 10 || rect.height < 10) continue
          const items = Array.from(menu.querySelectorAll('*'))
          for (const el of items) {
            const text = el.textContent?.toLowerCase() || ''
            if (!text.includes('publish')) continue
            if (Array.from(el.children).some(c => c.textContent?.toLowerCase().includes('publish'))) continue
            ;(el as HTMLElement).click()
            return
          }
        }
      })
      await delay(3000)

      const retryDialog = await waitForElement(page, DIALOG_SEL, 20000)
      if (!retryDialog) {
        await page.screenshot({ path: '/data/screenshots/tv-publish-no-dialog.png' }).catch(() => {})
        console.error('[TV Publish] Publish dialog did not appear after retry')
        return { success: false, error: 'PUBLISH_DIALOG_NOT_FOUND' }
      }
    }
    console.log('[TV Publish] Publish dialog appeared')

    // STEP 3: Fill form (title + description + click Continue) — single evaluate
    // All selectors are scoped to the dialog container to avoid hitting
    // unrelated elements on the chart page.
    console.log('[TV Publish] Filling title and description...')
    const descriptionText = description || title
    const formResult = await page.evaluate((opts: { title: string; description: string; dialogSel: string }) => {
      const dialog = document.querySelector(opts.dialogSel)
      if (!dialog) return { title: false, description: false, continued: false }
      const result = { title: false, description: false, continued: false }

      // Fill title using React-compatible native value setter
      const titleSels = ['input[name="title"]', 'input[placeholder*="title" i]', 'input[type="text"]']
      for (const sel of titleSels) {
        const input = dialog.querySelector(sel) as HTMLInputElement
        if (input) {
          input.focus()
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          if (nativeSetter) {
            nativeSetter.call(input, opts.title)
          } else {
            input.value = opts.title
          }
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
          result.title = true
          break
        }
      }

      // Fill description — find contenteditable within dialog
      const editables = Array.from(dialog.querySelectorAll('[contenteditable="true"]'))
      for (const el of editables) {
        const rect = (el as HTMLElement).getBoundingClientRect()
        // Description area is typically taller than small inline editables
        if (rect.height > 30 && rect.width > 100) {
          (el as HTMLElement).focus()
          ;(el as HTMLElement).textContent = opts.description
          el.dispatchEvent(new Event('input', { bubbles: true }))
          result.description = true
          break
        }
      }

      // Click Continue button
      const buttons = Array.from(dialog.querySelectorAll('button'))
      const continueBtn = buttons.find(b => b.textContent?.toLowerCase().includes('continue'))
      if (continueBtn) {
        continueBtn.click()
        result.continued = true
      }

      return result
    }, { title, description: descriptionText, dialogSel: DIALOG_SEL })

    console.log(`[TV Publish] Form: title=${formResult.title}, desc=${formResult.description}, continue=${formResult.continued}`)

    if (!formResult.title && !formResult.description) {
      await page.screenshot({ path: '/data/screenshots/tv-publish-form-fill-failed.png' }).catch(() => {})
      console.error('[TV Publish] Could not fill any form fields')
      return { success: false, error: 'DIALOG_FILL_FAILED' }
    }

    if (!formResult.continued) {
      console.log('[TV Publish] Warning: Continue button not found, trying keyboard submit...')
      await page.keyboard.press('Enter')
    }

    // Wait for step 2 to render
    await delay(1000)

    // Set up listener for new tabs BEFORE clicking final publish
    // (TradingView may open published script in a new tab)
    const browser = page.browser()
    const newPagePromise = new Promise<typeof page | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 15000)
      browser.once('targetcreated', async (target) => {
        if (target.type() === 'page') {
          clearTimeout(timeout)
          resolve(await target.page())
        }
      })
    })

    // STEP 4: Set visibility + check checkboxes + click final Publish — single evaluate
    console.log('[TV Publish] Step 2: visibility + submit...')
    const visibility = options.visibility || 'public'

    const step2Result = await page.evaluate((opts: { visibility: string; dialogSel: string }) => {
      const dialog = document.querySelector(opts.dialogSel) || document
      const actions: string[] = []

      // Dismiss any popup overlays (ad blocker, etc.)
      const closeButtons = Array.from(dialog.querySelectorAll('[class*="close"], [aria-label*="close" i]'))
      for (const btn of closeButtons) {
        const rect = (btn as HTMLElement).getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0 && rect.width < 50) {
          (btn as HTMLElement).click()
          actions.push('dismissed-popup')
        }
      }

      // Select visibility
      const allElements = Array.from(dialog.querySelectorAll('button, [role="button"], [class*="tab"], label'))
      for (const el of allElements) {
        const text = el.textContent?.toLowerCase() || ''
        if (text === opts.visibility || text.includes(opts.visibility)) {
          (el as HTMLElement).click()
          actions.push(`visibility:${opts.visibility}`)
          break
        }
      }
      // Fallback: radio buttons
      if (!actions.some(a => a.startsWith('visibility'))) {
        const radios = Array.from(dialog.querySelectorAll('input[type="radio"]'))
        for (const radio of radios) {
          const val = (radio as HTMLInputElement).value?.toLowerCase() || ''
          const label = radio.closest('label')?.textContent?.toLowerCase() || ''
          if (val === opts.visibility || label.includes(opts.visibility)) {
            (radio as HTMLInputElement).click()
            actions.push(`visibility:radio:${opts.visibility}`)
            break
          }
        }
      }

      // Check all unchecked checkboxes (terms, agreements, etc.)
      const checkboxes = Array.from(dialog.querySelectorAll('input[type="checkbox"]:not(:checked)'))
      for (const cb of checkboxes) {
        (cb as HTMLElement).click()
        actions.push('checkbox')
      }

      // Click final publish button
      const buttons = Array.from(dialog.querySelectorAll('button'))
      // Priority 1: "Publish ... script" (matches "Publish public script", "Publish private script")
      let publishBtn = buttons.find(b => {
        const text = b.textContent?.toLowerCase() || ''
        return text.includes('publish') && text.includes('script')
      })
      // Priority 2: any "Publish" button (not "Continue")
      if (!publishBtn) {
        publishBtn = buttons.find(b => {
          const text = b.textContent?.toLowerCase() || ''
          return text.includes('publish') && !text.includes('continue')
        })
      }
      // Priority 3: submit button
      if (!publishBtn) {
        publishBtn = buttons.find(b => b.type === 'submit')
      }
      if (publishBtn) {
        publishBtn.click()
        actions.push('published')
      }

      return actions
    }, { visibility, dialogSel: DIALOG_SEL })

    console.log(`[TV Publish] Step 2: ${step2Result.join(', ')}`)

    if (!step2Result.includes('published')) {
      await page.screenshot({ path: '/data/screenshots/tv-publish-step2-failed.png' }).catch(() => {})
      return { success: false, error: 'Could not find final Publish button in step 2' }
    }

    // STEP 5: Wait for publish result — check new tab first, then current page
    console.log('[TV Publish] Waiting for publish to complete...')
    const newScriptPage = await newPagePromise

    if (newScriptPage) {
      try {
        await newScriptPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
        await delay(1000)
        const newTabUrl = newScriptPage.url()
        console.log(`[TV Publish] New tab: ${newTabUrl}`)
        await newScriptPage.close().catch(() => {})
        if (newTabUrl.includes('/script/')) {
          return { success: true, indicatorUrl: newTabUrl }
        }
      } catch {
        console.log('[TV Publish] Error checking new tab')
      }
    }

    // Fallback: poll current page for URL (2 attempts)
    for (let attempt = 0; attempt < 2; attempt++) {
      await delay(2000)
      const currentUrl = page.url()
      const indicatorMatch = currentUrl.match(/tradingview\.com\/script\/([^/]+)/)
      if (indicatorMatch) {
        return { success: true, indicatorUrl: `https://www.tradingview.com/script/${indicatorMatch[1]}/` }
      }

      const indicatorUrl = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/script/"]'))
        for (const link of links) {
          const href = (link as HTMLAnchorElement).href
          if (href.includes('tradingview.com/script/')) return href
        }
        return null
      })
      if (indicatorUrl) {
        return { success: true, indicatorUrl }
      }
    }

    // Last resort: navigate to user's scripts page
    console.log('[TV Publish] Checking user profile for script URL...')
    try {
      await page.goto('https://www.tradingview.com/u/#published-scripts', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      })
      await delay(2000)
      const scriptUrl = await page.evaluate(() => {
        const link = document.querySelector('a[href*="/script/"]') as HTMLAnchorElement
        return link?.href || null
      })
      if (scriptUrl) {
        return { success: true, indicatorUrl: scriptUrl }
      }
    } catch {
      console.log('[TV Publish] Failed to check profile')
    }

    console.log('[TV Publish] Published but could not retrieve URL')
    return { success: true, indicatorUrl: undefined }
  } catch (error) {
    console.error('Script publishing failed:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  } finally {
    if (session && shouldCloseSession) {
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

    // Wait for Monaco editor to be ready (30s for cold start on shared CPU VM)
    console.log('[TV Publish v2] Waiting for Monaco editor...')
    const editorReady = await waitForElement(page, TV_SELECTORS.pineEditorPage.editorArea, 30000)
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
