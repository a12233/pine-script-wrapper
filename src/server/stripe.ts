import Stripe from 'stripe'

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY
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
    throw new Error('Stripe is not configured')
  }

  const { scriptHash, userId, priceInCents = 999, productName = 'Pine Script Publishing' } = params

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: productName,
            description: 'Validate and publish your Pine Script as a private TradingView indicator',
          },
          unit_amount: priceInCents,
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

  return {
    sessionId: session.id,
    url: session.url,
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
