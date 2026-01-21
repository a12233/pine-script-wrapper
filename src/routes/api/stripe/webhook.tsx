import { createFileRoute } from '@tanstack/react-router'
import { verifyWebhookEvent } from '../../../server/stripe'
import { getJobByStripeSession, updatePublishJob } from '../../../server/kv'

export const Route = createFileRoute('/api/stripe/webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const signature = request.headers.get('stripe-signature')
        if (!signature) {
          return Response.json({ error: 'Missing stripe-signature header' }, { status: 400 })
        }

        const rawBody = await request.text()
        if (!rawBody) {
          return Response.json({ error: 'Missing request body' }, { status: 400 })
        }

        try {
          // Verify the webhook signature
          const stripeEvent = await verifyWebhookEvent(rawBody, signature)

          // Handle checkout.session.completed event
          if (stripeEvent.type === 'checkout.session.completed') {
            const session = stripeEvent.data.object as {
              id: string
              payment_status: string
              metadata?: { scriptHash?: string; userId?: string }
            }

            console.log(`[Webhook] checkout.session.completed: ${session.id}`)

            // Only process if payment was successful
            if (session.payment_status === 'paid') {
              // Find the job associated with this session
              const job = await getJobByStripeSession(session.id)

              if (job) {
                console.log(`[Webhook] Found job ${job.jobId} for session ${session.id}`)

                // Just mark as completed - URL is already stored from validation+publish step
                // NO BROWSER AUTOMATION NEEDED
                if (job.status === 'pending') {
                  await updatePublishJob(job.jobId, { status: 'completed' })
                  console.log(`[Webhook] Job ${job.jobId} marked complete, URL: ${job.indicatorUrl}`)
                } else {
                  console.log(`[Webhook] Job ${job.jobId} already ${job.status}, skipping update`)
                }
              } else {
                console.warn(`[Webhook] No job found for session ${session.id}`)
              }
            }
          }

          // Return 200 to acknowledge receipt
          return Response.json({ received: true })
        } catch (error) {
          console.error('[Webhook] Error:', error)
          return Response.json(
            { error: error instanceof Error ? error.message : 'Webhook processing failed' },
            { status: 400 }
          )
        }
      },
    },
  },
})
