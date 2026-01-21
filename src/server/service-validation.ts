/**
 * Service Account Validation Module
 *
 * Validates Pine Scripts using the app's own TradingView account (service account)
 * instead of user credentials. This allows for:
 * - End-to-end validation (compile + add to chart)
 * - No user authentication required for validation
 * - Centralized credential management
 *
 * Session persistence:
 * - Sessions are stored in Redis to survive server restarts (no expiry)
 * - Sessions persist until cleared or auth fails
 * - Falls back to in-memory cache if Redis is unavailable
 */

import {
  loginWithCredentials,
  validatePineScript,
  type TVCredentials,
  type ValidationResult,
} from './tradingview'

import {
  saveServiceAccountSession,
  getServiceAccountSession,
  clearServiceAccountSession,
} from './kv'

// In-memory cache as fallback and for quick access (no expiry)
let cachedServiceCredentials: TVCredentials | null = null

/**
 * Get service account credentials from environment variables
 * Uses TV_USERNAME and TV_PASSWORD env vars
 * Caches credentials in Redis (persistent) and in-memory (fast)
 */
export async function getServiceAccountCredentials(): Promise<TVCredentials | null> {
  const TV_USERNAME = process.env.TV_USERNAME
  const TV_PASSWORD = process.env.TV_PASSWORD

  if (!TV_USERNAME || !TV_PASSWORD) {
    console.error('[ServiceValidation] TV_USERNAME and TV_PASSWORD environment variables are required')
    return null
  }

  // Check in-memory cache first (fastest, no expiry)
  if (cachedServiceCredentials) {
    console.log('[ServiceValidation] Using cached service account credentials')
    return cachedServiceCredentials
  }

  // Check Redis cache (survives restarts)
  try {
    const redisSession = await getServiceAccountSession()
    if (redisSession) {
      const credentials: TVCredentials = {
        sessionId: redisSession.sessionId,
        signature: redisSession.signature,
        userId: redisSession.userId,
      }
      // Update in-memory cache
      cachedServiceCredentials = credentials
      console.log('[ServiceValidation] Using service account credentials from Redis')
      return credentials
    }
  } catch (error) {
    console.error('[ServiceValidation] Failed to load session from Redis:', error)
  }

  // No valid cached session, need to login
  console.log('[ServiceValidation] Logging in with service account credentials...')
  const credentials = await loginWithCredentials()

  if (credentials) {
    // Update in-memory cache
    cachedServiceCredentials = credentials

    // Persist to Redis
    try {
      await saveServiceAccountSession({
        sessionId: credentials.sessionId,
        signature: credentials.signature,
        userId: credentials.userId,
        cachedAt: Date.now(),
      })
    } catch (error) {
      console.error('[ServiceValidation] Failed to save session to Redis:', error)
    }

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
export async function clearServiceAccountCache(): Promise<void> {
  cachedServiceCredentials = null

  try {
    await clearServiceAccountSession()
  } catch (error) {
    console.error('[ServiceValidation] Failed to clear session from Redis:', error)
  }

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
    await clearServiceAccountCache()

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
