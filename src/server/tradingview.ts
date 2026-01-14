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

/**
 * Verify TradingView session is valid
 */
export async function verifyTVSession(credentials: TVCredentials): Promise<boolean> {
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

    // Open Pine Editor if not already open
    const pineEditorVisible = await waitForElement(page, TV_SELECTORS.pineEditor.container, 5000)
    if (!pineEditorVisible) {
      await page.click(TV_SELECTORS.chart.pineEditorButton)
      await waitForElement(page, TV_SELECTORS.pineEditor.container, 10000)
    }

    // Wait for Monaco editor to be ready
    await waitForElement(page, TV_SELECTORS.pineEditor.editorArea, 10000)

    // Clear existing code and insert new script
    await page.evaluate((scriptContent) => {
      // Access Monaco editor instance
      const editor = (window as any).TradingView?.pineEditor?.getEditor?.()
      if (editor) {
        editor.setValue(scriptContent)
      }
    }, script)

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
 * Publish a Pine Script as a private indicator
 */
export async function publishPineScript(
  credentials: TVCredentials,
  script: string,
  title: string,
  description: string
): Promise<PublishResult> {
  let session: BrowserlessSession | null = null

  try {
    session = await createBrowserSession()
    const { page } = session

    // Inject cookies
    const cookies = parseTVCookies(credentials)
    await injectCookies(page, cookies)

    // Navigate to TradingView chart
    await navigateTo(page, 'https://www.tradingview.com/chart/')

    // Open Pine Editor
    const pineEditorVisible = await waitForElement(page, TV_SELECTORS.pineEditor.container, 5000)
    if (!pineEditorVisible) {
      await page.click(TV_SELECTORS.chart.pineEditorButton)
      await waitForElement(page, TV_SELECTORS.pineEditor.container, 10000)
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
