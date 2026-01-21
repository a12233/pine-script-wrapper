import { createFileRoute } from '@tanstack/react-router'
import { verifyAdminAuth, unauthorizedResponse } from '../../../../server/admin-auth'
import { createLiveSession, navigateTo, closeLiveSession } from '../../../../server/browserless'

export const Route = createFileRoute('/api/admin/tv-session/live')({
  server: {
    handlers: {
      /**
       * POST /api/admin/tv-session/live
       *
       * Start a live Browserless session for manual CAPTCHA solving
       * Returns a shareable URL where you can see and interact with the browser
       *
       * NOTE: The live URL feature requires Browserless.io "Sessions" plan feature.
       * If liveURL is null, use the cookie upload method instead (POST /api/admin/tv-session/upload)
       *
       * Headers:
       * - x-admin-key: Admin API key for authentication
       *
       * Response:
       * - sessionId: string - ID to use when finalizing the session
       * - liveURL: string | null - URL to open in browser to see/control the session
       *
       * After receiving liveURL:
       * 1. Open the liveURL in your browser
       * 2. Login to TradingView and solve any CAPTCHA
       * 3. Call POST /api/admin/tv-session/finalize with the sessionId
       */
      POST: async ({ request }) => {
        // Verify admin authentication
        if (!verifyAdminAuth(request)) {
          return unauthorizedResponse()
        }

        try {
          console.log('[Admin Live] Creating live Browserless session...')

          // Create live session with Browserless
          const session = await createLiveSession()

          // Check if we got a valid live URL
          if (!session.liveURL || session.liveURL.includes('Unable to get')) {
            // Clean up the session since we can't use it
            await closeLiveSession(session.sessionId)

            return Response.json({
              error: 'Live URL feature not available',
              message: 'The Browserless live URL feature may require a specific plan or configuration.',
              recommendation: 'Use the cookie upload method instead: POST /api/admin/tv-session/upload',
              uploadInstructions: [
                '1. Login to TradingView in your local browser',
                '2. Open DevTools > Application > Cookies > tradingview.com',
                '3. Copy the "sessionid" and "sessionid_sign" cookie values',
                '4. POST to /api/admin/tv-session/upload with: { "sessionId": "...", "sessionIdSign": "..." }',
              ],
            }, { status: 503 })
          }

          // Navigate to TradingView login page
          console.log('[Admin Live] Navigating to TradingView login page...')
          await navigateTo(session.page, 'https://www.tradingview.com/accounts/signin/')

          console.log(`[Admin Live] Session created: ${session.sessionId}`)
          console.log(`[Admin Live] Live URL: ${session.liveURL}`)

          return Response.json({
            sessionId: session.sessionId,
            liveURL: session.liveURL,
            instructions: [
              '1. Open the liveURL in your browser',
              '2. Login to TradingView and solve any CAPTCHA',
              '3. Wait for login to complete (you should see the TradingView dashboard)',
              '4. Call POST /api/admin/tv-session/finalize with the sessionId',
            ],
            expiresIn: '10 minutes',
          })
        } catch (error) {
          console.error('[Admin Live] Error:', error)
          return Response.json(
            { error: error instanceof Error ? error.message : 'Failed to create live session' },
            { status: 500 }
          )
        }
      },
    },
  },
})
