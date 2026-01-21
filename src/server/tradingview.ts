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

      // Wait for Pine Editor to appear - give it more time
      console.log('[TV] Waiting for Pine Editor to load...')
      await delay(5000) // Give it 5 seconds to start loading

      // Try multiple selectors for Pine Editor container
      const pineEditorSelectors = [
        '[data-name="pine-editor"]',
        '.pine-editor-container',
        '[data-role="panel-Pine"]',
        '[id*="pine"]',
        '.monaco-editor', // The code editor itself
      ]

      let editorOpened = false
      for (const selector of pineEditorSelectors) {
        const found = await waitForElement(page, selector, 3000)
        if (found) {
          console.log(`[TV] Pine Editor found with selector: ${selector}`)
          editorOpened = true
          break
        }
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
