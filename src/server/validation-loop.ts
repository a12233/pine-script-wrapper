/**
 * Validation Loop Module
 *
 * Orchestrates the validation process with automatic error fixing:
 * 1. Validate script with service account
 * 2. If errors, attempt AI-powered fix (1 retry max)
 * 3. Re-validate with fixed script
 * 4. Optionally publish after successful validation
 * 5. Return final result with indicator URL
 */

import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import {
  validateWithServiceAccount,
  formatErrorsForLLM,
  getServiceAccountCredentials,
  type FullValidationResult,
} from './service-validation'
import {
  PINE_SCRIPT_FIX_SYSTEM_PROMPT,
  buildFixPrompt,
  extractPineScript,
} from './prompts/pine-script-fix'
import { publishPineScript } from './tradingview'
import { startTimer } from './timing'
import {
  getWarmSession,
  releaseWarmSession,
  isWarmBrowserEnabled,
  ensureWarmBrowser,
} from './warm-browser'
import {
  createBrowserSession,
  closeBrowserSession,
  injectCookies,
  navigateTo,
  waitForElement,
  type BrowserlessSession,
} from './browserless'
import { parseTVCookies } from './tradingview'

// OpenRouter client
const openrouter = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
})

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4'

/**
 * Options for publishing after validation
 */
export interface PublishAfterValidationOptions {
  title: string
  description: string
  visibility: 'public' | 'private'
}

/**
 * Result of the validation loop
 */
export interface ValidationLoopResult {
  /** The final script (may be modified if AI fix was applied) */
  finalScript: string
  /** Whether the final script is valid */
  isValid: boolean
  /** Number of validation iterations performed */
  iterations: number
  /** Whether an AI fix was attempted */
  fixAttempted: boolean
  /** Whether the AI fix was successful */
  fixSuccessful: boolean
  /** Final validation errors (if any) */
  finalErrors: Array<{
    line: number
    message: string
    type: 'error' | 'warning'
  }>
  /** Raw console output from TradingView */
  rawOutput: string
  /** Whether script was successfully added to chart */
  addedToChart: boolean
  /** URL of published indicator (if publish was requested and successful) */
  indicatorUrl?: string
  /** Error from publish attempt (if publish failed) */
  publishError?: string
}

/**
 * Run the validation loop with automatic error fixing
 *
 * @param script - The Pine Script to validate
 * @param maxRetries - Maximum fix attempts (default: 1)
 * @param publishOptions - Optional: publish the script after successful validation
 * @returns Validation result with final script and status
 */
export async function runValidationLoop(
  script: string,
  maxRetries: number = 1,
  publishOptions?: PublishAfterValidationOptions
): Promise<ValidationLoopResult> {
  const timer = startTimer('ValidationLoop', 'validation loop')
  let currentScript = script
  let iterations = 0
  let fixAttempted = false
  let fixSuccessful = false
  let lastResult: FullValidationResult | null = null

  // Try warm browser path if available
  if (isWarmBrowserEnabled()) {
    try {
      await ensureWarmBrowser()
      const warmResult = await runWarmValidationLoop(currentScript, maxRetries, publishOptions, timer)
      if (warmResult) {
        return warmResult
      }
      // If warm path returned null, fall through to cold path
      console.log('[ValidationLoop] Warm path unavailable, falling back to cold path')
    } catch (error) {
      console.log('[ValidationLoop] Warm path failed, falling back to cold path:', error)
    }
  }

  console.log('[ValidationLoop] Starting validation loop (cold path)...')

  // First validation attempt
  iterations++
  console.log(`[ValidationLoop] Iteration ${iterations}: Validating script...`)
  lastResult = await validateWithServiceAccount(currentScript)
  timer.mark('first validation')

  if (lastResult.isValid) {
    console.log('[ValidationLoop] Script is valid on first attempt')

    // If publish options provided, publish the script
    if (publishOptions) {
      const publishResult = await publishAfterValidation(currentScript, publishOptions, timer)
      return {
        finalScript: currentScript,
        isValid: true,
        iterations,
        fixAttempted: false,
        fixSuccessful: false,
        finalErrors: [],
        rawOutput: lastResult.rawOutput,
        addedToChart: lastResult.addedToChart,
        indicatorUrl: publishResult.indicatorUrl,
        publishError: publishResult.error,
      }
    }

    timer.end()
    return {
      finalScript: currentScript,
      isValid: true,
      iterations,
      fixAttempted: false,
      fixSuccessful: false,
      finalErrors: [],
      rawOutput: lastResult.rawOutput,
      addedToChart: lastResult.addedToChart,
    }
  }

  // Script has errors - attempt AI fix if retries available
  if (maxRetries > 0) {
    console.log('[ValidationLoop] Script has errors, attempting AI fix...')
    fixAttempted = true

    try {
      const errorString = formatErrorsForLLM(lastResult)
      const fixedScript = await fixPineScriptErrors(currentScript, errorString)

      // Sanity check: ensure we got a non-empty response
      if (!fixedScript || fixedScript.length < 10) {
        console.log('[ValidationLoop] AI fix returned empty or invalid script')
      } else {
        currentScript = fixedScript

        // Re-validate with fixed script
        iterations++
        console.log(`[ValidationLoop] Iteration ${iterations}: Re-validating fixed script...`)
        lastResult = await validateWithServiceAccount(currentScript)

        if (lastResult.isValid) {
          console.log('[ValidationLoop] AI fix successful - script is now valid')
          fixSuccessful = true
          timer.mark('AI fix successful')

          // If publish options provided, publish the script
          if (publishOptions) {
            const publishResult = await publishAfterValidation(currentScript, publishOptions, timer)
            return {
              finalScript: currentScript,
              isValid: true,
              iterations,
              fixAttempted: true,
              fixSuccessful: true,
              finalErrors: [],
              rawOutput: lastResult.rawOutput,
              addedToChart: lastResult.addedToChart,
              indicatorUrl: publishResult.indicatorUrl,
              publishError: publishResult.error,
            }
          }

          timer.end()
          return {
            finalScript: currentScript,
            isValid: true,
            iterations,
            fixAttempted: true,
            fixSuccessful: true,
            finalErrors: [],
            rawOutput: lastResult.rawOutput,
            addedToChart: lastResult.addedToChart,
          }
        } else {
          console.log('[ValidationLoop] AI fix applied but script still has errors')
        }
      }
    } catch (error) {
      console.error('[ValidationLoop] AI fix failed:', error)
      // Continue with original script's errors
    }
  }

  // Return final result (script is still invalid)
  console.log(`[ValidationLoop] Validation complete after ${iterations} iterations - script is invalid`)
  timer.end()
  return {
    finalScript: currentScript,
    isValid: false,
    iterations,
    fixAttempted,
    fixSuccessful,
    finalErrors: lastResult?.errors || [],
    rawOutput: lastResult?.rawOutput || '',
    addedToChart: lastResult?.addedToChart || false,
  }
}

/**
 * Helper function to publish a script after successful validation
 */
async function publishAfterValidation(
  script: string,
  options: PublishAfterValidationOptions,
  timer: ReturnType<typeof startTimer>
): Promise<{ indicatorUrl?: string; error?: string }> {
  console.log('[ValidationLoop] Publishing script after successful validation...')
  timer.mark('starting publish')

  try {
    const credentials = await getServiceAccountCredentials()
    if (!credentials) {
      console.error('[ValidationLoop] Failed to get service account credentials for publish')
      return { error: 'Service account authentication failed' }
    }

    const publishResult = await publishPineScript(credentials, {
      script,
      title: options.title,
      description: options.description,
      visibility: options.visibility,
    })

    timer.mark('publish complete')

    if (publishResult.success) {
      console.log(`[ValidationLoop] Script published successfully: ${publishResult.indicatorUrl}`)
      timer.end()
      return { indicatorUrl: publishResult.indicatorUrl }
    } else {
      console.error(`[ValidationLoop] Publish failed: ${publishResult.error}`)
      timer.end()
      return { error: publishResult.error }
    }
  } catch (error) {
    console.error('[ValidationLoop] Publish error:', error)
    timer.end()
    return { error: error instanceof Error ? error.message : 'Unknown publish error' }
  }
}

/**
 * Quick validation without AI fix attempt
 * Useful for checking if a script is already valid
 */
export async function quickValidate(script: string): Promise<FullValidationResult> {
  console.log('[ValidationLoop] Quick validation (no fix attempt)...')
  return validateWithServiceAccount(script)
}

// Helper function for delays
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run validation+publish using the warm browser session.
 * Returns null if warm browser isn't available (caller should fall back to cold path).
 */
async function runWarmValidationLoop(
  script: string,
  maxRetries: number,
  publishOptions: PublishAfterValidationOptions | undefined,
  timer: ReturnType<typeof startTimer>
): Promise<ValidationLoopResult | null> {
  const session = await getWarmSession()
  if (!session) {
    return null
  }

  const { page } = session

  try {
    console.log('[ValidationLoop] Using warm browser path')

    // Ensure we're on /chart/ with Pine Editor open
    const url = page.url()
    if (!url.includes('tradingview.com/chart')) {
      console.log('[ValidationLoop] Warm browser not on /chart/, navigating...')
      const credentials = await getServiceAccountCredentials()
      if (!credentials) {
        return null // Fall back to cold path
      }
      const cookies = parseTVCookies(credentials)
      await injectCookies(page, cookies)
      await page.goto('https://www.tradingview.com/chart/', {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      })
    }

    // Ensure Pine Editor is open
    const editorExists = await page.$('.monaco-editor')
    if (!editorExists) {
      console.log('[ValidationLoop] Pine Editor not open, opening...')
      const selectors = ['[data-name="open-pine-editor"]', '[data-name="pine-dialog-button"]']
      let opened = false
      for (const sel of selectors) {
        const btn = await page.$(sel)
        if (btn) {
          await btn.click()
          try {
            await page.waitForSelector('.monaco-editor', { timeout: 8000 })
            console.log(`[ValidationLoop] Pine Editor opened via ${sel}`)
            opened = true
            break
          } catch {
            // Try next selector
          }
        }
      }
      if (!opened) {
        console.log('[ValidationLoop] Could not open Pine Editor on warm session')
        return null // Fall back to cold path
      }
    }

    timer.mark('pine editor ready')

    // === Validate: Insert script and click "Add to chart" ===
    console.log('[Warm Validate] Inserting script...')
    await page.click('.monaco-editor')
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')
    await delay(50)
    await page.evaluate((text: string) => navigator.clipboard.writeText(text), script)
    await page.keyboard.down('Control')
    await page.keyboard.press('v')
    await page.keyboard.up('Control')
    console.log('[Warm Validate] Script inserted')

    await delay(1500) // Wait for auto-compile

    // Click "Add to chart"
    const addToChartSelectors = [
      '[title*="Add to chart" i]',
      '[data-name="add-script-to-chart"]',
      '[aria-label*="Add to chart" i]',
    ]

    for (const sel of addToChartSelectors) {
      const btn = await page.$(sel)
      if (btn) {
        await btn.click()
        console.log(`[Warm Validate] Clicked "Add to chart": ${sel}`)
        break
      }
    }

    await delay(3000) // Wait for compilation result

    // Extract errors from console
    const errors = await page.evaluate(() => {
      const consolePanelSelectors = ['[data-name="console-panel"]', '.console-panel', '[class*="console"]']
      let consolePanel: Element | null = null
      for (const sel of consolePanelSelectors) {
        consolePanel = document.querySelector(sel)
        if (consolePanel) break
      }
      if (!consolePanel) return []

      const errorLines = consolePanel.querySelectorAll('.console-line.error, .error-line, .error')
      const warningLines = consolePanel.querySelectorAll('.console-line.warning, .warning-line, .warning')

      const parse = (el: Element, type: 'error' | 'warning') => {
        const text = el.textContent || ''
        const lineMatch = text.match(/line (\d+)/i)
        return { line: lineMatch ? parseInt(lineMatch[1], 10) : 0, message: text.trim(), type }
      }

      return [
        ...Array.from(errorLines).map(el => parse(el, 'error')),
        ...Array.from(warningLines).map(el => parse(el, 'warning')),
      ]
    })

    const rawOutput = await page.evaluate(() => {
      const selectors = ['[data-name="console-panel"]', '.console-panel', '[class*="console"]']
      for (const sel of selectors) {
        const panel = document.querySelector(sel)
        if (panel?.textContent) return panel.textContent
      }
      return ''
    })

    const errorCount = errors.filter(e => e.type === 'error').length
    const isValid = errorCount === 0
    console.log(`[Warm Validate] Validation: ${errorCount} errors, isValid=${isValid}`)

    timer.mark('validation complete')

    let currentScript = script
    let iterations = 1
    let fixAttempted = false
    let fixSuccessful = false

    // If invalid and retries available, try AI fix
    if (!isValid && maxRetries > 0) {
      fixAttempted = true
      try {
        const errorString = formatErrorsForLLM({
          isValid: false,
          errors,
          rawOutput,
          addedToChart: false,
        })
        const fixedScript = await fixPineScriptErrors(currentScript, errorString)

        if (fixedScript && fixedScript.length >= 10) {
          currentScript = fixedScript
          iterations++

          // Re-validate with fixed script
          console.log('[Warm Validate] Re-validating fixed script...')
          await page.click('.monaco-editor')
          await page.keyboard.down('Control')
          await page.keyboard.press('a')
          await page.keyboard.up('Control')
          await delay(50)
          await page.evaluate((text: string) => navigator.clipboard.writeText(text), currentScript)
          await page.keyboard.down('Control')
          await page.keyboard.press('v')
          await page.keyboard.up('Control')
          await delay(1500)

          // Click "Add to chart" again
          for (const sel of addToChartSelectors) {
            const btn = await page.$(sel)
            if (btn) { await btn.click(); break }
          }
          await delay(3000)

          const fixedErrors = await page.evaluate(() => {
            const consolePanelSelectors = ['[data-name="console-panel"]', '.console-panel', '[class*="console"]']
            let consolePanel: Element | null = null
            for (const sel of consolePanelSelectors) {
              consolePanel = document.querySelector(sel)
              if (consolePanel) break
            }
            if (!consolePanel) return []
            const errorLines = consolePanel.querySelectorAll('.console-line.error, .error-line, .error')
            return Array.from(errorLines).map(el => {
              const text = el.textContent || ''
              const lineMatch = text.match(/line (\d+)/i)
              return { line: lineMatch ? parseInt(lineMatch[1], 10) : 0, message: text.trim(), type: 'error' as const }
            })
          })

          if (fixedErrors.length === 0) {
            fixSuccessful = true
            console.log('[Warm Validate] AI fix successful')
          } else {
            console.log(`[Warm Validate] AI fix failed, still ${fixedErrors.length} errors`)
          }
        }
      } catch (error) {
        console.error('[Warm Validate] AI fix error:', error)
      }
    }

    const finalIsValid = fixAttempted ? fixSuccessful : isValid

    // Publish if valid and publish options provided
    let indicatorUrl: string | undefined
    let publishError: string | undefined

    if (finalIsValid && publishOptions) {
      timer.mark('starting publish')
      try {
        const credentials = await getServiceAccountCredentials()
        if (credentials) {
          const publishResult = await publishPineScript(credentials, {
            script: currentScript,
            title: publishOptions.title,
            description: publishOptions.description,
            visibility: publishOptions.visibility,
          })
          if (publishResult.success) {
            indicatorUrl = publishResult.indicatorUrl
            console.log(`[Warm Validate] Published: ${indicatorUrl}`)
          } else {
            publishError = publishResult.error
          }
        }
      } catch (error) {
        publishError = error instanceof Error ? error.message : 'Unknown publish error'
      }
      timer.mark('publish complete')
    }

    timer.end()

    return {
      finalScript: currentScript,
      isValid: finalIsValid,
      iterations,
      fixAttempted,
      fixSuccessful,
      finalErrors: finalIsValid ? [] : errors,
      rawOutput,
      addedToChart: finalIsValid,
      indicatorUrl,
      publishError,
    }
  } catch (error) {
    console.error('[Warm Validate] Error:', error)
    return null // Fall back to cold path
  } finally {
    releaseWarmSession()
  }
}

/**
 * Fix Pine Script errors using OpenRouter LLM (extracted for reuse)
 */
async function fixPineScriptErrors(script: string, errors: string): Promise<string> {
  console.log('[ValidationLoop] Attempting AI fix for Pine Script errors...')
  const { text } = await generateText({
    model: openrouter(DEFAULT_MODEL),
    system: PINE_SCRIPT_FIX_SYSTEM_PROMPT,
    prompt: buildFixPrompt(script, errors),
  })
  const fixedScript = extractPineScript(text)
  console.log('[ValidationLoop] AI fix generated')
  return fixedScript
}
