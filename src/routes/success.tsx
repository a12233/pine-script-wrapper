import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { createServerFn } from '@tanstack/react-start'
import { getJobByStripeSession, updatePublishJob } from '../server/kv'
import { getCheckoutSession } from '../server/stripe'
import { publishPineScript } from '../server/tradingview'
import { getTVCredentials } from '../server/kv'

interface JobStatus {
  status: 'loading' | 'publishing' | 'success' | 'failed'
  indicatorUrl?: string
  error?: string
}

// Server function to check payment and publish status
const checkJobStatus = createServerFn()
  .handler(async (ctx: { data: { sessionId: string } }) => {
    const { sessionId } = ctx.data

    // Get the job for this Stripe session
    const job = await getJobByStripeSession(sessionId)
    if (!job) {
      return { status: 'failed' as const, error: 'Job not found' }
    }

    // If already completed, return the result
    if (job.status === 'completed') {
      return { status: 'success' as const, indicatorUrl: job.indicatorUrl }
    }

    if (job.status === 'failed') {
      return { status: 'failed' as const, error: job.error }
    }

    // If already processing, just wait (don't start another publish)
    if (job.status === 'processing') {
      return { status: 'publishing' as const }
    }

    // Check if payment was successful
    const checkout = await getCheckoutSession(sessionId)
    if (checkout.payment_status !== 'paid') {
      return { status: 'failed' as const, error: 'Payment not completed' }
    }

    // Payment successful, start publishing
    await updatePublishJob(job.jobId, { status: 'processing' })

    // Get TV credentials
    const credentials = await getTVCredentials(job.userId)
    if (!credentials) {
      await updatePublishJob(job.jobId, {
        status: 'failed',
        error: 'TradingView session expired',
      })
      return { status: 'failed' as const, error: 'TradingView session expired' }
    }

    // Publish the script
    const result = await publishPineScript(credentials, {
      script: job.script,
      title: job.title,
      description: job.description,
      visibility: job.visibility,
    })

    if (result.success) {
      await updatePublishJob(job.jobId, {
        status: 'completed',
        indicatorUrl: result.indicatorUrl || 'URL not available - check TradingView',
      })
      return {
        status: 'success' as const,
        indicatorUrl: result.indicatorUrl || undefined,
        // Note: URL may be undefined for private scripts
      }
    } else {
      await updatePublishJob(job.jobId, {
        status: 'failed',
        error: result.error || 'Publishing failed',
      })
      return { status: 'failed' as const, error: result.error || 'Publishing failed' }
    }
  })

export const Route = createFileRoute('/success')({
  component: SuccessPage,
})

function SuccessPage() {
  const navigate = useNavigate()
  const searchParams = useSearch({ from: '/success' }) as { session_id?: string }
  const session_id = searchParams.session_id
  const [jobStatus, setJobStatus] = useState<JobStatus>({ status: 'loading' })

  useEffect(() => {
    if (!session_id) {
      navigate({ to: '/' })
      return
    }

    // Poll for job status
    const checkStatus = async () => {
      try {
        const result = await checkJobStatus({ data: { sessionId: session_id } })
        setJobStatus(result)

        // If still publishing, poll again
        if (result.status === 'loading' || result.status === 'publishing') {
          setTimeout(checkStatus, 3000)
        }
      } catch (error) {
        setJobStatus({
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    checkStatus()
  }, [session_id, navigate])

  return (
    <div className="container">
      {jobStatus.status === 'loading' && (
        <div className="card loading-card">
          <div className="spinner" />
          <h2>Processing Payment...</h2>
          <p>Please wait while we confirm your payment.</p>
        </div>
      )}

      {jobStatus.status === 'publishing' && (
        <div className="card loading-card">
          <div className="spinner" />
          <h2>Publishing Your Indicator...</h2>
          <p>Your payment was successful! Now publishing to TradingView...</p>
        </div>
      )}

      {jobStatus.status === 'success' && (
        <div className="card success-card">
          <div className="success-icon">&#10003;</div>
          <h2>Published Successfully!</h2>
          <p>Your Pine Script indicator is now live on TradingView.</p>

          {jobStatus.indicatorUrl ? (
            <div className="indicator-url">
              <label>Your Indicator URL:</label>
              <a href={jobStatus.indicatorUrl} target="_blank" rel="noopener noreferrer">
                {jobStatus.indicatorUrl}
              </a>
              <button
                className="btn btn-secondary btn-small"
                onClick={() => navigator.clipboard.writeText(jobStatus.indicatorUrl!)}
              >
                Copy URL
              </button>
            </div>
          ) : (
            <div className="indicator-url">
              <p>Your script has been published as a private indicator.</p>
              <p>
                <a
                  href="https://www.tradingview.com/u/#published-scripts"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View your published scripts on TradingView →
                </a>
              </p>
            </div>
          )}

          <div className="button-group">
            <button className="btn btn-primary" onClick={() => navigate({ to: '/' })}>
              Publish Another Script
            </button>
          </div>
        </div>
      )}

      {jobStatus.status === 'failed' && (
        <div className="card error-card">
          <div className="error-icon">&#10007;</div>
          <h2>Publishing Failed</h2>
          <p>{jobStatus.error || 'An error occurred while publishing your indicator.'}</p>
          <p className="help-text">
            If your payment was processed, please contact support for assistance.
          </p>

          <div className="button-group">
            <button className="btn btn-primary" onClick={() => navigate({ to: '/' })}>
              Try Again
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
