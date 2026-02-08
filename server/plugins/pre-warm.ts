/**
 * Pre-warm Plugin
 *
 * Starts Chrome initialization immediately when the server boots.
 * This eliminates cold start latency (~60s) for the first validation request.
 *
 * Runs automatically via Nitro's plugin system.
 */

import { isWarmLocalBrowserEnabled, startPreWarm } from '../../src/server/warm-session'
import { getServiceAccountCredentials } from '../../src/server/service-validation'

export default async function preWarmPlugin() {
  console.log('[Plugin:pre-warm] Initializing...')

  if (!isWarmLocalBrowserEnabled()) {
    console.log('[Plugin:pre-warm] USE_WARM_LOCAL_BROWSER is not enabled, skipping pre-warm')
    return
  }

  console.log('[Plugin:pre-warm] USE_WARM_LOCAL_BROWSER=true, starting pre-warm...')

  try {
    const credentials = await getServiceAccountCredentials()
    if (credentials) {
      startPreWarm(credentials)
      console.log('[Plugin:pre-warm] Pre-warm initiated (running in background)')
    } else {
      console.warn('[Plugin:pre-warm] No service account credentials available, skipping pre-warm')
    }
  } catch (error) {
    console.error('[Plugin:pre-warm] Failed to start pre-warm:', error)
  }
}
