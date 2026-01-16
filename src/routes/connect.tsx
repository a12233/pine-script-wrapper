import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { createServerFn } from '@tanstack/react-start'
import {
  verifyTVSession,
  loginWithCredentials,
  loginWithUserCredentials,
  hasAutoLoginCredentials,
} from '../server/tradingview'
import { storeTVCredentials, createUserSession, generateUserId } from '../server/kv'

// Check if auto-login is available
const checkAutoLogin = createServerFn().handler(async () => {
  return { available: hasAutoLoginCredentials() }
})

// Server function for auto-login with environment credentials
const autoLoginTradingView = createServerFn().handler(async () => {
  const credentials = await loginWithCredentials()

  if (!credentials) {
    return { success: false, error: 'Auto-login failed. Check your TV_USERNAME and TV_PASSWORD in .env' }
  }

  // Create user session and store credentials
  const userId = generateUserId()
  await createUserSession(userId)
  await storeTVCredentials(userId, {
    sessionId: credentials.sessionId,
    signature: credentials.signature,
    userId,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
  })

  return { success: true, userId }
})

// Server function for user credential login
const userLoginTradingView = createServerFn()
  .handler(async (ctx: { data: { username: string; password: string } }) => {
    const { username, password } = ctx.data

    const result = await loginWithUserCredentials(username, password)

    if (!result.success || !result.credentials) {
      return {
        success: false,
        error: result.error || 'Login failed',
        captchaDetected: result.captchaDetected,
      }
    }

    // Create user session and store credentials
    const userId = generateUserId()
    await createUserSession(userId)
    await storeTVCredentials(userId, {
      sessionId: result.credentials.sessionId,
      signature: result.credentials.signature,
      userId,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    })

    return { success: true, userId }
  })

// Server function to verify and store TV credentials (manual cookie entry)
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
  loader: () => checkAutoLogin(),
})

function ConnectPage() {
  const { available: autoLoginAvailable } = Route.useLoaderData()
  const navigate = useNavigate()
  // User credential login state
  const [tvUsername, setTvUsername] = useState('')
  const [tvPassword, setTvPassword] = useState('')
  const [isUserLogging, setIsUserLogging] = useState(false)
  // Manual cookie entry state
  const [sessionId, setSessionId] = useState('')
  const [signature, setSignature] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  // Admin auto-login state
  const [isAutoLogging, setIsAutoLogging] = useState(false)
  // Shared state
  const [error, setError] = useState('')
  const [showManualEntry, setShowManualEntry] = useState(false)

  // User credential login
  const handleUserLogin = async () => {
    if (!tvUsername.trim() || !tvPassword.trim()) {
      setError('Please enter your TradingView username and password')
      return
    }

    setIsUserLogging(true)
    setError('')

    try {
      const result = await userLoginTradingView({
        data: { username: tvUsername.trim(), password: tvPassword },
      })

      if (result.success) {
        localStorage.setItem('userId', result.userId)
        navigate({ to: '/' })
      } else {
        if (result.captchaDetected) {
          setError('CAPTCHA verification required. Please use the manual cookie method below.')
          setShowManualEntry(true)
        } else {
          setError(result.error || 'Login failed')
        }
      }
    } catch (err) {
      setError('Login failed. Please try the manual cookie method.')
      setShowManualEntry(true)
      console.error(err)
    } finally {
      setIsUserLogging(false)
      // Clear password from memory
      setTvPassword('')
    }
  }

  // Admin auto-login with env credentials
  const handleAutoLogin = async () => {
    setIsAutoLogging(true)
    setError('')

    try {
      const result = await autoLoginTradingView()

      if (result.success) {
        localStorage.setItem('userId', result.userId)
        navigate({ to: '/' })
      } else {
        setError(result.error || 'Auto-login failed')
      }
    } catch (err) {
      setError('Auto-login failed. Please try manual cookie entry.')
      console.error(err)
    } finally {
      setIsAutoLogging(false)
    }
  }

  // Manual cookie entry
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
        localStorage.setItem('userId', result.userId)
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

      {/* User credential login - primary option for all users */}
      <div className="card">
        <div className="card-header">
          <h2>Quick Connect</h2>
          <span className="badge badge-success">Recommended</span>
        </div>

        <p>Enter your TradingView credentials to connect your account.</p>

        <div className="form-group">
          <label htmlFor="tvUsername">TradingView Username or Email</label>
          <input
            id="tvUsername"
            type="text"
            className="input"
            value={tvUsername}
            onChange={(e) => setTvUsername(e.target.value)}
            placeholder="Enter your TradingView username or email"
            disabled={isUserLogging}
          />
        </div>

        <div className="form-group">
          <label htmlFor="tvPassword">Password</label>
          <input
            id="tvPassword"
            type="password"
            className="input"
            value={tvPassword}
            onChange={(e) => setTvPassword(e.target.value)}
            placeholder="Enter your TradingView password"
            disabled={isUserLogging}
            onKeyDown={(e) => e.key === 'Enter' && handleUserLogin()}
          />
        </div>

        {error && !showManualEntry && <div className="error-message">{error}</div>}

        <button
          className="btn btn-primary btn-large"
          onClick={handleUserLogin}
          disabled={isUserLogging || !tvUsername.trim() || !tvPassword.trim()}
          style={{ width: '100%', marginTop: '1rem' }}
        >
          {isUserLogging ? 'Connecting...' : 'Connect Account'}
        </button>

        <div className="security-note" style={{ marginTop: '1rem' }}>
          <strong>Security Note:</strong> Your password is used only to log in and is never stored.
          Only your session token is saved (encrypted) to keep you connected.
        </div>
      </div>

      {/* Admin auto-login option - only shown if server credentials are configured */}
      {autoLoginAvailable && (
        <div className="card">
          <div className="card-header">
            <h2>Admin Quick Connect</h2>
          </div>

          <p>Auto-login using server-configured credentials.</p>

          <button
            className="btn btn-secondary"
            onClick={handleAutoLogin}
            disabled={isAutoLogging}
            style={{ width: '100%', marginTop: '1rem' }}
          >
            {isAutoLogging ? 'Connecting...' : 'Connect with Server Credentials'}
          </button>
        </div>
      )}

      {/* Manual cookie entry - fallback option */}
      <div className="card">
        <div className="card-header">
          <h2>Manual Cookie Entry</h2>
          {!showManualEntry && (
            <button
              className="btn btn-sm btn-secondary"
              onClick={() => setShowManualEntry(!showManualEntry)}
            >
              {showManualEntry ? 'Hide' : 'Show'}
            </button>
          )}
        </div>

        {showManualEntry && (
          <>
            {error && <div className="error-message" style={{ marginBottom: '1rem' }}>{error}</div>}

            <div className="instructions">
              <p>If the quick connect doesn't work, you can manually enter your session cookies:</p>
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

            <div className="button-group">
              <button
                className="btn btn-secondary"
                onClick={() => setShowManualEntry(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleConnect}
                disabled={isConnecting || !sessionId.trim() || !signature.trim()}
              >
                {isConnecting ? 'Connecting...' : 'Connect with Cookies'}
              </button>
            </div>
          </>
        )}

        {!showManualEntry && (
          <p style={{ color: 'var(--text-secondary)' }}>
            Having trouble with Quick Connect? Click "Show" to manually enter your session cookies.
          </p>
        )}
      </div>
    </div>
  )
}
