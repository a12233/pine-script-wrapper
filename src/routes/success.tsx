import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { createServerFn } from '@tanstack/react-start'
import { getJobByStripeSession, updatePublishJob } from '../server/kv'
import { getCheckoutSession } from '../server/stripe'
import { startTimer } from '../server/timing'

interface JobStatus {
  status: 'loading' | 'publishing' | 'success' | 'failed'
  indicatorUrl?: string
  error?: string
  script?: string
  originalScript?: string
  fixApplied?: boolean
  title?: string
}

// Server function to check payment status and return stored URL
// NO BROWSER AUTOMATION - URL was stored during validation+publish step
const checkJobStatus = createServerFn()
  .handler(async (ctx: { data: { sessionId: string } }) => {
    const timer = startTimer('Success', 'check job status')
    const { sessionId } = ctx.data

    // Get the job for this Stripe session
    const job = await getJobByStripeSession(sessionId)
    if (!job) {
      timer.end()
      return { status: 'failed' as const, error: 'Job not found' }
    }

    timer.mark('job found')

    // If already completed, return the result with script data
    if (job.status === 'completed') {
      timer.end()
      return {
        status: 'success' as const,
        indicatorUrl: job.indicatorUrl,
        script: job.script,
        originalScript: job.originalScript,
        fixApplied: job.fixApplied,
        title: job.title,
      }
    }

    if (job.status === 'failed') {
      timer.end()
      return { status: 'failed' as const, error: job.error }
    }

    // Check if payment was successful
    const checkout = await getCheckoutSession(sessionId)
    timer.mark('checkout checked')

    if (checkout.payment_status !== 'paid') {
      timer.end()
      return { status: 'failed' as const, error: 'Payment not completed' }
    }

    // Payment successful - just mark as completed and return stored URL
    // NO BROWSER AUTOMATION NEEDED - URL was stored during validation+publish step
    console.log(`[Success] Payment confirmed for job ${job.jobId}, returning stored URL: ${job.indicatorUrl}`)

    await updatePublishJob(job.jobId, { status: 'completed' })
    timer.mark('job marked complete')

    timer.end()
    return {
      status: 'success' as const,
      indicatorUrl: job.indicatorUrl,
      script: job.script,
      originalScript: job.originalScript,
      fixApplied: job.fixApplied,
      title: job.title,
    }
  })

export const Route = createFileRoute('/success')({
  component: SuccessPage,
})

/**
 * Compute which lines were changed between original and fixed script
 */
function getChangedLines(original: string, fixed: string): Set<number> {
  const originalLines = original.split('\n')
  const fixedLines = fixed.split('\n')
  const changedLines = new Set<number>()

  // Simple line-by-line comparison
  const maxLen = Math.max(originalLines.length, fixedLines.length)
  for (let i = 0; i < maxLen; i++) {
    if (originalLines[i] !== fixedLines[i]) {
      changedLines.add(i + 1) // 1-indexed line numbers
    }
  }

  return changedLines
}

/**
 * Download script as a .pine file
 */
function downloadScript(script: string, title: string) {
  const filename = `${title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.pine`
  const blob = new Blob([script], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

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
        <>
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

          {/* Show corrected script with diff highlighting if AI fix was applied */}
          {jobStatus.script && (
            <div className="card">
              <div className="card-header">
                <h2>{jobStatus.fixApplied ? 'Corrected Script' : 'Your Script'}</h2>
                {jobStatus.fixApplied && (
                  <span className="badge badge-success">AI Fixed</span>
                )}
              </div>

              {jobStatus.fixApplied && jobStatus.originalScript && (
                <p className="fix-info" style={{ marginBottom: '1rem', color: '#4ade80' }}>
                  Lines highlighted in green were automatically corrected by AI.
                </p>
              )}

              <div className="script-preview-container">
                <pre className="script-preview">
                  {(() => {
                    const lines = jobStatus.script.split('\n')
                    const changedLines = jobStatus.fixApplied && jobStatus.originalScript
                      ? getChangedLines(jobStatus.originalScript, jobStatus.script)
                      : new Set<number>()

                    return lines.map((line, i) => {
                      const lineNum = i + 1
                      const isChanged = changedLines.has(lineNum)
                      return (
                        <div
                          key={i}
                          className={`script-line ${isChanged ? 'line-changed' : ''}`}
                          style={{
                            backgroundColor: isChanged ? 'rgba(74, 222, 128, 0.15)' : 'transparent',
                            borderLeft: isChanged ? '3px solid #4ade80' : '3px solid transparent',
                            paddingLeft: '0.5rem',
                          }}
                        >
                          <span className="line-number" style={{ color: '#666', marginRight: '1rem', userSelect: 'none' }}>
                            {String(lineNum).padStart(3, ' ')}
                          </span>
                          <span>{line || ' '}</span>
                        </div>
                      )
                    })
                  })()}
                </pre>
              </div>

              <div className="button-group" style={{ marginTop: '1rem' }}>
                <button
                  className="btn btn-secondary"
                  onClick={() => downloadScript(jobStatus.script!, jobStatus.title || 'indicator')}
                >
                  Download Script (.pine)
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    navigator.clipboard.writeText(jobStatus.script!)
                    alert('Script copied to clipboard!')
                  }}
                >
                  Copy to Clipboard
                </button>
              </div>
            </div>
          )}
        </>
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
