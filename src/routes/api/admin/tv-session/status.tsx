import { createFileRoute } from '@tanstack/react-router'
import { verifyAdminAuth, unauthorizedResponse } from '../../../../server/admin-auth'
import { verifyTVSession } from '../../../../server/tradingview'
import { getServiceAccountSession } from '../../../../server/kv'

export const Route = createFileRoute('/api/admin/tv-session/status')({
  server: {
    handlers: {
      /**
       * GET /api/admin/tv-session/status
       *
       * Check the current TradingView session status
       *
       * Query params:
       * - verify: boolean (optional) - If true, verify session with TradingView
       *
       * Headers:
       * - x-admin-key: Admin API key for authentication
       *
       * Response:
       * - hasSession: boolean - Whether a session exists in Redis
       * - isValid: boolean | null - Whether the session is valid (only if verify=true)
       * - cachedAt: number | null - Timestamp when session was cached
       * - age: string | null - Human-readable age of the session
       */
      GET: async ({ request }) => {
        // Verify admin authentication
        if (!verifyAdminAuth(request)) {
          return unauthorizedResponse()
        }

        try {
          // Check query params for verify flag
          const url = new URL(request.url)
          const shouldVerify = url.searchParams.get('verify') === 'true'

          // Get session from Redis
          const session = await getServiceAccountSession()

          if (!session) {
            return Response.json({
              hasSession: false,
              isValid: null,
              cachedAt: null,
              age: null,
            })
          }

          // Calculate age
          const ageMs = Date.now() - session.cachedAt
          const ageMinutes = Math.floor(ageMs / (1000 * 60))
          const ageHours = Math.floor(ageMinutes / 60)
          const ageDays = Math.floor(ageHours / 24)

          let age: string
          if (ageDays > 0) {
            age = `${ageDays}d ${ageHours % 24}h ago`
          } else if (ageHours > 0) {
            age = `${ageHours}h ${ageMinutes % 60}m ago`
          } else {
            age = `${ageMinutes}m ago`
          }

          // Optionally verify the session still works
          let isValid: boolean | null = null
          if (shouldVerify) {
            console.log('[Admin Status] Verifying session with TradingView...')
            isValid = await verifyTVSession({
              sessionId: session.sessionId,
              signature: session.signature,
              userId: session.userId,
            })
            console.log(`[Admin Status] Session valid: ${isValid}`)
          }

          return Response.json({
            hasSession: true,
            isValid,
            cachedAt: session.cachedAt,
            age,
            userId: session.userId,
          })
        } catch (error) {
          console.error('[Admin Status] Error:', error)
          return Response.json(
            { error: error instanceof Error ? error.message : 'Status check failed' },
            { status: 500 }
          )
        }
      },
    },
  },
})
