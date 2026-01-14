import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { createServerFn } from '@tanstack/react-start'
import { verifyTVSession } from '../server/tradingview'
import { storeTVCredentials, createUserSession, generateUserId } from '../server/kv'

// Server function to verify and store TV credentials
const connectTradingView = createServerFn()
  .handler(async (ctx: { data: { sessionId: string; signature: string } }) => {
    const { sessionId, signature } = ctx.data

    // Verify the session works
    const isValid = await verifyTVSession({
      sessionId,
      signature,
      userId: '', // We'll get this from the session
    })

    if (!isValid) {
      return { success: false, error: 'Invalid TradingView session. Please check your cookies.' }
    }

    // Create user session and store credentials
    const userId = generateUserId()
    await createUserSession(userId)
    await storeTVCredentials(userId, {
      sessionId,
      signature,
      userId,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    })

    return { success: true, userId }
  })

export const Route = createFileRoute('/connect')({
  component: ConnectPage,
})

function ConnectPage() {
  const navigate = useNavigate()
  const [sessionId, setSessionId] = useState('')
  const [signature, setSignature] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState('')

  const handleConnect = async () => {
    if (!sessionId.trim() || !signature.trim()) {
      setError('Please enter both session ID and signature')
      return
    }

    setIsConnecting(true)
    setError('')

    try {
      const result = await connectTradingView({
        data: { sessionId: sessionId.trim(), signature: signature.trim() },
      })

      if (result.success) {
        navigate({ to: '/' })
      } else {
        setError(result.error || 'Failed to connect')
      }
    } catch (err) {
      setError('Connection failed. Please try again.')
      console.error(err)
    } finally {
      setIsConnecting(false)
    }
  }

  return (
    <div className="container">
      <div className="hero">
        <h1>Connect TradingView</h1>
        <p>Link your TradingView account to validate and publish scripts</p>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>How to Get Your Cookies</h2>
        </div>

        <div className="instructions">
          <ol>
            <li>
              <strong>Log in to TradingView</strong> in your browser
            </li>
            <li>
              Open <strong>Developer Tools</strong> (F12 or Cmd+Option+I)
            </li>
            <li>
              Go to <strong>Application</strong> tab → <strong>Cookies</strong> → tradingview.com
            </li>
            <li>
              Find and copy the value of <code>sessionid</code>
            </li>
            <li>
              Find and copy the value of <code>sessionid_sign</code>
            </li>
          </ol>
        </div>

        <div className="form-group">
          <label htmlFor="sessionId">Session ID (sessionid cookie)</label>
          <input
            id="sessionId"
            type="text"
            className="input"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="Paste your sessionid cookie value"
          />
        </div>

        <div className="form-group">
          <label htmlFor="signature">Signature (sessionid_sign cookie)</label>
          <input
            id="signature"
            type="text"
            className="input"
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            placeholder="Paste your sessionid_sign cookie value"
          />
        </div>

        {error && <div className="error-message">{error}</div>}

        <div className="button-group">
          <button
            className="btn btn-secondary"
            onClick={() => navigate({ to: '/' })}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleConnect}
            disabled={isConnecting || !sessionId.trim() || !signature.trim()}
          >
            {isConnecting ? 'Connecting...' : 'Connect Account'}
          </button>
        </div>

        <div className="security-note">
          <strong>Security Note:</strong> Your credentials are encrypted and stored securely.
          We never see your TradingView password. You can disconnect at any time.
        </div>
      </div>
    </div>
  )
}
