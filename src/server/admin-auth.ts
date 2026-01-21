/**
 * Admin API authentication helper
 * Provides simple API key verification for admin endpoints
 */

const ADMIN_API_KEY = process.env.ADMIN_API_KEY

/**
 * Verify admin API key from request headers
 * @param request - The incoming request
 * @returns true if the admin key is valid, false otherwise
 */
export function verifyAdminAuth(request: Request): boolean {
  if (!ADMIN_API_KEY) {
    console.warn('[Admin Auth] ADMIN_API_KEY not configured')
    return false
  }

  const providedKey = request.headers.get('x-admin-key')
  if (!providedKey) {
    return false
  }

  return providedKey === ADMIN_API_KEY
}

/**
 * Create an unauthorized response
 * @returns 401 Unauthorized Response
 */
export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Check if admin API key is configured
 * @returns true if ADMIN_API_KEY env var is set
 */
export function isAdminAuthConfigured(): boolean {
  return !!ADMIN_API_KEY
}
