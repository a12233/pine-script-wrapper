import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { createServerFn } from '@tanstack/react-start'
import { quickSyntaxCheck } from '../server/ai'
import { getUserSession } from '../server/kv'

// Server function to check if user has TV connected
const checkUserStatus = createServerFn().handler(async () => {
  // For MVP, we'll use a cookie-based session
  // In production, use proper session management
  const userId = 'demo-user' // TODO: Get from cookie/session
  const session = await getUserSession(userId)
  return {
    tvConnected: session?.tvConnected ?? false,
  }
})

// Server function for quick syntax validation
const validateSyntax = createServerFn()
  .handler(async (ctx: { data: { script: string } }) => {
    const issues = quickSyntaxCheck(ctx.data.script)
    return { issues }
  })

export const Route = createFileRoute('/')({
  component: Home,
  loader: () => checkUserStatus(),
})

function Home() {
  const { tvConnected } = Route.useLoaderData()
  const navigate = useNavigate()
  const [script, setScript] = useState('')
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
    if (!tvConnected) {
      navigate({ to: '/connect' })
      return
    }
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
          {!tvConnected && (
            <span className="badge badge-warning">TradingView not connected</span>
          )}
          {tvConnected && (
            <span className="badge badge-success">TradingView connected</span>
          )}
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
            {tvConnected ? 'Validate & Publish' : 'Connect TradingView to Publish'}
          </button>
        </div>
      </div>

      <div className="features">
        <div className="feature">
          <h3>Validate</h3>
          <p>Check your script against TradingView's compiler</p>
        </div>
        <div className="feature">
          <h3>AI Corrections</h3>
          <p>Get intelligent suggestions to fix errors</p>
        </div>
        <div className="feature">
          <h3>Publish</h3>
          <p>Publish as a private indicator with one click</p>
        </div>
      </div>
    </div>
  )
}
