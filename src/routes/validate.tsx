import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { createServerFn } from '@tanstack/react-start'
import { runValidationLoop, type ValidationLoopResult, type PublishAfterValidationOptions } from '../server/validation-loop'
import { hashScript, createPublishJob, generateUserId } from '../server/kv'
import { createCheckoutSession, getProductDetails, type ProductDetails } from '../server/stripe'

interface ValidationState {
  script: string
  originalScript: string // Keep original for diff comparison
  status: 'idle' | 'validating' | 'done' | 'error'
  result?: ValidationLoopResult
  error?: string
}

interface PublishFormData {
  title: string
  description: string
  visibility: 'public' | 'private'
}

// Server function to validate script AND publish in one step
// This combines validation + publish for better performance (single browser session)
const validateAndPublishScript = createServerFn()
  .handler(async (ctx: { data: { script: string; publishOptions: PublishAfterValidationOptions } }) => {
    return runValidationLoop(ctx.data.script, 1, ctx.data.publishOptions)
  })

// Server function to fetch product details from Stripe
const fetchProductDetails = createServerFn()
  .handler(async () => {
    return getProductDetails()
  })

// Server function to create checkout session
// Note: Script is already published at this point, we just store the indicatorUrl
const createCheckout = createServerFn()
  .handler(async (ctx: { data: { script: string; originalScript: string; fixApplied: boolean; title: string; description: string; visibility: 'public' | 'private'; indicatorUrl?: string } }) => {
    const { script, originalScript, fixApplied, title, description, visibility, indicatorUrl } = ctx.data
    const scriptHash = hashScript(script)

    // Generate a userId for this transaction (no login required)
    const userId = generateUserId()

    // Create checkout session
    const checkout = await createCheckoutSession({
      scriptHash,
      userId,
    })

    // Create pending job with indicatorUrl already populated (script was published during validation)
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
      indicatorUrl, // URL from validation+publish step
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

  // Track if we've loaded the script from session storage
  const scriptLoadedRef = useRef(false)

  // Load script from session storage on mount (but don't auto-validate anymore)
  useEffect(() => {
    if (scriptLoadedRef.current) {
      return
    }

    const pendingScript = sessionStorage.getItem('pendingScript')
    if (pendingScript) {
      scriptLoadedRef.current = true
      setState((s) => ({ ...s, script: pendingScript, originalScript: pendingScript }))
      // Don't auto-validate - wait for user to fill in title first
    } else {
      navigate({ to: '/' })
    }
  }, [navigate])

  // Fetch product details from Stripe on mount
  useEffect(() => {
    fetchProductDetails().then(setProductDetails).catch(console.error)
  }, [])

  // Validate AND publish in one step (after user fills in title)
  const runValidationAndPublish = async () => {
    if (!title.trim()) {
      alert('Please enter a title for your indicator')
      return
    }

    setState((s) => ({ ...s, status: 'validating' }))

    try {
      const result = await validateAndPublishScript({
        data: {
          script: state.script,
          publishOptions: {
            title: title.trim(),
            description: description.trim(),
            visibility,
          },
        },
      })

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
    if (!state.result?.isValid) {
      alert('Script must be validated first')
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
          indicatorUrl: state.result.indicatorUrl, // Include URL from validation+publish
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
    setState((s) => ({
      ...s,
      status: 'idle',
      result: undefined,
      error: undefined,
    }))
  }

  return (
    <div className="container">
      <div className="hero">
        <h1>Publish Your Script</h1>
        <p>Enter your indicator details and validate with TradingView</p>
      </div>

      {/* Status indicator */}
      <div className="status-bar">
        <div className={`status-step ${state.status === 'idle' ? 'active' : ''}`}>
          1. Enter Details
        </div>
        <div className={`status-step ${state.status === 'validating' ? 'active' : ''}`}>
          2. Validating & Publishing
        </div>
        <div className={`status-step ${state.status === 'done' && state.result?.isValid ? 'active' : ''}`}>
          3. Ready for Payment
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
          <h2>Validating & Publishing...</h2>
          <p>Your script is being validated and published to TradingView.</p>
          <small>This may take up to a minute</small>
        </div>
      )}

      {/* Form state - show BEFORE validation */}
      {state.status === 'idle' && (
        <div className="card">
          <div className="card-header">
            <h2>{productDetails?.productName ?? 'Indicator Details'}</h2>
          </div>

          <div className="form-group">
            <label htmlFor="title">Indicator Title *</label>
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
            onClick={runValidationAndPublish}
            disabled={!title.trim()}
          >
            {title.trim() ? 'Validate & Publish' : 'Enter title to continue'}
          </button>
        </div>
      )}

      {/* Results */}
      {state.status === 'done' && state.result && (
        <>
          {/* Validation Result */}
          <div className={`card ${state.result.isValid ? (state.result.publishError ? 'warning-card' : 'success-card') : 'warning-card'}`}>
            <div className="card-header">
              <h2>{state.result.isValid
                ? (state.result.publishError ? 'Script Valid' : 'Script Published!')
                : 'Validation Failed'}</h2>
              <span
                className={`badge ${state.result.isValid ? (state.result.publishError ? 'badge-warning' : 'badge-success') : 'badge-warning'}`}
              >
                {state.result.isValid
                  ? (state.result.publishError ? 'Publishing failed' : 'Ready for payment')
                  : `${state.result.finalErrors.length} error(s)`}
              </span>
            </div>

            {/* Show if AI fix was applied */}
            {state.result.fixAttempted && (
              <div className="fix-info">
                {state.result.fixSuccessful ? (
                  <p className="fix-success">
                    AI automatically fixed errors in your script. The corrected version has been published.
                  </p>
                ) : (
                  <p className="fix-failed">
                    AI attempted to fix errors but some issues remain. Please review and fix manually.
                  </p>
                )}
              </div>
            )}

            {/* Show publish error if any */}
            {state.result.isValid && state.result.publishError && (
              <div className="fix-info">
                <p className="fix-failed">
                  Warning: Publishing encountered an issue: {state.result.publishError}
                </p>
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

          {/* Payment button - show if valid (indicatorUrl may not be captured immediately) */}
          {state.result.isValid && !state.result.publishError && (
            <div className="card">
              <div className="card-header">
                <h2>Complete Your Purchase</h2>
              </div>

              <p>Your script "{title}" has been validated and published. Complete payment to receive your indicator URL.</p>

              <div className="price-info">
                <span className="price">{productDetails?.priceFormatted ?? '...'}</span>
                <span className="price-desc">One-time payment</span>
              </div>

              <button
                className="btn btn-primary btn-large"
                onClick={handleProceedToPayment}
                disabled={isCreatingCheckout}
              >
                {isCreatingCheckout ? 'Creating checkout...' : 'Proceed to Payment'}
              </button>
            </div>
          )}

          {/* Retry if validation failed */}
          {!state.result.isValid && (
            <div className="button-group">
              <button className="btn btn-secondary" onClick={handleRetryValidation}>
                Try Again
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
