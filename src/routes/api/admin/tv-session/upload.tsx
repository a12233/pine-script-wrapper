import { createFileRoute } from '@tanstack/react-router'
import { verifyAdminAuth, unauthorizedResponse } from '../../../../server/admin-auth'
import { verifyTVSession } from '../../../../server/tradingview'
import { saveServiceAccountSession } from '../../../../server/kv'

export const Route = createFileRoute('/api/admin/tv-session/upload')({
  server: {
    handlers: {
      /**
       * POST /api/admin/tv-session/upload
       *
       * Upload TradingView session cookies directly from local browser
       * This allows bypassing CAPTCHA by using cookies extracted from a logged-in browser
       *
       * Request body:
       * - sessionId: string - The 'sessionid' cookie value from TradingView
       * - sessionIdSign: string - The 'sessionid_sign' cookie value from TradingView
       * - skipVerify: boolean (optional) - Skip TradingView verification (use when you know cookies are valid)
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
          const body = await request.json() as {
            sessionId?: string
            sessionIdSign?: string
            skipVerify?: boolean
          }

          const { sessionId, sessionIdSign, skipVerify } = body

          // Validate required fields
          if (!sessionId || !sessionIdSign) {
            return Response.json(
              { error: 'Missing required fields: sessionId and sessionIdSign' },
              { status: 400 }
            )
          }

          // Optionally verify the session works with TradingView
          if (!skipVerify) {
            console.log('[Admin Upload] Verifying session with TradingView...')
            const isValid = await verifyTVSession({
              sessionId,
              signature: sessionIdSign,
              userId: 'admin-upload',
            })

            if (!isValid) {
              return Response.json(
                { error: 'Invalid session - TradingView verification failed. Use skipVerify: true to bypass.' },
                { status: 400 }
              )
            }
          } else {
            console.log('[Admin Upload] Skipping verification (skipVerify=true)')
          }

          // Save to Redis
          console.log('[Admin Upload] Saving session to Redis...')
          await saveServiceAccountSession({
            sessionId,
            signature: sessionIdSign,
            userId: 'admin-upload',
            cachedAt: Date.now(),
          })

          console.log('[Admin Upload] Session saved successfully')
          return Response.json({
            success: true,
            message: 'TradingView session saved successfully',
            verified: !skipVerify,
          })
        } catch (error) {
          console.error('[Admin Upload] Error:', error)
          return Response.json(
            { error: error instanceof Error ? error.message : 'Upload failed' },
            { status: 500 }
          )
        }
      },
    },
  },
})
