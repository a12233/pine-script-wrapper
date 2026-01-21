import { createFileRoute } from '@tanstack/react-router'
import { verifyAdminAuth, unauthorizedResponse } from '../../../../server/admin-auth'
import { getLiveSession, closeLiveSession, extractSessionCookies } from '../../../../server/browserless'
import { saveServiceAccountSession } from '../../../../server/kv'

export const Route = createFileRoute('/api/admin/tv-session/finalize')({
  server: {
    handlers: {
      /**
       * POST /api/admin/tv-session/finalize
       *
       * Finalize a live session after manual login
       * Extracts cookies from the browser session and saves them to Redis
       *
       * Request body:
       * - sessionId: string - The session ID from the /live endpoint
       *
       * Headers:
       * - x-admin-key: Admin API key for authentication
       */
      POST: async ({ request }) => {
        // Verify admin authentication
        if (!verifyAdminAuth(request)) {
          return unauthorizedResponse()
        }

        try {
          const body = await request.json() as { sessionId?: string }
          const { sessionId } = body

          if (!sessionId) {
            return Response.json(
              { error: 'Missing required field: sessionId' },
              { status: 400 }
            )
          }

          console.log(`[Admin Finalize] Looking for session: ${sessionId}`)

          // Get the live session
          const session = getLiveSession(sessionId)
          if (!session) {
            return Response.json(
              { error: 'Session not found or expired. Sessions expire after 10 minutes.' },
              { status: 404 }
            )
          }

          // Check current URL to see if login was successful
          const currentUrl = session.page.url()
          console.log(`[Admin Finalize] Current page URL: ${currentUrl}`)

          // Extract cookies
          console.log('[Admin Finalize] Extracting session cookies...')
          const cookies = await extractSessionCookies(sessionId)

          if (!cookies) {
            return Response.json(
              {
                error: 'Session cookies not found. Please complete the login process in the live browser window.',
                currentUrl,
                hint: 'Make sure you are logged in and can see the TradingView dashboard before finalizing.',
              },
              { status: 400 }
            )
          }

          // Save to Redis
          console.log('[Admin Finalize] Saving session to Redis...')
          await saveServiceAccountSession({
            sessionId: cookies.sessionId,
            signature: cookies.sessionIdSign,
            userId: 'admin-live',
            cachedAt: Date.now(),
          })

          // Close the live session
          console.log('[Admin Finalize] Closing live session...')
          await closeLiveSession(sessionId)

          console.log('[Admin Finalize] Session finalized successfully')
          return Response.json({
            success: true,
            message: 'TradingView session saved successfully',
            finalUrl: currentUrl,
          })
        } catch (error) {
          console.error('[Admin Finalize] Error:', error)
          return Response.json(
            { error: error instanceof Error ? error.message : 'Finalize failed' },
            { status: 500 }
          )
        }
      },
    },
  },
})
