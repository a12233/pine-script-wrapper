import crypto from 'crypto'
import Redis from 'ioredis'

const ENCRYPTION_KEY = process.env.TV_CREDENTIAL_ENCRYPTION_KEY || 'default-dev-key-change-in-prod!'

// Session TTL: 24 hours
const SESSION_TTL = 60 * 60 * 24

// TV credentials TTL: 7 days (cookies typically last longer but we refresh)
const TV_CREDENTIALS_TTL = 60 * 60 * 24 * 7

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

export interface UserSession {
  userId: string
  tvConnected: boolean
  stripeCustomerId?: string
  createdAt: number
}

export interface TVCredentialsData {
  sessionId: string
  signature: string
  userId: string
  expiresAt: number
}

export interface PublishJob {
  jobId: string
  userId: string
  scriptHash: string
  script: string
  title: string
  description: string
  stripeSessionId: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  indicatorUrl?: string
  error?: string
  createdAt: number
  updatedAt: number
}

/**
 * Simple encryption for storing sensitive data
 * Uses random salt and IV for each encryption operation
 */
function encrypt(text: string): string {
  const salt = crypto.randomBytes(32) // Generate random salt for each encryption
  const key = crypto.scryptSync(ENCRYPTION_KEY, salt, 32)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  // Store salt:iv:encrypted to allow decryption
  return salt.toString('hex') + ':' + iv.toString('hex') + ':' + encrypted
}

function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':')

  // Handle both old format (iv:encrypted) and new format (salt:iv:encrypted)
  let salt: Buffer
  let iv: Buffer
  let encrypted: string

  if (parts.length === 3) {
    // New format with salt
    salt = Buffer.from(parts[0], 'hex')
    iv = Buffer.from(parts[1], 'hex')
    encrypted = parts[2]
  } else if (parts.length === 2) {
    // Old format without salt - use hardcoded salt for backward compatibility
    salt = Buffer.from('salt', 'utf8')
    iv = Buffer.from(parts[0], 'hex')
    encrypted = parts[1]
  } else {
    throw new Error('Invalid encrypted text format')
  }

  const key = crypto.scryptSync(ENCRYPTION_KEY, salt, 32)
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  let decrypted = decipher.update(encrypted, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
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

// ============ User Sessions ============

export async function createUserSession(userId: string): Promise<UserSession> {
  const session: UserSession = {
    userId,
    tvConnected: false,
    createdAt: Date.now(),
  }

  await store.set(`session:${userId}`, JSON.stringify(session), { ex: SESSION_TTL })
  return session
}

export async function getUserSession(userId: string): Promise<UserSession | null> {
  const data = await store.get<string>(`session:${userId}`)
  if (!data) return null
  return JSON.parse(data)
}

export async function updateUserSession(
  userId: string,
  updates: Partial<UserSession>
): Promise<void> {
  const session = await getUserSession(userId)
  if (!session) throw new Error('Session not found')

  const updated = { ...session, ...updates }
  await store.set(`session:${userId}`, JSON.stringify(updated), { ex: SESSION_TTL })
}

// ============ TV Credentials ============

export async function storeTVCredentials(
  userId: string,
  credentials: TVCredentialsData
): Promise<void> {
  const encrypted = encrypt(JSON.stringify(credentials))
  await store.set(`tv:${userId}`, encrypted, { ex: TV_CREDENTIALS_TTL })

  // Update session to mark TV as connected
  await updateUserSession(userId, { tvConnected: true })
}

export async function getTVCredentials(userId: string): Promise<TVCredentialsData | null> {
  const encrypted = await store.get<string>(`tv:${userId}`)
  if (!encrypted) return null

  try {
    const decrypted = decrypt(encrypted)
    return JSON.parse(decrypted)
  } catch {
    return null
  }
}

export async function deleteTVCredentials(userId: string): Promise<void> {
  await store.del(`tv:${userId}`)
  await updateUserSession(userId, { tvConnected: false })
}

// ============ Publish Jobs ============

export async function createPublishJob(
  params: Omit<PublishJob, 'jobId' | 'status' | 'createdAt' | 'updatedAt'>
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
