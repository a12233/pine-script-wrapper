/**
 * Test script for TradingView automation
 * Run with: npx tsx scripts/test-tv-automation.ts
 *
 * Prerequisites:
 * - Close Chrome completely before running (profile lock)
 * - Set TV_USERNAME and TV_PASSWORD in .env
 */

import 'dotenv/config'
import { createBrowserSession, closeBrowserSession, waitForElement, navigateTo } from '../src/server/browserless'
import * as readline from 'readline'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// TradingView credentials (for testing only)
const TV_USERNAME = process.env.TV_USERNAME || 'pug0ngying'
const TV_PASSWORD = process.env.TV_PASSWORD || ''

// Test Pine Script
const TEST_SCRIPT = `//@version=5
indicator("Test Indicator", overlay=true)
plot(close, color=color.blue, linewidth=2)
`

async function promptPassword(): Promise<string> {
  if (TV_PASSWORD) return TV_PASSWORD

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question('Enter TradingView password: ', (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

async function testTVAutomation() {
  console.log('🚀 Starting TradingView automation test...\n')

  let session = null

  try {
    // Step 1: Create browser session
    console.log('1️⃣  Launching browser...')
    session = await createBrowserSession()
    const { page } = session
    console.log('   ✅ Browser launched\n')

    // Step 2: Navigate to TradingView chart
    console.log('2️⃣  Navigating to TradingView...')
    const navigated = await navigateTo(page, 'https://www.tradingview.com/chart/')
    if (!navigated) {
      throw new Error('Failed to navigate to TradingView')
    }
    console.log('   ✅ Navigation complete\n')

    // Step 3: Check if logged in
    console.log('3️⃣  Checking login status...')
    await delay(3000) // Wait for page to fully load

    const userMenuSelector = '[data-name="header-user-menu-button"]'
    const isLoggedIn = await waitForElement(page, userMenuSelector, 10000)

    if (isLoggedIn) {
      console.log('   ✅ Already logged in!\n')
    } else {
      console.log('   ❌ Not logged in. Attempting auto-login...\n')

      // Get password
      const password = await promptPassword()
      if (!password) {
        throw new Error('Password required for login')
      }

      // Click sign in button
      const signInButton = '[data-name="header-signin-button"]'
      const hasSignIn = await waitForElement(page, signInButton, 5000)
      if (hasSignIn) {
        await page.click(signInButton)
        await delay(2000)
      }

      // Wait for login modal
      console.log('   Looking for login form...')
      await delay(2000)

      // Try email login - click "Email" tab/button if available
      const emailTabSelectors = [
        'button[name="Email"]',
        '[data-name="email"]',
        'span:has-text("Email")',
        '.tv-signin-dialog__toggle-email',
      ]

      for (const sel of emailTabSelectors) {
        try {
          const emailTab = await page.$(sel)
          if (emailTab) {
            await emailTab.click()
            console.log('   Clicked email login option')
            await delay(1000)
            break
          }
        } catch {}
      }

      // Fill in username/email
      const usernameSelectors = [
        'input[name="username"]',
        'input[name="email"]',
        'input[type="email"]',
        'input[placeholder*="email"]',
        'input[placeholder*="Username"]',
      ]

      for (const sel of usernameSelectors) {
        try {
          const input = await page.$(sel)
          if (input) {
            await input.type(TV_USERNAME)
            console.log(`   Entered username: ${TV_USERNAME}`)
            break
          }
        } catch {}
      }

      await delay(500)

      // Fill in password
      const passwordSelectors = [
        'input[name="password"]',
        'input[type="password"]',
      ]

      for (const sel of passwordSelectors) {
        try {
          const input = await page.$(sel)
          if (input) {
            await input.type(password)
            console.log('   Entered password')
            break
          }
        } catch {}
      }

      await delay(500)

      // Click submit
      const submitSelectors = [
        'button[type="submit"]',
        'button[data-name="submit"]',
        '.tv-button--primary',
      ]

      for (const sel of submitSelectors) {
        try {
          const btn = await page.$(sel)
          if (btn) {
            await btn.click()
            console.log('   Clicked login button')
            break
          }
        } catch {}
      }

      // Wait for login to complete
      console.log('   Waiting for login to complete...')
      await delay(5000)

      const loggedInNow = await waitForElement(page, userMenuSelector, 15000)
      if (loggedInNow) {
        console.log('   ✅ Successfully logged in!\n')
      } else {
        console.log('   ⚠️  Auto-login may have failed. Continuing anyway...\n')
      }
    }

    // Step 4: Open Pine Editor
    console.log('4️⃣  Opening Pine Editor...')
    const pineEditorSelector = '[data-name="pine-editor"]'
    let pineEditorVisible = await waitForElement(page, pineEditorSelector, 5000)

    if (!pineEditorVisible) {
      // Try to find and click the Pine Editor button
      const pineEditorButton = '[data-name="open-pine-editor"]'
      const buttonExists = await waitForElement(page, pineEditorButton, 5000)

      if (buttonExists) {
        await page.click(pineEditorButton)
        await delay(2000)
        pineEditorVisible = await waitForElement(page, pineEditorSelector, 10000)
      }
    }

    if (pineEditorVisible) {
      console.log('   ✅ Pine Editor is open\n')
    } else {
      console.log('   ⚠️  Could not open Pine Editor automatically')
      console.log('   Please open it manually (click Pine Editor at bottom)\n')
      await delay(10000)
    }

    // Step 5: Try to insert script
    console.log('5️⃣  Inserting test script...')
    await delay(2000)

    // Try multiple methods to access the editor
    const insertResult = await page.evaluate((script) => {
      // Method 1: TradingView's pine editor API
      const tvPineEditor = (window as any).TradingView?.pineEditor?.getEditor?.()
      if (tvPineEditor && typeof tvPineEditor.setValue === 'function') {
        tvPineEditor.setValue(script)
        return { success: true, method: 'TradingView.pineEditor' }
      }

      // Method 2: Monaco editor instance
      const monaco = (window as any).monaco
      if (monaco) {
        const editors = monaco.editor.getEditors()
        if (editors.length > 0) {
          editors[0].setValue(script)
          return { success: true, method: 'monaco.editor' }
        }
      }

      // Method 3: Find textarea (fallback)
      const textarea = document.querySelector('.monaco-editor textarea') as HTMLTextAreaElement
      if (textarea) {
        return { success: false, method: 'found textarea but cannot set value directly' }
      }

      return { success: false, method: 'no editor found' }
    }, TEST_SCRIPT)

    if (insertResult.success) {
      console.log(`   ✅ Script inserted via ${insertResult.method}\n`)
    } else {
      console.log(`   ⚠️  Could not insert script: ${insertResult.method}`)
      console.log('   Try inserting manually or check selectors\n')
    }

    // Step 6: Wait and check for compilation
    console.log('6️⃣  Waiting for compilation...')
    await delay(5000)

    // Check console for errors
    const consolePanel = await page.$('[data-name="console-panel"]')
    if (consolePanel) {
      const consoleText = await page.evaluate(
        (el) => el?.textContent || '',
        consolePanel
      )
      console.log('   Console output:', consoleText.slice(0, 200) || '(empty)')
    }
    console.log()

    // Step 7: Keep browser open for inspection
    console.log('✅ Test complete! Browser will stay open for 60 seconds for inspection.')
    console.log('   Press Ctrl+C to close early.\n')
    await delay(60000)

  } catch (error) {
    console.error('\n❌ Error:', error)
  } finally {
    if (session) {
      console.log('Closing browser...')
      await closeBrowserSession(session)
    }
  }
}

// Run the test
testTVAutomation().catch(console.error)
