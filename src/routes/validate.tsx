import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { createServerFn } from '@tanstack/react-start'
import { validatePineScript } from '../server/tradingview'
import { analyzePineScript, generateCorrections } from '../server/ai'
import { getTVCredentials, hashScript, createPublishJob } from '../server/kv'
import { createCheckoutSession } from '../server/stripe'

interface ValidationState {
  script: string
  status: 'idle' | 'validating' | 'analyzing' | 'done' | 'error'
  tvResult?: {
    isValid: boolean
    errors: Array<{ line: number; message: string; type: 'error' | 'warning' }>
    rawOutput: string
  }
  aiAnalysis?: {
    hasIssues: boolean
    summary: string
    potentialProblems: string[]
  }
  corrections?: {
    corrections: Array<{
      line: number
      original: string
      corrected: string
      explanation: string
    }>
    summary: string
    correctedScript: string
  }
  error?: string
}

// Server function to validate script with TradingView
const validateWithTV = createServerFn()
  .handler(async (ctx: { data: { script: string; userId: string } }) => {
    const credentials = await getTVCredentials(ctx.data.userId)
    if (!credentials) {
      throw new Error('TradingView not connected')
    }

    const result = await validatePineScript(credentials, ctx.data.script)
    return result
  })

// Server function to get AI analysis
const getAIAnalysis = createServerFn()
  .handler(async (ctx: { data: { script: string } }) => {
    return analyzePineScript(ctx.data.script)
  })

// Server function to get AI corrections
const getAICorrections = createServerFn()
  .handler(async (ctx: { data: { script: string; errors: string } }) => {
    return generateCorrections(ctx.data.script, ctx.data.errors)
  })

// Server function to create checkout session
const createCheckout = createServerFn()
  .handler(async (ctx: { data: { script: string; userId: string; title: string; description: string; visibility: 'public' | 'private' } }) => {
    const { script, userId, title, description, visibility } = ctx.data
    const scriptHash = hashScript(script)

    // Create checkout session
    const checkout = await createCheckoutSession({
      scriptHash,
      userId,
    })

    // Create pending job
    await createPublishJob({
      userId,
      scriptHash,
      script,
      title,
      description,
      visibility,
      stripeSessionId: checkout.sessionId,
    })

    return { checkoutUrl: checkout.url }
  })

export const Route = createFileRoute('/validate')({
  component: ValidatePage,
})

function ValidatePage() {
  const navigate = useNavigate()
  const [state, setState] = useState<ValidationState>({
    script: '',
    status: 'idle',
  })
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'private'>('public')
  const [isCreatingCheckout, setIsCreatingCheckout] = useState(false)

  // Load script from session storage on mount
  // Use ref to prevent double validation in React StrictMode
  const validationStartedRef = useRef(false)

  useEffect(() => {
    // Prevent double validation from React StrictMode
    if (validationStartedRef.current) {
      return
    }

    const pendingScript = sessionStorage.getItem('pendingScript')
    if (pendingScript) {
      validationStartedRef.current = true
      setState((s) => ({ ...s, script: pendingScript }))
      // Start validation
      runValidation(pendingScript)
    } else {
      navigate({ to: '/' })
    }
  }, [navigate])

  const runValidation = async (script: string) => {
    setState((s) => ({ ...s, status: 'validating' }))

    try {
      // Get userId from localStorage
      const userId = localStorage.getItem('userId')
      if (!userId) {
        throw new Error('TradingView not connected')
      }

      // Run TV validation and AI analysis in parallel
      const [tvResult, aiAnalysis] = await Promise.all([
        validateWithTV({ data: { script, userId } }),
        getAIAnalysis({ data: { script } }),
      ])

      setState((s) => ({
        ...s,
        tvResult,
        aiAnalysis,
        status: 'analyzing',
      }))

      // If there are errors, get AI corrections
      if (!tvResult.isValid && tvResult.rawOutput) {
        const corrections = await getAICorrections({
          data: { script, errors: tvResult.rawOutput },
        })
        setState((s) => ({ ...s, corrections, status: 'done' }))
      } else {
        setState((s) => ({ ...s, status: 'done' }))
      }
    } catch (error) {
      setState((s) => ({
        ...s,
        status: 'error',
        error: error instanceof Error ? error.message : 'Validation failed',
      }))
    }
  }

  const handleProceedToPayment = async () => {
    if (!title.trim()) {
      alert('Please enter a title for your indicator')
      return
    }

    setIsCreatingCheckout(true)
    try {
      const userId = localStorage.getItem('userId')
      if (!userId) {
        alert('TradingView not connected')
        setIsCreatingCheckout(false)
        return
      }

      const result = await createCheckout({
        data: {
          script: state.script,
          userId,
          title: title.trim(),
          description: description.trim(),
          visibility,
        },
      })

      // Redirect to Stripe checkout
      window.location.href = result.checkoutUrl
    } catch (error) {
      console.error('Checkout error:', error)
      alert('Failed to create checkout session')
    } finally {
      setIsCreatingCheckout(false)
    }
  }

  const handleUseCorrectedScript = () => {
    if (state.corrections?.correctedScript) {
      setState((s) => ({
        ...s,
        script: s.corrections!.correctedScript,
        status: 'idle',
        tvResult: undefined,
        aiAnalysis: undefined,
        corrections: undefined,
      }))
      // Re-validate with corrected script
      runValidation(state.corrections.correctedScript)
    }
  }

  return (
    <div className="container">
      <div className="hero">
        <h1>Script Validation</h1>
        <p>Checking your Pine Script against TradingView</p>
      </div>

      {/* Status indicator */}
      <div className="status-bar">
        <div className={`status-step ${state.status !== 'idle' ? 'active' : ''}`}>
          1. Validating with TradingView
        </div>
        <div
          className={`status-step ${
            state.status === 'analyzing' || state.status === 'done' ? 'active' : ''
          }`}
        >
          2. AI Analysis
        </div>
        <div className={`status-step ${state.status === 'done' ? 'active' : ''}`}>3. Ready</div>
      </div>

      {/* Error state */}
      {state.status === 'error' && (
        <div className="card error-card">
          <h2>Validation Error</h2>
          <p>{state.error}</p>
          <button className="btn btn-primary" onClick={() => navigate({ to: '/' })}>
            Go Back
          </button>
        </div>
      )}

      {/* Loading state */}
      {(state.status === 'validating' || state.status === 'analyzing') && (
        <div className="card loading-card">
          <div className="spinner" />
          <p>
            {state.status === 'validating'
              ? 'Validating with TradingView...'
              : 'Analyzing with AI...'}
          </p>
        </div>
      )}

      {/* Results */}
      {state.status === 'done' && (
        <>
          {/* Validation Result */}
          <div className={`card ${state.tvResult?.isValid ? 'success-card' : 'warning-card'}`}>
            <div className="card-header">
              <h2>{state.tvResult?.isValid ? 'Script Valid!' : 'Issues Found'}</h2>
              <span
                className={`badge ${state.tvResult?.isValid ? 'badge-success' : 'badge-warning'}`}
              >
                {state.tvResult?.isValid
                  ? 'Ready to publish'
                  : `${state.tvResult?.errors.length} issue(s)`}
              </span>
            </div>

            {!state.tvResult?.isValid && state.tvResult?.errors && (
              <div className="errors-list">
                {state.tvResult.errors.map((error, i) => (
                  <div key={i} className={`error-item ${error.type}`}>
                    {error.line > 0 && <span className="line-number">Line {error.line}:</span>}
                    <span className="error-message">{error.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* AI Corrections */}
          {state.corrections && state.corrections.corrections.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h2>AI Suggested Corrections</h2>
              </div>

              <p className="summary">{state.corrections.summary}</p>

              <div className="corrections-list">
                {state.corrections.corrections.map((correction, i) => (
                  <div key={i} className="correction-item">
                    <div className="correction-header">
                      {correction.line > 0 && <span>Line {correction.line}</span>}
                    </div>
                    <div className="correction-diff">
                      <div className="diff-remove">- {correction.original}</div>
                      <div className="diff-add">+ {correction.corrected}</div>
                    </div>
                    <p className="explanation">{correction.explanation}</p>
                  </div>
                ))}
              </div>

              <button className="btn btn-secondary" onClick={handleUseCorrectedScript}>
                Apply Corrections & Re-validate
              </button>
            </div>
          )}

          {/* Publish Form - only show if valid */}
          {state.tvResult?.isValid && (
            <div className="card">
              <div className="card-header">
                <h2>Publish Your Indicator</h2>
              </div>

              <div className="form-group">
                <label htmlFor="title">Indicator Title</label>
                <input
                  id="title"
                  type="text"
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="My Custom Indicator"
                />
              </div>

              <div className="form-group">
                <label htmlFor="description">Description (optional)</label>
                <textarea
                  id="description"
                  className="input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe what your indicator does..."
                  rows={3}
                />
              </div>

              <div className="form-group">
                <label>Visibility</label>
                <div className="visibility-options">
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="visibility"
                      value="public"
                      checked={visibility === 'public'}
                      onChange={() => setVisibility('public')}
                    />
                    <span>Public</span>
                    <small>Anyone can view and use your indicator</small>
                  </label>
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="visibility"
                      value="private"
                      checked={visibility === 'private'}
                      onChange={() => setVisibility('private')}
                    />
                    <span>Private</span>
                    <small>Only you can see and use this indicator</small>
                  </label>
                </div>
              </div>

              <div className="price-info">
                <span className="price">$9.99</span>
                <span className="price-desc">One-time payment to publish</span>
              </div>

              <button
                className="btn btn-primary btn-large"
                onClick={handleProceedToPayment}
                disabled={isCreatingCheckout || !title.trim()}
              >
                {isCreatingCheckout ? 'Creating checkout...' : 'Proceed to Payment'}
              </button>
            </div>
          )}
        </>
      )}

      <div className="button-group">
        <button className="btn btn-secondary" onClick={() => navigate({ to: '/' })}>
          Start Over
        </button>
      </div>
    </div>
  )
}
