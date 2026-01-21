import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { createServerFn } from '@tanstack/react-start'
import { quickSyntaxCheck } from '../server/ai'

// Test scripts for dev mode
import COMPLEX_VALID_SCRIPT from '../test-scripts/complex-valid.pine?raw'
import SYNTAX_ERRORS_SCRIPT from '../test-scripts/syntax-errors.pine?raw'

// Server function for quick syntax validation
const validateSyntax = createServerFn()
  .handler(async (ctx: { data: { script: string } }) => {
    const issues = quickSyntaxCheck(ctx.data.script)
    return { issues }
  })

export const Route = createFileRoute('/')({
  component: Home,
})

const DEFAULT_SCRIPT = `//@version=5
indicator("Test Indicator", overlay=true)

// Simple moving average
ma20 = ta.sma(close, 20)
ma50 = ta.sma(close, 50)

// Plot the moving averages
plot(ma20, color=color.blue, linewidth=2, title="MA 20")
plot(ma50, color=color.red, linewidth=2, title="MA 50")

// Add a signal when MA crosses
crossUp = ta.crossover(ma20, ma50)
crossDown = ta.crossunder(ma20, ma50)

plotshape(crossUp, style=shape.triangleup, location=location.belowbar, color=color.green, size=size.small)
plotshape(crossDown, style=shape.triangledown, location=location.abovebar, color=color.red, size=size.small)
`

// Check if running in dev mode (localhost)
const isDev = typeof window !== 'undefined' && window.location.hostname === 'localhost'

function Home() {
  const navigate = useNavigate()
  const [script, setScript] = useState(DEFAULT_SCRIPT)
  const [syntaxIssues, setSyntaxIssues] = useState<string[]>([])
  const [isValidating, setIsValidating] = useState(false)

  const handleQuickCheck = async () => {
    if (!script.trim()) return
    setIsValidating(true)
    try {
      const result = await validateSyntax({ data: { script } })
      setSyntaxIssues(result.issues)
    } catch (error) {
      console.error('Validation error:', error)
    } finally {
      setIsValidating(false)
    }
  }

  const handleValidate = () => {
    // Store script in session storage for the validate page
    sessionStorage.setItem('pendingScript', script)
    navigate({ to: '/validate' })
  }

  return (
    <div className="container">
      <div className="hero">
        <h1>Pine Script Publisher</h1>
        <p>Validate and publish your TradingView Pine Scripts with ease</p>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>Paste Your Pine Script</h2>
        </div>

        <textarea
          className="script-input"
          value={script}
          onChange={(e) => setScript(e.target.value)}
          placeholder={`//@version=5
indicator("My Script", overlay=true)

// Your Pine Script code here...
plot(close)`}
          rows={20}
        />

        {/* Dev-only test script buttons */}
        {isDev && (
          <div className="dev-buttons" style={{ marginBottom: '1rem', padding: '0.5rem', backgroundColor: '#1a1a2e', borderRadius: '4px', border: '1px dashed #ff6b6b' }}>
            <small style={{ color: '#ff6b6b', display: 'block', marginBottom: '0.5rem' }}>Dev Mode: Test Scripts</small>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                className="btn btn-secondary"
                style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                onClick={() => setScript(SYNTAX_ERRORS_SCRIPT)}
              >
                Load Script with Errors (Test Auto-Fix)
              </button>
              <button
                className="btn btn-secondary"
                style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                onClick={() => setScript(COMPLEX_VALID_SCRIPT)}
              >
                Load Complex Valid Script
              </button>
            </div>
          </div>
        )}

        {syntaxIssues.length > 0 && (
          <div className="issues-panel">
            <h3>Potential Issues</h3>
            <ul>
              {syntaxIssues.map((issue, i) => (
                <li key={i} className="issue-item">{issue}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="button-group">
          <button
            className="btn btn-secondary"
            onClick={handleQuickCheck}
            disabled={!script.trim() || isValidating}
          >
            {isValidating ? 'Checking...' : 'Quick Syntax Check'}
          </button>

          <button
            className="btn btn-primary"
            onClick={handleValidate}
            disabled={!script.trim()}
          >
            Validate & Publish
          </button>
        </div>
      </div>

      <div className="features">
        <div className="feature">
          <h3>Validate</h3>
          <p>Check your script against TradingView's compiler</p>
        </div>
        <div className="feature">
          <h3>Auto-Fix</h3>
          <p>AI automatically corrects common errors</p>
        </div>
        <div className="feature">
          <h3>Publish</h3>
          <p>Publish as an indicator with one click</p>
        </div>
      </div>
    </div>
  )
}
