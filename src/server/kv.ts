import crypto from 'crypto'
import Redis from 'ioredis'

// Job TTL: 1 hour (for pending publish jobs)
const JOB_TTL = 60 * 60

// ============ In-Memory Store (for local development) ============

interface StoreEntry {
  value: string
  expiresAt?: number
}

const memoryStore = new Map<string, StoreEntry>()

// Check if we have Redis configured
const REDIS_URL = process.env.REDIS_URL

// Lazy-load Redis only if configured
let redisClient: Redis | null = null

function getRedis(): Redis | null {
  if (!REDIS_URL) return null
  if (!redisClient) {
    redisClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
    })
    redisClient.on('error', (err) => console.error('Redis error:', err))
  }
  return redisClient
}

// Unified KV interface that works with both Redis and in-memory store
const store = {
  async get<T = string>(key: string): Promise<T | null> {
    const redis = getRedis()
    if (redis) {
      const value = await redis.get(key)
      if (!value) return null
      return value as T
    }

    // In-memory fallback
    const entry = memoryStore.get(key)
    if (!entry) return null
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      memoryStore.delete(key)
      return null
    }
    return entry.value as T
  },

  async set(key: string, value: string, options?: { ex?: number }): Promise<void> {
    const redis = getRedis()
    if (redis) {
      if (options?.ex) {
        await redis.set(key, value, 'EX', options.ex)
      } else {
        await redis.set(key, value)
      }
      return
    }

    // In-memory fallback
    const entry: StoreEntry = { value }
    if (options?.ex) {
      entry.expiresAt = Date.now() + options.ex * 1000
    }
    memoryStore.set(key, entry)
  },

  async del(key: string): Promise<void> {
    const redis = getRedis()
    if (redis) {
      await redis.del(key)
      return
    }

    // In-memory fallback
    memoryStore.delete(key)
  },
}

// Log which store we're using
if (!REDIS_URL) {
  console.log('📦 Using in-memory store (set REDIS_URL for Redis/Upstash)')
} else {
  console.log('📦 Using Redis for KV storage')
}

export interface PublishJob {
  jobId: string
  userId: string
  scriptHash: string
  script: string
  originalScript?: string // Original script before AI fix
  fixApplied?: boolean // Whether AI fix was applied
  title: string
  description: string
  visibility: 'public' | 'private'
  stripeSessionId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  indicatorUrl?: string
  error?: string
  createdAt: number
  updatedAt: number
}

/**
 * Generate a unique user ID
 */
export function generateUserId(): string {
  return crypto.randomUUID()
}

/**
 * Generate a unique job ID
 */
export function generateJobId(): string {
  return `job_${crypto.randomUUID()}`
}

/**
 * Create a hash of the script for idempotency
 */
export function hashScript(script: string): string {
  return crypto.createHash('sha256').update(script).digest('hex').slice(0, 16)
}

// ============ Publish Jobs ============

export async function createPublishJob(
  params: Omit<PublishJob, 'jobId' | 'status' | 'createdAt' | 'updatedAt'> & { indicatorUrl?: string }
): Promise<PublishJob> {
  const job: PublishJob = {
    ...params,
    jobId: generateJobId(),
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  await store.set(`job:${job.jobId}`, JSON.stringify(job), { ex: JOB_TTL })

  // Also index by stripe session for webhook lookup
  await store.set(`stripe-job:${params.stripeSessionId}`, job.jobId, { ex: JOB_TTL })

  return job
}

export async function getPublishJob(jobId: string): Promise<PublishJob | null> {
  const data = await store.get<string>(`job:${jobId}`)
  if (!data) return null
  return JSON.parse(data)
}

export async function getJobByStripeSession(stripeSessionId: string): Promise<PublishJob | null> {
  const jobId = await store.get<string>(`stripe-job:${stripeSessionId}`)
  if (!jobId) return null
  return getPublishJob(jobId)
}

export async function updatePublishJob(
  jobId: string,
  updates: Partial<PublishJob>
): Promise<PublishJob> {
  const job = await getPublishJob(jobId)
  if (!job) throw new Error('Job not found')

  const updated: PublishJob = {
    ...job,
    ...updates,
    updatedAt: Date.now(),
  }

  await store.set(`job:${jobId}`, JSON.stringify(updated), { ex: JOB_TTL })
  return updated
}

// ============ Service Account Session Storage ============
// Persists TradingView service account session to Redis to survive server restarts

// No TTL - sessions persist until cleared or auth fails
// TradingView sessions last indefinitely unless explicitly logged out

export interface ServiceAccountSession {
  sessionId: string
  signature: string
  userId: string
  cachedAt: number
}

const SERVICE_ACCOUNT_KEY = 'service-account:session'

/**
 * Save service account session to Redis
 * This allows the session to persist across server restarts
 */
export async function saveServiceAccountSession(session: ServiceAccountSession): Promise<void> {
  await store.set(SERVICE_ACCOUNT_KEY, JSON.stringify(session))
  console.log('[KV] Service account session saved to Redis (no expiry)')
}

/**
 * Get service account session from Redis
 * Returns null if no session exists or if it has expired
 */
export async function getServiceAccountSession(): Promise<ServiceAccountSession | null> {
  const data = await store.get<string>(SERVICE_ACCOUNT_KEY)
  if (!data) return null

  try {
    const session = JSON.parse(data) as ServiceAccountSession
    console.log('[KV] Service account session loaded from Redis')
    return session
  } catch {
    console.error('[KV] Failed to parse service account session')
    return null
  }
}

/**
 * Clear service account session from Redis
 * Call this when the session becomes invalid
 */
export async function clearServiceAccountSession(): Promise<void> {
  await store.del(SERVICE_ACCOUNT_KEY)
  console.log('[KV] Service account session cleared from Redis')
}
