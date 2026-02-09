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
  isWarmBrowserReady,
  isWarmBrowserInitializing,
  shutdownWarmBrowser,
} from './warm-browser'
import type { Page } from 'puppeteer-core'

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

  // Always prefer warm browser path when enabled — cold path on 2GB VM often
  // fails because TradingView's JS never fully bootstraps with limited memory.
  // If warm browser is still initializing, WAIT for it instead of killing it
  // and launching a second Chromium (which causes OOM / incomplete rendering).
  if (isWarmBrowserEnabled()) {
    if (!isWarmBrowserReady()) {
      console.log('[ValidationLoop] Warm browser still initializing, waiting for it...')
      // Wait up to 3 minutes for warm browser init to complete.
      // This is better than killing it and starting a cold path that will also
      // take 2+ minutes AND likely fail due to memory pressure.
      const waitStart = Date.now()
      const WARM_WAIT_TIMEOUT_MS = 180_000
      while (!isWarmBrowserReady() && Date.now() - waitStart < WARM_WAIT_TIMEOUT_MS) {
        // Break early if init failed (no longer initializing AND not ready)
        if (!isWarmBrowserInitializing()) {
          console.log('[ValidationLoop] Warm browser init failed, falling back to cold path')
          break
        }
        await new Promise(r => setTimeout(r, 2000))
      }
      if (isWarmBrowserReady()) {
        console.log(`[ValidationLoop] Warm browser ready after ${Math.round((Date.now() - waitStart) / 1000)}s wait`)
      } else {
        console.log(`[ValidationLoop] Warm browser not ready after ${Math.round((Date.now() - waitStart) / 1000)}s, falling back to cold path`)
        await shutdownWarmBrowser()
      }
    }

    if (isWarmBrowserReady()) {
      try {
        const warmResult = await runWarmValidationLoop(currentScript, maxRetries, publishOptions, timer)
        if (warmResult) {
          return warmResult
        }
        // If warm path returned null, fall through to cold path
        console.log('[ValidationLoop] Warm path unavailable, falling back to cold path')
      } catch (error) {
        console.log('[ValidationLoop] Warm path failed, falling back to cold path:', error)
      }
      // Kill warm browser before cold path to free memory (2 Chromium instances = OOM on 2GB VM)
      await shutdownWarmBrowser()
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

    // 5-minute timeout for the entire cold publish flow
    const COLD_PUBLISH_TIMEOUT_MS = 300_000
    const publishResult = await Promise.race([
      publishPineScript(credentials, {
        script,
        title: options.title,
        description: options.description,
        visibility: options.visibility,
      }),
      new Promise<{ success: false; error: string }>((resolve) =>
        setTimeout(() => resolve({ success: false, error: 'COLD_PUBLISH_TIMEOUT' }), COLD_PUBLISH_TIMEOUT_MS)
      ),
    ])

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

// ============ CDP-based helpers ============
// page.evaluate() hangs on TradingView pages because TradingView's JS event loop
// is so busy on the shared CPU VM that the main execution context can't process
// incoming CDP Runtime.evaluate calls in a timely manner.
//
// These helpers use alternative CDP methods that don't require JS execution in
// TradingView's main context:
// - Input.insertText: Sends text via the input subsystem (no JS needed)
// - DOM.querySelector/getOuterHTML: Uses the DOM agent (separate from JS engine)
// - page.$() + el.evaluate(): Works on individual elements (smaller scope)

/**
 * Insert text into the focused editor using CDP Input.insertText.
 * This is a DevTools protocol input event that doesn't require JS execution
 * in the page context — it goes through the browser's input pipeline directly.
 */
async function cdpInsertText(page: Page, text: string): Promise<void> {
  const client = await page.createCDPSession()
  try {
    await client.send('Input.insertText', { text })
  } finally {
    await client.detach()
  }
}

/**
 * Click an element by CSS selector using CDP DOM operations.
 * Avoids page.click() which uses Runtime.evaluate internally and hangs
 * when TradingView's JS event loop is saturated.
 */
async function cdpClickSelector(page: Page, selector: string): Promise<void> {
  const client = await page.createCDPSession()
  try {
    const { root } = await client.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await client.send('DOM.querySelector', {
      nodeId: root.nodeId,
      selector,
    })
    if (!nodeId) {
      throw new Error(`CDP: Element not found: ${selector}`)
    }
    // Get the element's bounding box via DOM.getBoxModel
    const { model } = await client.send('DOM.getBoxModel', { nodeId })
    // content quad: [x1,y1, x2,y2, x3,y3, x4,y4] — use center of the box
    const quad = model.content
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
    // Dispatch mouse events to click
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  } finally {
    await client.detach()
  }
}

// ============ CDP Publish Helper Functions ============
// These operate entirely via Chrome DevTools Protocol, bypassing JavaScript
// execution in the page context. This is critical because TradingView's JS
// event loop is saturated after script insertion (websocket feeds + chart
// rendering + Monaco compilation), causing page.evaluate() to hang.

import type { CDPSession } from 'puppeteer-core'

// ---- Low-level CDP helpers for publish flow ----

/** Find an element via CDP DOM.querySelector. Returns nodeId (0 = not found). */
async function cdpFind(client: CDPSession, selector: string, rootNodeId?: number): Promise<number> {
  try {
    if (!rootNodeId) {
      const { root } = await client.send('DOM.getDocument', { depth: 0 })
      rootNodeId = root.nodeId
    }
    const { nodeId } = await client.send('DOM.querySelector', { nodeId: rootNodeId, selector })
    return nodeId || 0
  } catch { return 0 }
}

/** Click an element by nodeId using CDP mouse events. */
async function cdpClickNode(client: CDPSession, nodeId: number): Promise<boolean> {
  try {
    const { model } = await client.send('DOM.getBoxModel', { nodeId })
    const quad = model.content
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
    if (x === 0 && y === 0) {
      console.log(`[CDP] clickNode ${nodeId}: zero coordinates, skipping`)
      return false
    }
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    return true
  } catch (err) {
    console.log(`[CDP] clickNode ${nodeId} failed: ${err instanceof Error ? err.message : 'unknown'}`)
    return false
  }
}

/** Find and click an element by selector. Returns true if clicked. */
async function cdpFindAndClick(client: CDPSession, selector: string): Promise<boolean> {
  const nodeId = await cdpFind(client, selector)
  if (!nodeId) return false
  return cdpClickNode(client, nodeId)
}

/** Get text content of an element via outerHTML (strips tags). */
async function cdpGetText(client: CDPSession, nodeId: number): Promise<string> {
  try {
    const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId })
    return outerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  } catch { return '' }
}

/** Focus an element by clicking it, select all text, then type new text. */
async function cdpFocusAndType(client: CDPSession, nodeId: number, text: string, page: Page): Promise<boolean> {
  const clicked = await cdpClickNode(client, nodeId)
  if (!clicked) return false
  await delay(200)
  // Select all existing text
  await page.keyboard.down('Control')
  await page.keyboard.press('a')
  await page.keyboard.up('Control')
  await delay(100)
  // Type new text via CDP Input.insertText
  await client.send('Input.insertText', { text })
  return true
}

/** Find all matching elements and return their nodeIds. */
async function cdpFindAll(client: CDPSession, selector: string, rootNodeId?: number): Promise<number[]> {
  try {
    if (!rootNodeId) {
      const { root } = await client.send('DOM.getDocument', { depth: 0 })
      rootNodeId = root.nodeId
    }
    const { nodeIds } = await client.send('DOM.querySelectorAll', { nodeId: rootNodeId, selector })
    return nodeIds || []
  } catch { return [] }
}

/**
 * Open the publish dialog and fill all fields using pure CDP DOM operations.
 *
 * MUST be called BEFORE script insertion into Monaco. Before insertion,
 * CDP DOM operations are fast (~1-2s each). After insertion, they slow to 60-120s.
 *
 * Unlike page.evaluate() which takes 150+ seconds even before insertion
 * (due to function body compilation on CPU-constrained VM), CDP operations
 * bypass JavaScript entirely and operate directly on the DOM.
 */
async function cdpOpenAndFillPublishDialog(
  page: Page,
  options: { title: string; description: string; visibility?: string }
): Promise<{ success: boolean; error?: string; log: string[] }> {
  const visibility = options.visibility || 'public'
  const log: string[] = []
  const client = await page.createCDPSession()

  try {
    // Step 1: Click publish button via CDP
    console.log('[Publish] Clicking publish button via CDP...')
    const pubBtnSels = [
      '[data-qa-id="publish-script"]',
      '[data-name="publish-script-button"]',
      '[data-name="save-publish-button"]',
    ]
    let clicked = false
    for (const sel of pubBtnSels) {
      if (await cdpFindAndClick(client, sel)) {
        log.push(`clicked:${sel}`)
        clicked = true
        break
      }
    }
    if (!clicked) {
      log.push('NO_PUBLISH_BUTTON')
      return { success: false, error: 'NO_PUBLISH_BUTTON', log }
    }
    console.log(`[Publish] Publish button clicked: ${log[0]}`)

    // Step 2: Wait for publish dialog content to appear
    // TradingView uses proprietary overlay wrappers (overlayScrollWrap-*) without
    // standard dialog attributes. Instead of finding a container, we directly
    // search the page for form fields that appear after clicking publish.
    await delay(3000)

    // Step 3: Fill title — search the ENTIRE page for title input
    // The publish dialog's title input should be the only visible text input
    // (Monaco editor uses contenteditable divs, not <input>)
    const titleSels = [
      'input[type="text"]',
      'input[name="title"]',
    ]
    let titleFilled = false
    for (let attempt = 0; attempt < 8; attempt++) {
      for (const sel of titleSels) {
        const nodeId = await cdpFind(client, sel)
        if (nodeId) {
          await cdpFocusAndType(client, nodeId, options.title, page)
          log.push(`title:${sel}`)
          titleFilled = true
          console.log(`[Publish] Title filled via ${sel}`)
          break
        }
      }
      if (titleFilled) break
      console.log(`[Publish] Title input not found (attempt ${attempt + 1}/8), waiting...`)
      await delay(2000)
    }
    if (!titleFilled) {
      log.push('title:NOT_FOUND')
      console.log('[Publish] Title input NOT FOUND after 8 attempts')
      await page.screenshot({ path: `/data/screenshots/publish-no-title-input.png` }).catch(() => {})
    }

    // Step 4: Fill description — search page for textarea/contenteditable
    const descSels = ['textarea', '[contenteditable="true"]', '[role="textbox"]']
    let descFilled = false
    for (const sel of descSels) {
      const nodeId = await cdpFind(client, sel)
      if (nodeId) {
        await cdpFocusAndType(client, nodeId, options.description, page)
        log.push(`desc:${sel}`)
        descFilled = true
        console.log(`[Publish] Description filled via ${sel}`)
        break
      }
    }
    if (!descFilled) log.push('desc:NOT_FOUND')

    await delay(500)

    // Step 5-7: Check checkboxes, Continue, and visibility
    // IMPORTANT: Search ONLY within overlay containers to avoid iterating
    // all 225+ buttons on TradingView's chart page (~2-3s per CDP call).
    // Find the overlay wrapper that appeared after clicking publish.
    const overlayNodes = await cdpFindAll(client, '[class*="overlayScrollWrap"]')
    const overlayId = overlayNodes.length > 0 ? overlayNodes[overlayNodes.length - 1] : 0
    console.log(`[Publish] Found ${overlayNodes.length} overlay wrappers, using last one`)

    if (overlayId) {
      // Check checkboxes within overlay only
      const checkboxes = await cdpFindAll(client, 'input[type="checkbox"]', overlayId)
      let checkedCount = 0
      for (const cbId of checkboxes) {
        try {
          const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId: cbId })
          if (!outerHTML.includes('checked')) {
            await cdpClickNode(client, cbId)
            checkedCount++
          }
        } catch {}
      }
      if (checkedCount > 0) log.push(`checkboxes:${checkedCount}`)

      // Look for Continue button within overlay only
      const overlayBtns = await cdpFindAll(client, 'button', overlayId)
      console.log(`[Publish] Overlay has ${overlayBtns.length} buttons`)
      for (const btnId of overlayBtns) {
        const text = await cdpGetText(client, btnId)
        if (text.toLowerCase().includes('continue') && !text.toLowerCase().includes('discontinue')) {
          await cdpClickNode(client, btnId)
          log.push('continue:clicked')
          console.log('[Publish] Clicked Continue button')
          await delay(2000)
          break
        }
      }

      // Set visibility if private
      if (visibility === 'private') {
        for (const btnId of overlayBtns) {
          const text = await cdpGetText(client, btnId)
          if (text.toLowerCase().includes('private') || text.toLowerCase().includes('invite')) {
            await cdpClickNode(client, btnId)
            log.push('vis:private')
            console.log('[Publish] Set visibility to private')
            break
          }
        }
      }
    } else {
      log.push('no-overlay-for-buttons')
    }

    console.log(`[Publish] Dialog fill complete: ${JSON.stringify(log)}`)
    // Consider success if we at least clicked the publish button
    // Title/desc may not be found if dialog uses non-standard elements
    return { success: titleFilled || descFilled, log }

  } catch (error) {
    log.push(`error:${error instanceof Error ? error.message : 'unknown'}`)
    console.error('[Publish] CDP dialog error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'CDP dialog error', log }
  } finally {
    await client.detach().catch(() => {})
  }
}

/**
 * Click the final "Publish script" button using CDP.
 *
 * Called AFTER script insertion + Monaco compile. JS is saturated at this point,
 * so we use CDP DOM operations. Uses XPath search (DOM.performSearch) to find
 * the button in a SINGLE CDP call instead of iterating 225+ buttons.
 */
async function cdpClickFinalPublish(page: Page): Promise<{ success: boolean; indicatorUrl?: string; error?: string }> {
  // Overall timeout: 3 minutes max for the entire publish submit flow.
  // Without this, the function can hang indefinitely when TradingView's
  // publish dialog doesn't appear or CDP operations stall under CPU pressure.
  const PUBLISH_TIMEOUT_MS = 180_000
  const timeoutPromise = new Promise<{ success: false; error: string }>((resolve) =>
    setTimeout(() => resolve({ success: false, error: 'PUBLISH_SUBMIT_TIMEOUT' }), PUBLISH_TIMEOUT_MS)
  )

  const publishPromise = cdpClickFinalPublishInner(page)
  return Promise.race([publishPromise, timeoutPromise])
}

async function cdpClickFinalPublishInner(page: Page): Promise<{ success: boolean; indicatorUrl?: string; error?: string }> {
  const browser = page.browser()
  const client = await page.createCDPSession()

  // Listen for new tab (publish may open script page)
  const newPagePromise = new Promise<Page | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), 120000)
    browser.once('targetcreated', async (target) => {
      if (target.type() === 'page') {
        clearTimeout(timeout)
        resolve(await target.page())
      }
    })
  })

  try {
    let publishClicked = false

    // Use XPath to find "Publish" buttons in a SINGLE CDP call.
    // This avoids iterating 225+ buttons at 60-120s each.
    // Must enable DOM agent first for performSearch to work.
    await client.send('DOM.enable')
    // Shallow DOM refresh — depth: 0 is much faster than depth: -1
    // performSearch still works because it searches the full document
    await client.send('DOM.getDocument', { depth: 0 })
    console.log('[Publish] DOM tree refreshed')

    // Only search for generic "publish" — "publish script" always returns 0.
    // submit type also returns 0. One query saves ~30-60s post-insertion.
    const xpathQueries = [
      '//button[contains(translate(., "PUBLISH", "publish"), "publish")]',
    ]

    for (const xpath of xpathQueries) {
      try {
        const { searchId, resultCount } = await client.send('DOM.performSearch', { query: xpath })
        console.log(`[Publish] XPath "${xpath.substring(0, 50)}": ${resultCount} results`)

        if (resultCount > 0) {
          const { nodeIds } = await client.send('DOM.getSearchResults', {
            searchId,
            fromIndex: 0,
            toIndex: Math.min(resultCount, 5),
          })
          await client.send('DOM.discardSearchResults', { searchId })

          // Iterate in REVERSE — dialog submit button is consistently last in DOM order.
          // Hidden toolbar/menu buttons come first and waste 10-20s each on failed getBoxModel.
          const reversedIds = [...nodeIds].reverse()
          for (const nodeId of reversedIds) {
            if (nodeId) {
              console.log(`[Publish] Trying nodeId=${nodeId}`)
              // Try getBoxModel click first
              let clicked = await cdpClickNode(client, nodeId)
              if (!clicked) {
                // Fallback: focus the node and press Enter (bypasses box model)
                try {
                  await client.send('DOM.focus', { nodeId })
                  await client.send('Input.dispatchKeyEvent', {
                    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
                  })
                  await client.send('Input.dispatchKeyEvent', {
                    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
                  })
                  console.log(`[Publish] Clicked via focus+Enter: nodeId=${nodeId}`)
                  clicked = true
                } catch (focusErr) {
                  console.log(`[Publish] Focus+Enter failed for nodeId=${nodeId}: ${focusErr instanceof Error ? focusErr.message : 'unknown'}`)
                }
              }
              if (clicked) {
                console.log(`[Publish] Submit clicked: nodeId=${nodeId}`)
                publishClicked = true
                break
              }
            }
          }
        } else {
          await client.send('DOM.discardSearchResults', { searchId })
        }
      } catch (err) {
        console.log(`[Publish] XPath search failed: ${err instanceof Error ? err.message : 'unknown'}`)
      }
      if (publishClicked) break
    }

    if (!publishClicked) {
      // Fallback: try CSS selector-based approach with fresh DOM document
      console.log('[Publish] XPath click failed, trying CSS selector fallback...')
      try {
        const { root } = await client.send('DOM.getDocument', { depth: -1 })
        // Look for a submit button or button with "Publish" in specific overlay containers
        const selectors = [
          'button[data-qa-id="submit-publish"]',
          'button[type="submit"]',
          '[class*="overlayScrollWrap"] button',
        ]
        for (const sel of selectors) {
          try {
            const { nodeId: foundNode } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel })
            if (foundNode) {
              const text = await cdpGetText(client, foundNode)
              console.log(`[Publish] CSS fallback found: ${sel} => "${text.substring(0, 40)}"`)
              if (text.toLowerCase().includes('publish')) {
                const clicked = await cdpClickNode(client, foundNode)
                if (clicked) {
                  console.log(`[Publish] Clicked via CSS fallback: ${sel}`)
                  publishClicked = true
                  break
                }
              }
            }
          } catch {}
        }
      } catch (err) {
        console.log(`[Publish] CSS fallback error: ${err instanceof Error ? err.message : 'unknown'}`)
      }
    }

    if (!publishClicked) {
      // Last resort: take a screenshot for debugging and report failure
      console.log('[Publish] All click methods failed — dialog may have closed')
      try {
        await page.screenshot({ path: '/data/screenshots/publish-click-failed.png', fullPage: true })
        console.log('[Publish] Screenshot saved: publish-click-failed.png')
      } catch {}
      return { success: false, error: 'DIALOG_CLOSED_DURING_INSERTION' }
    }

    // Wait for result
    await delay(5000)

    // Check for new tab
    const newPage = await Promise.race([
      newPagePromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
    ])

    if (newPage) {
      try {
        await delay(3000)
        const newTabUrl = newPage.url()
        console.log(`[Publish] New tab URL: ${newTabUrl}`)
        await newPage.close().catch(() => {})
        if (newTabUrl.includes('/script/')) {
          return { success: true, indicatorUrl: newTabUrl }
        }
      } catch {
        console.log('[Publish] Error reading new tab')
      }
    }

    // Check for script links in DOM
    try {
      const linkNodes = await cdpFindAll(client, 'a[href*="/script/"]')
      for (const linkId of linkNodes) {
        const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId: linkId })
        const hrefMatch = outerHTML.match(/href="([^"]*\/script\/[^"]*)"/)
        if (hrefMatch) {
          const href = hrefMatch[1]
          const url = href.startsWith('http') ? href : `https://www.tradingview.com${href}`
          console.log(`[Publish] Found script link: ${url}`)
          return { success: true, indicatorUrl: url }
        }
      }
    } catch {}

    console.log('[Publish] Submit clicked but no URL captured')
    return { success: true, indicatorUrl: undefined }

  } catch (error) {
    console.error('[Publish] CDP error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'CDP publish error' }
  } finally {
    await client.detach().catch(() => {})
  }
}


/**
 * Extract validation errors from the console panel using CDP DOM operations.
 *
 * IMPORTANT: We cannot use page.$(), page.$$(), or ElementHandle.evaluate()
 * because they all use Runtime.callFunctionOn which hangs when TradingView's
 * JS event loop is saturated (after script insertion).
 *
 * Instead, we use CDP DOM.querySelector + DOM.getOuterHTML which operate via
 * the DOM agent (separate from the JS engine) and don't require JS execution.
 *
 * Capped at 60s to avoid hanging.
 */
async function extractConsoleErrors(page: Page): Promise<{
  errors: Array<{ line: number; message: string; type: 'error' | 'warning' }>
  rawOutput: string
}> {
  return Promise.race([
    _extractConsoleErrorsCDP(page),
    new Promise<{ errors: Array<{ line: number; message: string; type: 'error' | 'warning' }>; rawOutput: string }>(
      (_, reject) => setTimeout(() => reject(new Error('extractConsoleErrors timed out (60s)')), 60000)
    ),
  ]).catch((err) => {
    console.warn(`[Warm Validate] Error extraction failed: ${err}`)
    return { errors: [], rawOutput: '' }
  })
}

async function _extractConsoleErrorsCDP(page: Page): Promise<{
  errors: Array<{ line: number; message: string; type: 'error' | 'warning' }>
  rawOutput: string
}> {
  const client = await page.createCDPSession()
  try {
    // Get the document root
    const { root } = await client.send('DOM.getDocument', { depth: 0 })

    // Find console panel
    const consolePanelSelectors = ['[data-name="console-panel"]', '.console-panel']
    let consolePanelNodeId = 0

    for (const sel of consolePanelSelectors) {
      try {
        const result = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel })
        if (result.nodeId) {
          consolePanelNodeId = result.nodeId
          break
        }
      } catch {
        // Selector may not match
      }
    }

    if (!consolePanelNodeId) {
      console.log('[Warm Validate] Console panel not found via CDP DOM')
      return { errors: [], rawOutput: '' }
    }

    // Get full HTML of console panel to extract text
    const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId: consolePanelNodeId })

    // Parse errors from HTML text (strip HTML tags to get text content)
    const textContent = outerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

    // Look for error patterns in the text
    const errors: Array<{ line: number; message: string; type: 'error' | 'warning' }> = []

    // Pine Script errors follow patterns like "line X: error message" or "Error at line X"
    const errorPattern = /(?:line\s+(\d+)[:\s]+(.+?)(?=(?:line\s+\d+|$)))/gi
    let match
    while ((match = errorPattern.exec(textContent)) !== null) {
      errors.push({
        line: parseInt(match[1], 10),
        message: match[0].trim(),
        type: 'error',
      })
    }

    // Also check for general error indicators
    if (errors.length === 0 && (textContent.toLowerCase().includes('error') || textContent.toLowerCase().includes('could not'))) {
      errors.push({
        line: 0,
        message: textContent.substring(0, 500),
        type: 'error',
      })
    }

    console.log(`[Warm Validate] CDP DOM extracted: ${textContent.length} chars, ${errors.length} errors`)
    return { errors, rawOutput: textContent }
  } finally {
    await client.detach().catch(() => {})
  }
}

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

    // The warm browser has Chromium pre-launched with auth cookies injected,
    // but NO TradingView page loaded (to avoid the stale/hung page problem).
    // Navigate to /chart/ fresh — this takes ~15-30s but the browser is already
    // running so we skip the ~15s Chromium launch time.
    console.log('[ValidationLoop] Navigating warm browser to /chart/...')
    await page.goto('https://www.tradingview.com/chart/', {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    })
    console.log('[ValidationLoop] Page loaded, waiting for sidebar...')

    // Wait for sidebar button to render then open Pine Editor
    const pineBtn = await page.waitForSelector(
      '[data-name="pine-dialog-button"], [data-name="open-pine-editor"]',
      { timeout: 60000 }
    ).catch(() => null)
    if (!pineBtn) {
      console.log('[ValidationLoop] Sidebar buttons did not render in 60s')
      return null // Fall back to cold path
    }
    await pineBtn.click()
    console.log('[ValidationLoop] Clicked Pine Editor button')

    const editorExists = await page.waitForSelector('.monaco-editor', { timeout: 60000 }).catch(() => null)
    if (!editorExists) {
      console.log('[ValidationLoop] Pine Editor did not open in 60s')
      return null // Fall back to cold path
    }
    console.log('[ValidationLoop] Pine Editor opened successfully')

    timer.mark('pine editor ready')

    // === DIALOG-FIRST APPROACH ===
    // Fill publish dialog BEFORE script insertion (CDP operations are ~1-2s each).
    // After insertion, CDP operations slow to ~30-60s each due to CPU saturation.
    // The dialog stays open during script insertion — tested: the submit button
    // (last in DOM order, nodeId ~1381) retains its box model and is clickable.
    // Three hidden toolbar "Publish" buttons also exist in DOM but always fail
    // getBoxModel — reverse iteration skips them immediately.
    let indicatorUrl: string | undefined
    let publishError: string | undefined

    if (publishOptions) {
      timer.mark('starting publish dialog')
      try {
        console.log('[Warm Validate] Opening publish dialog via CDP (pre-insertion)...')
        const dialogResult = await cdpOpenAndFillPublishDialog(page, {
          title: publishOptions.title,
          description: publishOptions.description,
          visibility: publishOptions.visibility,
        })

        if (!dialogResult.success) {
          publishError = dialogResult.error
          console.log(`[Warm Validate] Publish dialog failed: ${publishError}`)
        } else {
          console.log('[Warm Validate] Publish dialog filled, proceeding to script insertion')
        }
        timer.mark('publish dialog filled')
      } catch (error) {
        publishError = error instanceof Error ? error.message : 'Unknown publish dialog error'
        console.error('[Warm Validate] Publish dialog error:', error)
      }
    }

    // === INSERT SCRIPT ===
    console.log('[Warm Validate] Inserting script via CDP...')
    await cdpClickSelector(page, '.monaco-editor .view-line')
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')
    await delay(100)
    await cdpInsertText(page, script)
    console.log('[Warm Validate] Script inserted')

    console.log('[Warm Validate] Waiting for Monaco to compile...')
    await delay(15000)
    console.log('[Warm Validate] Compile wait done')

    // === CLICK FINAL PUBLISH (after insertion + compile) ===
    // The dialog submit button is still in the DOM with valid box model.
    // Reverse XPath iteration finds it on the first try (~8s).
    if (publishOptions && !publishError) {
      timer.mark('starting publish submit')
      console.log('[Warm Validate] Clicking final Publish button via CDP...')
      try {
        const submitResult = await cdpClickFinalPublish(page)
        if (submitResult.success) {
          indicatorUrl = submitResult.indicatorUrl
          console.log(`[Warm Validate] Published: ${indicatorUrl || '(no URL captured)'}`)
        } else {
          publishError = submitResult.error
          console.log(`[Warm Validate] Final publish failed: ${publishError}`)
        }
      } catch (error) {
        publishError = error instanceof Error ? error.message : 'Publish submit error'
        console.error('[Warm Validate] Publish submit error:', error)
      }
      timer.mark('publish complete')
    }

    // === VALIDATE (add to chart + extract errors) ===
    // Click "Add to chart" using keyboard shortcut — after this, JS saturates
    // and only CDP Input.* operations work.
    console.log('[Warm Validate] Adding script to chart via keyboard...')
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')
    console.log('[Warm Validate] Sent Ctrl+Enter (Add to chart)')

    // Wait for compilation/add-to-chart result
    await delay(10000)
    console.log('[Warm Validate] Waiting for compilation result...')

    // Extract errors from console using CDP DOM operations (no page.evaluate)
    const { errors, rawOutput } = await extractConsoleErrors(page)

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

          // Re-validate with fixed script (CDP Input.insertText + keyboard)
          console.log('[Warm Validate] Re-validating fixed script...')
          await page.keyboard.press('Tab')
          await delay(200)
          await page.keyboard.down('Control')
          await page.keyboard.press('a')
          await page.keyboard.up('Control')
          await delay(100)
          await cdpInsertText(page, currentScript)
          await delay(15000) // Wait for Monaco compile

          // Add to chart via keyboard
          await page.keyboard.down('Control')
          await page.keyboard.press('Enter')
          await page.keyboard.up('Control')
          await delay(10000)

          const { errors: fixedErrors } = await extractConsoleErrors(page)

          if (fixedErrors.filter(e => e.type === 'error').length === 0) {
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
