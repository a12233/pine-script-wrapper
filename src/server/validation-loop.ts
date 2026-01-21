/**
 * Validation Loop Module
 *
 * Orchestrates the validation process with automatic error fixing:
 * 1. Validate script with service account
 * 2. If errors, attempt AI-powered fix (1 retry max)
 * 3. Re-validate with fixed script
 * 4. Return final result
 */

import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import {
  validateWithServiceAccount,
  formatErrorsForLLM,
  type FullValidationResult,
} from './service-validation'
import {
  PINE_SCRIPT_FIX_SYSTEM_PROMPT,
  buildFixPrompt,
  extractPineScript,
} from './prompts/pine-script-fix'

// OpenRouter client
const openrouter = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
})

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4'

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
 * @returns Validation result with final script and status
 */
export async function runValidationLoop(
  script: string,
  maxRetries: number = 1
): Promise<ValidationLoopResult> {
  let currentScript = script
  let iterations = 0
  let fixAttempted = false
  let fixSuccessful = false
  let lastResult: FullValidationResult | null = null

  console.log('[ValidationLoop] Starting validation loop...')

  // First validation attempt
  iterations++
  console.log(`[ValidationLoop] Iteration ${iterations}: Validating script...`)
  lastResult = await validateWithServiceAccount(currentScript)

  if (lastResult.isValid) {
    console.log('[ValidationLoop] Script is valid on first attempt')
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
 * Quick validation without AI fix attempt
 * Useful for checking if a script is already valid
 */
export async function quickValidate(script: string): Promise<FullValidationResult> {
  console.log('[ValidationLoop] Quick validation (no fix attempt)...')
  return validateWithServiceAccount(script)
}
