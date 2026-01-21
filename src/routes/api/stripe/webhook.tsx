import { createFileRoute } from '@tanstack/react-router'
import { verifyWebhookEvent } from '../../../server/stripe'
import { getJobByStripeSession, updatePublishJob } from '../../../server/kv'
import { publishPineScript } from '../../../server/tradingview'
import { getServiceAccountCredentials } from '../../../server/service-validation'

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

                // Update job status to processing
                await updatePublishJob(job.jobId, { status: 'processing' })

                // Get service account credentials (no user credentials needed)
                const credentials = await getServiceAccountCredentials()

                if (credentials) {
                  try {
                    // Publish the script to TradingView using service account
                    const result = await publishPineScript(credentials, {
                      script: job.script,
                      title: job.title,
                      description: job.description,
                      visibility: job.visibility,
                    })

                    // Update job with success
                    await updatePublishJob(job.jobId, {
                      status: 'completed',
                      indicatorUrl: result.indicatorUrl,
                    })

                    console.log(`[Webhook] Published indicator: ${result.indicatorUrl}`)
                  } catch (publishError) {
                    // Update job with failure
                    const errorMessage = publishError instanceof Error ? publishError.message : 'Publishing failed'
                    await updatePublishJob(job.jobId, {
                      status: 'failed',
                      error: errorMessage,
                    })

                    console.error(`[Webhook] Publishing failed:`, publishError)
                  }
                } else {
                  await updatePublishJob(job.jobId, {
                    status: 'failed',
                    error: 'Service account authentication failed',
                  })

                  console.error(`[Webhook] Service account credentials not available`)
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
