import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { createServerFn } from '@tanstack/react-start'
import { quickSyntaxCheck } from '../server/ai'

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
