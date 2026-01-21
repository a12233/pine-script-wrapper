import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { createServerFn } from '@tanstack/react-start'
import { runValidationLoop, type ValidationLoopResult } from '../server/validation-loop'
import { hashScript, createPublishJob, generateUserId } from '../server/kv'
import { createCheckoutSession, getProductDetails, type ProductDetails } from '../server/stripe'

interface ValidationState {
  script: string
  originalScript: string // Keep original for diff comparison
  status: 'idle' | 'validating' | 'done' | 'error'
  result?: ValidationLoopResult
  error?: string
}

// Server function to validate script using service account with auto-fix
const validateScript = createServerFn()
  .handler(async (ctx: { data: { script: string } }) => {
    return runValidationLoop(ctx.data.script, 1) // 1 retry max
  })

// Server function to fetch product details from Stripe
const fetchProductDetails = createServerFn()
  .handler(async () => {
    return getProductDetails()
  })

// Server function to create checkout session
const createCheckout = createServerFn()
  .handler(async (ctx: { data: { script: string; originalScript: string; fixApplied: boolean; title: string; description: string; visibility: 'public' | 'private' } }) => {
    const { script, originalScript, fixApplied, title, description, visibility } = ctx.data
    const scriptHash = hashScript(script)

    // Generate a userId for this transaction (no login required)
    const userId = generateUserId()

    // Create checkout session
    const checkout = await createCheckoutSession({
      scriptHash,
      userId,
    })

    // Create pending job (store original script if AI fix was applied)
    await createPublishJob({
      userId,
      scriptHash,
      script,
      originalScript: fixApplied ? originalScript : undefined,
      fixApplied,
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
    originalScript: '',
    status: 'idle',
  })
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'private'>('public')
  const [isCreatingCheckout, setIsCreatingCheckout] = useState(false)
  const [productDetails, setProductDetails] = useState<ProductDetails | null>(null)

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
      setState((s) => ({ ...s, script: pendingScript, originalScript: pendingScript }))
      // Start validation
      runValidation(pendingScript)
    } else {
      navigate({ to: '/' })
    }
  }, [navigate])

  // Fetch product details from Stripe on mount
  useEffect(() => {
    fetchProductDetails().then(setProductDetails).catch(console.error)
  }, [])

  const runValidation = async (script: string) => {
    setState((s) => ({ ...s, status: 'validating' }))

    try {
      const result = await validateScript({ data: { script } })

      setState((s) => ({
        ...s,
        script: result.finalScript, // Use the (possibly fixed) script
        result,
        status: 'done',
      }))
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
      const fixApplied = state.result?.fixAttempted && state.result?.fixSuccessful
      const result = await createCheckout({
        data: {
          script: state.script,
          originalScript: state.originalScript,
          fixApplied: !!fixApplied,
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

  const handleRetryValidation = () => {
    validationStartedRef.current = false
    setState((s) => ({
      ...s,
      status: 'idle',
      result: undefined,
      error: undefined,
    }))
    runValidation(state.script)
  }

  return (
    <div className="container">
      <div className="hero">
        <h1>Script Validation</h1>
        <p>Validating your Pine Script with TradingView</p>
      </div>

      {/* Status indicator */}
      <div className="status-bar">
        <div className={`status-step ${state.status !== 'idle' ? 'active' : ''}`}>
          1. Validating
        </div>
        <div className={`status-step ${state.result?.fixAttempted ? 'active' : ''}`}>
          2. Auto-Fix {state.result?.fixAttempted ? (state.result.fixSuccessful ? '(Applied)' : '(Attempted)') : ''}
        </div>
        <div className={`status-step ${state.status === 'done' ? 'active' : ''}`}>
          3. Ready
        </div>
      </div>

      {/* Error state */}
      {state.status === 'error' && (
        <div className="card error-card">
          <h2>Validation Error</h2>
          <p>{state.error}</p>
          <div className="button-group">
            <button className="btn btn-secondary" onClick={handleRetryValidation}>
              Retry
            </button>
            <button className="btn btn-primary" onClick={() => navigate({ to: '/' })}>
              Go Back
            </button>
          </div>
        </div>
      )}

      {/* Loading state */}
      {state.status === 'validating' && (
        <div className="card loading-card">
          <div className="spinner" />
          <p>Validating with TradingView...</p>
          <small>This may take a few seconds</small>
        </div>
      )}

      {/* Results */}
      {state.status === 'done' && state.result && (
        <>
          {/* Validation Result */}
          <div className={`card ${state.result.isValid ? 'success-card' : 'warning-card'}`}>
            <div className="card-header">
              <h2>{state.result.isValid ? 'Script Valid!' : 'Validation Failed'}</h2>
              <span
                className={`badge ${state.result.isValid ? 'badge-success' : 'badge-warning'}`}
              >
                {state.result.isValid
                  ? 'Ready to publish'
                  : `${state.result.finalErrors.length} error(s)`}
              </span>
            </div>

            {/* Show if AI fix was applied */}
            {state.result.fixAttempted && (
              <div className="fix-info">
                {state.result.fixSuccessful ? (
                  <p className="fix-success">
                    AI automatically fixed errors in your script. The corrected version will be available after payment.
                  </p>
                ) : (
                  <p className="fix-failed">
                    AI attempted to fix errors but some issues remain. Please review and fix manually.
                  </p>
                )}
              </div>
            )}

            {/* Show errors if validation failed */}
            {!state.result.isValid && state.result.finalErrors.length > 0 && (
              <div className="errors-list">
                {state.result.finalErrors.map((error, i) => (
                  <div key={i} className={`error-item ${error.type}`}>
                    {error.line > 0 && <span className="line-number">Line {error.line}:</span>}
                    <span className="error-message">{error.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Publish Form - only show if valid */}
          {state.result.isValid && (
            <div className="card">
              <div className="card-header">
                <h2>{productDetails?.productName ?? 'Publish Your Indicator'}</h2>
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
                <span className="price">{productDetails?.priceFormatted ?? '...'}</span>
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
