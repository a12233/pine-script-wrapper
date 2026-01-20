/**
 * Service Account Validation Module
 *
 * Validates Pine Scripts using the app's own TradingView account (service account)
 * instead of user credentials. This allows for:
 * - End-to-end validation (compile + add to chart)
 * - No user authentication required for validation
 * - Centralized credential management
 */

import {
  loginWithCredentials,
  validatePineScript,
  type TVCredentials,
  type ValidationResult,
} from './tradingview'

// Cached service account credentials (in-memory)
let cachedServiceCredentials: TVCredentials | null = null
let credentialsCacheTime: number = 0
const CREDENTIALS_CACHE_TTL = 6 * 60 * 60 * 1000 // 6 hours

/**
 * Get service account credentials from environment variables
 * Uses TV_USERNAME and TV_PASSWORD env vars
 * Caches credentials to avoid repeated logins
 */
export async function getServiceAccountCredentials(): Promise<TVCredentials | null> {
  const TV_USERNAME = process.env.TV_USERNAME
  const TV_PASSWORD = process.env.TV_PASSWORD

  if (!TV_USERNAME || !TV_PASSWORD) {
    console.error('[ServiceValidation] TV_USERNAME and TV_PASSWORD environment variables are required')
    return null
  }

  // Check if cached credentials are still valid
  const now = Date.now()
  if (cachedServiceCredentials && (now - credentialsCacheTime) < CREDENTIALS_CACHE_TTL) {
    console.log('[ServiceValidation] Using cached service account credentials')
    return cachedServiceCredentials
  }

  // Login with environment credentials
  console.log('[ServiceValidation] Logging in with service account credentials...')
  const credentials = await loginWithCredentials()

  if (credentials) {
    cachedServiceCredentials = credentials
    credentialsCacheTime = now
    console.log('[ServiceValidation] Service account login successful, credentials cached')
  } else {
    console.error('[ServiceValidation] Service account login failed')
  }

  return credentials
}

/**
 * Clear cached service account credentials
 * Call this if credentials become invalid
 */
export function clearServiceAccountCache(): void {
  cachedServiceCredentials = null
  credentialsCacheTime = 0
  console.log('[ServiceValidation] Service account cache cleared')
}

/**
 * Extended validation result with add-to-chart status
 */
export interface FullValidationResult extends ValidationResult {
  addedToChart: boolean
}

/**
 * Validate a Pine Script using the service account
 * Performs both compilation and "add to chart" validation
 *
 * @param script - The Pine Script code to validate
 * @returns Validation result with errors and add-to-chart status
 */
export async function validateWithServiceAccount(script: string): Promise<FullValidationResult> {
  const credentials = await getServiceAccountCredentials()

  if (!credentials) {
    return {
      isValid: false,
      errors: [
        {
          line: 0,
          message: 'Service account authentication failed. Check TV_USERNAME and TV_PASSWORD environment variables.',
          type: 'error',
        },
      ],
      rawOutput: '',
      addedToChart: false,
    }
  }

  try {
    // Validate the script using TradingView
    const result = await validatePineScript(credentials, script)

    // For now, if compilation succeeds, we consider it "added to chart"
    // The validatePineScriptV2 already clicks "Add to Chart" during validation
    // TODO: Add explicit "add to chart" verification if needed
    const addedToChart = result.isValid

    return {
      ...result,
      addedToChart,
    }
  } catch (error) {
    console.error('[ServiceValidation] Validation failed:', error)

    // Clear cache in case credentials expired
    clearServiceAccountCache()

    return {
      isValid: false,
      errors: [
        {
          line: 0,
          message: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          type: 'error',
        },
      ],
      rawOutput: '',
      addedToChart: false,
    }
  }
}

/**
 * Format validation errors as a string for LLM consumption
 */
export function formatErrorsForLLM(result: FullValidationResult): string {
  if (result.isValid) {
    return 'No errors found. Script compiled successfully.'
  }

  const errorMessages = result.errors
    .filter(e => e.type === 'error')
    .map(e => `Line ${e.line}: ${e.message}`)
    .join('\n')

  const warningMessages = result.errors
    .filter(e => e.type === 'warning')
    .map(e => `Line ${e.line}: ${e.message}`)
    .join('\n')

  let output = ''

  if (errorMessages) {
    output += `ERRORS:\n${errorMessages}\n`
  }

  if (warningMessages) {
    output += `\nWARNINGS:\n${warningMessages}\n`
  }

  if (result.rawOutput) {
    output += `\nRAW CONSOLE OUTPUT:\n${result.rawOutput}`
  }

  return output
}
