import Stripe from 'stripe'

const STRIPE_SECRET_KEY = process.env.STRIPE_PROD_SECRET_KEY
const APP_URL = process.env.APP_URL || 'http://localhost:3000'

if (!STRIPE_SECRET_KEY) {
  console.warn('STRIPE_SECRET_KEY is not set - Stripe functionality will not work')
}

const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY)
  : null

export interface CreateCheckoutParams {
  scriptHash: string
  userId: string
  priceInCents?: number
  productName?: string
}

export interface CheckoutSession {
  sessionId: string
  url: string
}

/**
 * Create a Stripe Checkout session for one-time script publishing payment
 */
export async function createCheckoutSession(
  params: CreateCheckoutParams
): Promise<CheckoutSession> {
  if (!stripe) {
    console.error('[Stripe] Stripe is not configured - STRIPE_PROD_SECRET_KEY not set')
    throw new Error('Stripe is not configured')
  }

  console.log('[Stripe] Creating checkout session...')

  const { scriptHash, userId, priceInCents = 100, productName = 'Pine Script Publishing' } = params

  // Use existing Stripe product ID in production
  const STRIPE_PRODUCT_ID = 'prod_TnGtj83MsKmx7s'

  // Disable Link (save payment info) in dev to simplify testing
  const isDev = APP_URL.includes('localhost') || process.env.NODE_ENV === 'development'

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: isDev ? ['card'] : undefined, // undefined = let Stripe show all methods
      allow_promotion_codes: true, // Show promo code field in checkout
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product: STRIPE_PRODUCT_ID, // Use existing product from Stripe dashboard
            unit_amount: priceInCents, // $1.00
          },
          quantity: 1,
        },
      ],
      metadata: {
        scriptHash,
        userId,
      },
      success_url: `${APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/?canceled=true`,
    })

    if (!session.url) {
      throw new Error('Failed to create checkout session URL')
    }

    console.log('[Stripe] Checkout session created:', session.id)
    return {
      sessionId: session.id,
      url: session.url,
    }
  } catch (error) {
    console.error('[Stripe] Failed to create checkout session:', error)
    throw error
  }
}

/**
 * Retrieve a checkout session by ID
 */
export async function getCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
  if (!stripe) {
    throw new Error('Stripe is not configured')
  }

  return stripe.checkout.sessions.retrieve(sessionId)
}

/**
 * Verify and parse a Stripe webhook event
 */
export async function verifyWebhookEvent(
  payload: string | Buffer,
  signature: string
): Promise<Stripe.Event> {
  if (!stripe) {
    throw new Error('Stripe is not configured')
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!webhookSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set')
  }

  return stripe.webhooks.constructEvent(payload, signature, webhookSecret)
}

/**
 * Issue a refund for a payment
 */
export async function createRefund(paymentIntentId: string): Promise<Stripe.Refund> {
  if (!stripe) {
    throw new Error('Stripe is not configured')
  }

  return stripe.refunds.create({
    payment_intent: paymentIntentId,
    reason: 'requested_by_customer',
  })
}
