import { createFileRoute } from '@tanstack/react-router'
import { verifyAdminAuth, unauthorizedResponse } from '../../../../server/admin-auth'
import { clearServiceAccountSession } from '../../../../server/kv'
import { clearServiceAccountCache } from '../../../../server/service-validation'

export const Route = createFileRoute('/api/admin/tv-session/')({
  server: {
    handlers: {
      /**
       * DELETE /api/admin/tv-session
       *
       * Clear the stored TradingView session
       * This removes the session from both Redis and in-memory cache
       *
       * Headers:
       * - x-admin-key: Admin API key for authentication
       */
      DELETE: async ({ request }) => {
        // Verify admin authentication
        if (!verifyAdminAuth(request)) {
          return unauthorizedResponse()
        }

        try {
          console.log('[Admin Delete] Clearing TradingView session...')

          // Clear from Redis
          await clearServiceAccountSession()

          // Clear from in-memory cache
          await clearServiceAccountCache()

          console.log('[Admin Delete] Session cleared successfully')
          return Response.json({
            success: true,
            message: 'TradingView session cleared',
          })
        } catch (error) {
          console.error('[Admin Delete] Error:', error)
          return Response.json(
            { error: error instanceof Error ? error.message : 'Delete failed' },
            { status: 500 }
          )
        }
      },
    },
  },
})
