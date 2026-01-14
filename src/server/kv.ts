import { kv } from '@vercel/kv'
import crypto from 'crypto'

const ENCRYPTION_KEY = process.env.TV_CREDENTIAL_ENCRYPTION_KEY || 'default-dev-key-change-in-prod!'

// Session TTL: 24 hours
const SESSION_TTL = 60 * 60 * 24

// TV credentials TTL: 7 days (cookies typically last longer but we refresh)
const TV_CREDENTIALS_TTL = 60 * 60 * 24 * 7

// Job TTL: 1 hour (for pending publish jobs)
const JOB_TTL = 60 * 60

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
 */
function encrypt(text: string): string {
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return iv.toString('hex') + ':' + encrypted
}

function decrypt(encryptedText: string): string {
  const [ivHex, encrypted] = encryptedText.split(':')
  const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32)
  const iv = Buffer.from(ivHex, 'hex')
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

  await kv.set(`session:${userId}`, JSON.stringify(session), { ex: SESSION_TTL })
  return session
}

export async function getUserSession(userId: string): Promise<UserSession | null> {
  const data = await kv.get<string>(`session:${userId}`)
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
  await kv.set(`session:${userId}`, JSON.stringify(updated), { ex: SESSION_TTL })
}

// ============ TV Credentials ============

export async function storeTVCredentials(
  userId: string,
  credentials: TVCredentialsData
): Promise<void> {
  const encrypted = encrypt(JSON.stringify(credentials))
  await kv.set(`tv:${userId}`, encrypted, { ex: TV_CREDENTIALS_TTL })

  // Update session to mark TV as connected
  await updateUserSession(userId, { tvConnected: true })
}

export async function getTVCredentials(userId: string): Promise<TVCredentialsData | null> {
  const encrypted = await kv.get<string>(`tv:${userId}`)
  if (!encrypted) return null

  try {
    const decrypted = decrypt(encrypted)
    return JSON.parse(decrypted)
  } catch {
    return null
  }
}

export async function deleteTVCredentials(userId: string): Promise<void> {
  await kv.del(`tv:${userId}`)
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

  await kv.set(`job:${job.jobId}`, JSON.stringify(job), { ex: JOB_TTL })

  // Also index by stripe session for webhook lookup
  await kv.set(`stripe-job:${params.stripeSessionId}`, job.jobId, { ex: JOB_TTL })

  return job
}

export async function getPublishJob(jobId: string): Promise<PublishJob | null> {
  const data = await kv.get<string>(`job:${jobId}`)
  if (!data) return null
  return JSON.parse(data)
}

export async function getJobByStripeSession(stripeSessionId: string): Promise<PublishJob | null> {
  const jobId = await kv.get<string>(`stripe-job:${stripeSessionId}`)
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

  await kv.set(`job:${jobId}`, JSON.stringify(updated), { ex: JOB_TTL })
  return updated
}
