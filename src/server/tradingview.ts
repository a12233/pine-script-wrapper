import {
  createBrowserSession,
  closeBrowserSession,
  injectCookies,
  waitForElement,
  navigateTo,
  type BrowserlessSession,
} from './browserless'
import fs from 'fs'
import path from 'path'

// Helper function for delays
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ============ Session Cache (File-based persistence) ============
const SESSION_CACHE_FILE = path.join(process.cwd(), '.tv-session-cache.json')

interface CachedSession {
  sessionId: string
  signature: string
  createdAt: number
  expiresAt: number
  source: 'auto-login' | 'manual' | 'user-login'
}

/**
 * Load cached session from file
 */
function loadCachedSession(): CachedSession | null {
  try {
    if (!fs.existsSync(SESSION_CACHE_FILE)) return null
    const data = fs.readFileSync(SESSION_CACHE_FILE, 'utf-8')
    const session: CachedSession = JSON.parse(data)

    // Check if session is expired (with 1 hour buffer)
    if (Date.now() > session.expiresAt - 60 * 60 * 1000) {
      console.log('[TV Cache] Cached session expired, removing...')
      fs.unlinkSync(SESSION_CACHE_FILE)
      return null
    }

    console.log(`[TV Cache] Loaded cached session (source: ${session.source}, expires: ${new Date(session.expiresAt).toISOString()})`)
    return session
  } catch (error) {
    console.error('[TV Cache] Failed to load cached session:', error)
    return null
  }
}

/**
 * Save session to cache file
 */
export function saveCachedSession(session: Omit<CachedSession, 'createdAt'>): void {
  try {
    const cached: CachedSession = {
      ...session,
      createdAt: Date.now(),
    }
    fs.writeFileSync(SESSION_CACHE_FILE, JSON.stringify(cached, null, 2))
    console.log(`[TV Cache] Session cached (expires: ${new Date(session.expiresAt).toISOString()})`)
  } catch (error) {
    console.error('[TV Cache] Failed to save session:', error)
  }
}

/**
 * Clear cached session
 */
function clearCachedSession(): void {
  try {
    if (fs.existsSync(SESSION_CACHE_FILE)) {
      fs.unlinkSync(SESSION_CACHE_FILE)
      console.log('[TV Cache] Session cache cleared')
    }
  } catch (error) {
    console.error('[TV Cache] Failed to clear session:', error)
  }
}

/**
 * Get credentials from cache or return null
 */
export function getCachedCredentials(): TVCredentials | null {
  const cached = loadCachedSession()
  if (!cached) return null
  return {
    sessionId: cached.sessionId,
    signature: cached.signature,
    userId: cached.source,
  }
}

// Environment credentials for auto-login
const TV_USERNAME = process.env.TV_USERNAME
const TV_PASSWORD = process.env.TV_PASSWORD

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
 * Login to TradingView using username/password and extract session cookies
 * First checks for a valid cached session to avoid CAPTCHA
 */
export async function loginWithCredentials(): Promise<TVCredentials | null> {
  // First, check for cached session
  const cached = loadCachedSession()
  if (cached) {
    console.log('[TV] Found cached session, verifying...')
    const isValid = await verifyTVSession({
      sessionId: cached.sessionId,
      signature: cached.signature,
      userId: cached.source,
    })

    if (isValid) {
      console.log('[TV] Cached session is valid, reusing...')
      return {
        sessionId: cached.sessionId,
        signature: cached.signature,
        userId: cached.source,
      }
    } else {
      console.log('[TV] Cached session is invalid, clearing...')
      clearCachedSession()
    }
  }

  if (!TV_USERNAME || !TV_PASSWORD) {
    console.log('[TV] No username/password configured in environment')
    return null
  }

  let session: BrowserlessSession | null = null

  try {
    console.log('[TV] Attempting auto-login with environment credentials (note: may fail due to CAPTCHA)')
    session = await createBrowserSession()
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

    // Cache the session for future use (7 days)
    saveCachedSession({
      sessionId: sessionIdCookie.value,
      signature: signatureCookie.value,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      source: 'auto-login',
    })

    return {
      sessionId: sessionIdCookie.value,
      signature: signatureCookie.value,
      userId: 'auto-login',
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
 * This runs headless and cannot handle CAPTCHA - returns error if detected
 */
export async function loginWithUserCredentials(
  username: string,
  password: string
): Promise<UserLoginResult> {
  if (!username || !password) {
    return { success: false, error: 'Username and password are required' }
  }

  let session: BrowserlessSession | null = null

  try {
    console.log('[TV] Attempting login with user-provided credentials')
    session = await createBrowserSession()
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
      console.log('[TV] CAPTCHA detected - cannot solve in headless mode')
      return {
        success: false,
        error: 'CAPTCHA verification required. Please use manual cookie method instead.',
        captchaDetected: true,
      }
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

    // Cache the session for future use (7 days)
    saveCachedSession({
      sessionId: sessionIdCookie.value,
      signature: signatureCookie.value,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      source: 'user-login',
    })

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

  let session: BrowserlessSession | null = null

  try {
    session = await createBrowserSession()
    const { page } = session

    // Inject cookies
    const cookies = parseTVCookies(credentials)
    await injectCookies(page, cookies)

    // Navigate to TradingView chart
    const navigated = await navigateTo(page, 'https://www.tradingview.com/chart/')
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
    await delay(2000) // Give editor time to fully initialize

    // Clear existing code and insert new script
    console.log('[TV] Inserting script into editor...')
    const scriptInserted = await page.evaluate((scriptContent) => {
      // Try multiple methods to set the script

      // Method 1: TradingView's Pine Editor API
      const tvEditor = (window as any).TradingView?.pineEditor?.getEditor?.()
      if (tvEditor && typeof tvEditor.setValue === 'function') {
        tvEditor.setValue(scriptContent)
        return { success: true, method: 'TradingView.pineEditor' }
      }

      // Method 2: Monaco editor instance
      const monaco = (window as any).monaco
      if (monaco) {
        const editors = monaco.editor.getEditors()
        if (editors && editors.length > 0) {
          editors[0].setValue(scriptContent)
          return { success: true, method: 'monaco.editor.getEditors' }
        }
      }

      // Method 3: Try to find monaco editor models
      if (monaco && monaco.editor) {
        const models = monaco.editor.getModels()
        if (models && models.length > 0) {
          models[0].setValue(scriptContent)
          return { success: true, method: 'monaco.editor.getModels' }
        }
      }

      return { success: false, method: 'none found' }
    }, script)

    if (scriptInserted.success) {
      console.log(`[TV] Script inserted successfully via ${scriptInserted.method}`)
    } else {
      console.error('[TV] Failed to insert script:', scriptInserted.method)
      throw new Error('Could not insert script into Pine Editor')
    }

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

export interface PublishOptions {
  script: string
  title: string
  description: string
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

  let session: BrowserlessSession | null = null

  try {
    session = await createBrowserSession()
    const { page } = session

    // Inject cookies
    const cookies = parseTVCookies(credentials)
    await injectCookies(page, cookies)

    // Navigate to TradingView chart
    await navigateTo(page, 'https://www.tradingview.com/chart/')
    console.log('[TV Publish] Navigated to chart, waiting for page load...')
    await delay(3000)

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
        await delay(5000) // Wait for editor to load

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

    // Insert script
    await page.evaluate((scriptContent) => {
      const editor = (window as any).TradingView?.pineEditor?.getEditor?.()
      if (editor) {
        editor.setValue(scriptContent)
      }
    }, script)

    // Wait for compilation
    await delay(3000)

    // Click publish button
    await page.click(TV_SELECTORS.publish.button)
    await waitForElement(page, TV_SELECTORS.publish.dialog, 10000)

    // Fill in publish form
    await page.type(TV_SELECTORS.publish.titleInput, title)
    await page.type(TV_SELECTORS.publish.descriptionInput, description)

    // Select private visibility
    await page.click(TV_SELECTORS.publish.privateRadio)

    // Submit
    await page.click(TV_SELECTORS.publish.submitButton)

    // Wait for success and get the indicator URL
    await delay(5000)

    // Try to capture the new indicator URL from redirect or success message
    const currentUrl = page.url()
    const indicatorMatch = currentUrl.match(/tradingview\.com\/script\/([^/]+)/)

    if (indicatorMatch) {
      return {
        success: true,
        indicatorUrl: `https://www.tradingview.com/script/${indicatorMatch[1]}/`,
      }
    }

    // If no redirect, try to find the URL in the page
    const indicatorUrl = await page.evaluate(() => {
      // Look for script link in success message or profile
      const link = document.querySelector('a[href*="/script/"]') as HTMLAnchorElement
      return link?.href || null
    })

    return {
      success: !!indicatorUrl,
      indicatorUrl: indicatorUrl || undefined,
      error: indicatorUrl ? undefined : 'Could not retrieve indicator URL',
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
