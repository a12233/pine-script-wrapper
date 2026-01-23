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

import { randomUUID, createHash } from 'crypto'
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
import { publishPineScript, validateAndPublishPineScript, validateAndPublishWithWarmSession } from './tradingview'
import { startTimer } from './timing'
import {
  isWarmLocalBrowserEnabled,
  acquireSession,
  releaseSession,
  getSessionStats,
} from './warm-session'

// OpenRouter client
const openrouter = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
})

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4'

// ============ Request Deduplication ============
// Prevents duplicate requests from being processed (e.g., browser retry on timeout)
const inFlightRequests = new Map<string, Promise<ValidationLoopResult>>()

function getScriptHash(script: string): string {
  // SHA-256 hash for reliable deduplication (prevents collisions)
  return createHash('sha256').update(script).digest('hex')
}

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
 * Fix Pine Script errors using OpenRouter LLM
 *
 * @param script - The original Pine Script with errors
 * @param errors - Formatted error messages from TradingView
 * @returns The fixed script (complete code)
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
  const requestId = randomUUID().slice(0, 8)
  const scriptHash = getScriptHash(script)

  // Check for duplicate in-flight request
  const existingRequest = inFlightRequests.get(scriptHash)
  if (existingRequest) {
    console.log(`[ValidationLoop:${requestId}] Duplicate request detected - returning existing result`)
    return existingRequest
  }

  // Create and track the request promise
  const requestPromise = runValidationLoopInternal(script, maxRetries, publishOptions, requestId)
  inFlightRequests.set(scriptHash, requestPromise)

  try {
    return await requestPromise
  } finally {
    // Clean up after request completes
    inFlightRequests.delete(scriptHash)
  }
}

async function runValidationLoopInternal(
  script: string,
  maxRetries: number,
  publishOptions: PublishAfterValidationOptions | undefined,
  requestId: string
): Promise<ValidationLoopResult> {
  const timer = startTimer('ValidationLoop', 'validation loop')
  let currentScript = script
  let iterations = 0
  let fixAttempted = false
  let fixSuccessful = false
  let lastResult: FullValidationResult | null = null

  console.log(`[ValidationLoop:${requestId}] Starting validation loop...`)

  // Check if warm local browser is enabled for fast validation
  if (isWarmLocalBrowserEnabled()) {
    console.log(`[ValidationLoop:${requestId}] Using warm local browser (USE_WARM_LOCAL_BROWSER=true)`)
    const warmResult = await runValidationLoopWithWarmSession(
      script,
      maxRetries,
      publishOptions,
      timer,
      requestId
    )
    return warmResult
  }

  // If publish options provided and no retries needed, use combined function (single browser session)
  // This saves ~17s by reusing the browser session for both validation and publish
  if (publishOptions && maxRetries === 1) {
    console.log(`[ValidationLoop:${requestId}] Using combined validate+publish (single session optimization)`)
    iterations++
    console.log(`[ValidationLoop:${requestId}] Iteration ${iterations}: Validating script...`)

    const credentials = await getServiceAccountCredentials()
    if (!credentials) {
      timer.end()
      return {
        finalScript: currentScript,
        isValid: false,
        iterations,
        fixAttempted: false,
        fixSuccessful: false,
        finalErrors: [{
          line: 0,
          message: 'Service account authentication failed',
          type: 'error',
        }],
        rawOutput: '',
        addedToChart: false,
        publishError: 'Service account authentication failed',
      }
    }

    console.log(`[ValidationLoop:${requestId}] publishOptions from caller:`, JSON.stringify(publishOptions))
    const combinedResult = await validateAndPublishPineScript(credentials, currentScript, {
      title: publishOptions.title,
      description: publishOptions.description,
      visibility: publishOptions.visibility,
    }, requestId)

    timer.mark('combined validation + publish')

    if (combinedResult.validation.isValid) {
      console.log(`[ValidationLoop:${requestId}] Script is valid on first attempt`)
      if (combinedResult.publish) {
        timer.mark('publish complete')
        console.log(`[ValidationLoop:${requestId}] Script published successfully: ${combinedResult.publish.indicatorUrl}`)
      }
      timer.end()
      return {
        finalScript: currentScript,
        isValid: true,
        iterations,
        fixAttempted: false,
        fixSuccessful: false,
        finalErrors: [],
        rawOutput: combinedResult.validation.rawOutput,
        addedToChart: true,
        indicatorUrl: combinedResult.publish?.indicatorUrl,
        publishError: combinedResult.publish?.success === false ? combinedResult.publish.error : undefined,
      }
    }

    // Check if this was an infrastructure error (session disconnect, etc.)
    // If so, fail fast - don't retry with AI fix
    if (combinedResult.infrastructureError) {
      console.log(`[ValidationLoop:${requestId}] Infrastructure error - failing fast (no retry)`)
      timer.end()
      return {
        finalScript: currentScript,
        isValid: false,
        iterations,
        fixAttempted: false,
        fixSuccessful: false,
        finalErrors: combinedResult.validation.errors,
        rawOutput: combinedResult.validation.rawOutput,
        addedToChart: false,
        publishError: 'Infrastructure error. Please try again.',
      }
    }

    // Validation failed due to script errors - attempt AI fix
    console.log(`[ValidationLoop:${requestId}] Validation failed due to script errors, attempting AI fix...`)
    lastResult = {
      ...combinedResult.validation,
      addedToChart: false,
    }
  } else {
    // Standard flow: validate first, then publish separately
    iterations++
    console.log(`[ValidationLoop:${requestId}] Iteration ${iterations}: Validating script...`)
    lastResult = await validateWithServiceAccount(currentScript)
    timer.mark('first validation')

    if (lastResult.isValid) {
      console.log(`[ValidationLoop:${requestId}] Script is valid on first attempt`)

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
  }

  // Script has errors - attempt AI fix if retries available
  if (maxRetries > 0) {
    console.log(`[ValidationLoop:${requestId}] Script has errors, attempting AI fix...`)
    fixAttempted = true

    try {
      const errorString = formatErrorsForLLM(lastResult)
      const fixedScript = await fixPineScriptErrors(currentScript, errorString)

      // Sanity check: ensure we got a non-empty response
      if (!fixedScript || fixedScript.length < 10) {
        console.log(`[ValidationLoop:${requestId}] AI fix returned empty or invalid script`)
      } else {
        currentScript = fixedScript

        // Re-validate with fixed script
        iterations++
        console.log(`[ValidationLoop:${requestId}] Iteration ${iterations}: Re-validating fixed script...`)
        lastResult = await validateWithServiceAccount(currentScript)

        if (lastResult.isValid) {
          console.log(`[ValidationLoop:${requestId}] AI fix successful - script is now valid`)
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
          console.log(`[ValidationLoop:${requestId}] AI fix applied but script still has errors`)
        }
      }
    } catch (error) {
      console.error(`[ValidationLoop:${requestId}] AI fix failed:`, error)
      // Continue with original script's errors
    }
  }

  // Return final result (script is still invalid)
  console.log(`[ValidationLoop:${requestId}] Validation complete after ${iterations} iterations - script is invalid`)
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
 * Run validation loop using warm local browser session
 * This is the fast path (~8s) vs Browserless (~70s)
 */
async function runValidationLoopWithWarmSession(
  script: string,
  maxRetries: number,
  publishOptions: PublishAfterValidationOptions | undefined,
  timer: ReturnType<typeof startTimer>,
  requestId: string
): Promise<ValidationLoopResult> {
  let currentScript = script
  let iterations = 0
  let fixAttempted = false
  let fixSuccessful = false
  let lastResult: FullValidationResult | null = null

  // Get service account credentials
  const credentials = await getServiceAccountCredentials()
  if (!credentials) {
    timer.end()
    return {
      finalScript: currentScript,
      isValid: false,
      iterations: 0,
      fixAttempted: false,
      fixSuccessful: false,
      finalErrors: [{
        line: 0,
        message: 'Service account authentication failed',
        type: 'error',
      }],
      rawOutput: '',
      addedToChart: false,
      publishError: 'Service account authentication failed',
    }
  }

  // Acquire warm session
  let sessionAcquired = false
  try {
    console.log(`[ValidationLoop/Warm:${requestId}] Acquiring warm session...`)
    const stats = getSessionStats()
    console.log(`[ValidationLoop/Warm:${requestId}] Session stats: ${JSON.stringify(stats)}`)

    const session = await acquireSession(credentials)
    sessionAcquired = true
    timer.mark('warm session acquired')

    // First validation attempt
    iterations++
    console.log(`[ValidationLoop/Warm:${requestId}] Iteration ${iterations}: Validating script...`)

    const combinedResult = await validateAndPublishWithWarmSession(
      session.page,
      currentScript,
      publishOptions ? {
        title: publishOptions.title,
        description: publishOptions.description,
        visibility: publishOptions.visibility,
      } : undefined
    )

    timer.mark('warm validation complete')

    if (combinedResult.validation.isValid) {
      console.log(`[ValidationLoop/Warm:${requestId}] Script is valid on first attempt`)

      // Release session with success
      await releaseSession(true)
      sessionAcquired = false

      if (combinedResult.publish) {
        timer.mark('publish complete')
        console.log(`[ValidationLoop/Warm:${requestId}] Script published: ${combinedResult.publish.indicatorUrl}`)
      }

      timer.end()
      return {
        finalScript: currentScript,
        isValid: true,
        iterations,
        fixAttempted: false,
        fixSuccessful: false,
        finalErrors: [],
        rawOutput: combinedResult.validation.rawOutput,
        addedToChart: true,
        indicatorUrl: combinedResult.publish?.indicatorUrl,
        publishError: combinedResult.publish?.success === false ? combinedResult.publish.error : undefined,
      }
    }

    // Validation failed - store result for AI fix attempt
    lastResult = {
      ...combinedResult.validation,
      addedToChart: false,
    }

    // Release session before AI fix (don't block other requests)
    await releaseSession(true)
    sessionAcquired = false

    // Attempt AI fix if retries available
    if (maxRetries > 0) {
      console.log(`[ValidationLoop/Warm:${requestId}] Script has errors, attempting AI fix...`)
      fixAttempted = true

      try {
        const errorString = formatErrorsForLLM(lastResult)
        const fixedScript = await fixPineScriptErrors(currentScript, errorString)

        if (!fixedScript || fixedScript.length < 10) {
          console.log(`[ValidationLoop/Warm:${requestId}] AI fix returned empty or invalid script`)
        } else {
          currentScript = fixedScript
          timer.mark('AI fix generated')

          // Re-acquire session for second validation
          console.log(`[ValidationLoop/Warm:${requestId}] Re-acquiring warm session for fixed script...`)
          const retrySession = await acquireSession(credentials)
          sessionAcquired = true

          // Re-validate fixed script
          iterations++
          console.log(`[ValidationLoop/Warm:${requestId}] Iteration ${iterations}: Re-validating fixed script...`)

          const retryResult = await validateAndPublishWithWarmSession(
            retrySession.page,
            currentScript,
            publishOptions ? {
              title: publishOptions.title,
              description: publishOptions.description,
              visibility: publishOptions.visibility,
            } : undefined
          )

          await releaseSession(true)
          sessionAcquired = false

          if (retryResult.validation.isValid) {
            console.log(`[ValidationLoop/Warm:${requestId}] AI fix successful - script is now valid`)
            fixSuccessful = true
            timer.mark('AI fix successful')

            if (retryResult.publish) {
              timer.mark('publish complete')
              console.log(`[ValidationLoop/Warm:${requestId}] Script published: ${retryResult.publish.indicatorUrl}`)
            }

            timer.end()
            return {
              finalScript: currentScript,
              isValid: true,
              iterations,
              fixAttempted: true,
              fixSuccessful: true,
              finalErrors: [],
              rawOutput: retryResult.validation.rawOutput,
              addedToChart: true,
              indicatorUrl: retryResult.publish?.indicatorUrl,
              publishError: retryResult.publish?.success === false ? retryResult.publish.error : undefined,
            }
          } else {
            console.log(`[ValidationLoop/Warm:${requestId}] AI fix applied but script still has errors`)
            lastResult = {
              ...retryResult.validation,
              addedToChart: false,
            }
          }
        }
      } catch (error) {
        console.error(`[ValidationLoop/Warm:${requestId}] AI fix failed:`, error)
        // Release session if acquired during AI fix retry to prevent deadlock
        if (sessionAcquired) {
          await releaseSession(false)
          sessionAcquired = false
        }
      }
    }

    // Return final result (script is still invalid)
    console.log(`[ValidationLoop/Warm:${requestId}] Validation complete after ${iterations} iterations - script is invalid`)
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
  } catch (error) {
    console.error(`[ValidationLoop/Warm:${requestId}] Error:`, error)

    // Release session on error
    if (sessionAcquired) {
      await releaseSession(false)
    }

    timer.end()
    return {
      finalScript: currentScript,
      isValid: false,
      iterations,
      fixAttempted,
      fixSuccessful,
      finalErrors: [{
        line: 0,
        message: `Warm session validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        type: 'error',
      }],
      rawOutput: '',
      addedToChart: false,
    }
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
