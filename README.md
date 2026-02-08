# Pine Script Publisher

A web app that wraps TradingView's Pine Script editor functionality. Validate, correct, and publish Pine Scripts as private TradingView indicators.

## Features

- **Script Validation**: Full validation against TradingView's compiler via browser automation
- **AI Corrections**: Intelligent suggestions to fix script errors (powered by Claude via OpenRouter)
- **One-Click Publishing**: Publish validated scripts as private TradingView indicators
- **Payment Integration**: Stripe checkout with promotion codes support
- **Admin Session Management**: API endpoints for managing TradingView sessions (bypass CAPTCHA in production)
- **Quick Syntax Check**: Instant local validation without external services

## Tech Stack

- **Framework**: [TanStack Start](https://tanstack.com/start) (full-stack React with SSR)
- **Browser Automation**: Puppeteer with [Browserless.io](https://browserless.io) stealth mode
- **Payments**: [Stripe](https://stripe.com) Checkout
- **AI**: [Vercel AI SDK](https://ai-sdk.dev) with [OpenRouter](https://openrouter.ai)
- **State/Sessions**: Redis (with in-memory fallback for dev)
- **Hosting**: [Fly.io](https://fly.io)

## Getting Started

### Prerequisites

- Node.js 20+
- npm or bun
- Redis (optional for dev, required for production)

### Installation

```bash
# Clone the repo
git clone <repo-url>
cd pine-script-wrapper

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
```

### Development

```bash
# Start dev server
npm run dev

# Or with logging (for debugging)
npm run dev:log
```

The app will be available at http://localhost:3000

### Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Required | Description |
|----------|----------|-------------|
| **AI** | | |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for AI corrections |
| `OPENROUTER_MODEL` | No | Model to use (default: `anthropic/claude-sonnet-4`) |
| **Browser Automation** | | |
| `USE_LOCAL_BROWSER` | No | Set `true` to use local Chrome instead of Browserless |
| `HEADLESS_BROWSER` | No | Set `true` for fully headless, `false` for minimized window |
| `CHROME_PATH` | No | Override Chrome executable path |
| `BROWSERLESS_API_KEY` | Prod | Browserless.io API key |
| `BROWSERLESS_ENDPOINT` | No | WebSocket endpoint (default: `wss://chrome.browserless.io`) |
| `BROWSERLESS_STEALTH` | No | Use stealth mode to avoid CAPTCHAs (default: `true`) |
| `BROWSERLESS_PROXY` | No | Set to `residential` for better IP reputation |
| **Payments** | | |
| `STRIPE_PROD_SECRET_KEY` | Yes | Stripe production secret key |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signing secret |
| `STRIPE_PUBLISHABLE_KEY` | Yes | Stripe publishable key |
| **TradingView** | | |
| `TV_USERNAME` | Yes | TradingView service account username |
| `TV_PASSWORD` | Yes | TradingView service account password |
| `TV_USE_PINE_PAGE` | No | Use `/pine/` page for faster validation (default: `true`) |
| **Storage** | | |
| `REDIS_URL` | Prod | Redis connection URL (uses in-memory if not set) |
| **App** | | |
| `APP_URL` | Yes | Application URL (e.g., `http://localhost:3000`) |
| `SESSION_SECRET` | Prod | Secret key for session encryption |
| `ADMIN_API_KEY` | Prod | API key for admin endpoints (generate with `openssl rand -hex 32`) |

## Admin API

Admin endpoints for managing TradingView sessions. Useful for bypassing CAPTCHA by uploading cookies from a logged-in browser.

All endpoints require the `x-admin-key` header with your `ADMIN_API_KEY`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/tv-session/status` | GET | Check session status. Add `?verify=true` to verify with TradingView |
| `/api/admin/tv-session/upload` | POST | Upload cookies (`sessionId`, `sessionIdSign`, optional `skipVerify`) |
| `/api/admin/tv-session` | DELETE | Clear stored session |
| `/api/admin/tv-session/live` | POST | Start live Browserless session for manual login |
| `/api/admin/tv-session/finalize` | POST | Finalize and save live session cookies |

### Example: Upload Session Cookies

```bash
# Extract cookies from browser DevTools (Application > Cookies > tradingview.com)
# Copy 'sessionid' and 'sessionid_sign' values

curl -X POST https://your-app.fly.dev/api/admin/tv-session/upload \
  -H "Content-Type: application/json" \
  -H "x-admin-key: your-admin-key" \
  -d '{
    "sessionId": "your-sessionid-cookie",
    "sessionIdSign": "your-sessionid-sign-cookie"
  }'
```

## Project Structure

```
pine-script-wrapper/
├── src/
│   ├── routes/              # TanStack file-based routes
│   │   ├── __root.tsx       # Root layout
│   │   ├── index.tsx        # Home - script input
│   │   ├── validate.tsx     # Validation results
│   │   ├── success.tsx      # Post-payment confirmation
│   │   └── api/admin/       # Admin API endpoints
│   ├── server/              # Server-side services
│   │   ├── admin-auth.ts    # Admin API authentication
│   │   ├── browserless.ts   # Browser automation client
│   │   ├── tradingview.ts   # TradingView automation
│   │   ├── stripe.ts        # Stripe payment handling
│   │   ├── ai.ts            # AI script analysis
│   │   └── kv.ts            # Redis/in-memory storage
│   ├── styles.css           # Global styles
│   └── router.tsx           # Router configuration
├── scripts/
│   └── dev.sh               # Dev server with logging
├── .env.example             # Environment template
├── fly.toml                 # Fly.io configuration
└── package.json
```

## Scripts

```bash
npm run dev       # Start development server
npm run dev:log   # Dev server with logging to /tmp/pine-dev.log
npm run skill:pine-validate  # Fly logs + Playwright MCP validation/publish run
npm run build     # Build for production
npm run preview   # Preview production build
npm run test      # Run tests
```

## Deployment

### Fly.io

The application is deployed on Fly.io with 1GB memory for headless Chrome.

**Prerequisites:**
- Install [flyctl](https://fly.io/docs/flyctl/install/)
- Authenticate with `fly auth login`

**Set Secrets:**

```bash
# Required
fly secrets set OPENROUTER_API_KEY=sk-or-v1-xxx
fly secrets set STRIPE_PROD_SECRET_KEY=sk_live_xxx
fly secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx
fly secrets set STRIPE_PUBLISHABLE_KEY=pk_live_xxx
fly secrets set TV_USERNAME=your_tv_username
fly secrets set TV_PASSWORD=your_tv_password
fly secrets set APP_URL=https://pine-script-wrapper.fly.dev
fly secrets set SESSION_SECRET=$(openssl rand -hex 32)
fly secrets set ADMIN_API_KEY=$(openssl rand -hex 32)

# Optional - Browserless (if not using built-in Puppeteer)
fly secrets set BROWSERLESS_API_KEY=xxx
```

**Create Redis (for session persistence):**

```bash
fly redis create
fly secrets set REDIS_URL=redis://...
```

**Deploy:**

```bash
fly deploy       # Build and deploy
fly status       # Check status
fly logs         # View logs
fly open         # Open in browser
```

## Configuration

### Stripe Setup

1. Create Stripe account at stripe.com
2. Get API keys from Dashboard → Developers → API keys
3. Create a product with price
4. Set up webhook endpoint: `https://your-domain.com/api/stripe/webhook`
   - Events: `checkout.session.completed`
5. Add keys to environment/secrets

### Browserless.io Setup (Production)

1. Create account at browserless.io
2. Get API key from dashboard
3. Set `BROWSERLESS_API_KEY` in secrets
4. Stealth mode is enabled by default to avoid CAPTCHAs

### Local Browser Setup (Development)

For local development, you can use your own Chrome:

```bash
# In .env
USE_LOCAL_BROWSER=true
HEADLESS_BROWSER=false  # See browser window
```

## User Flow

1. **Paste Script**: User pastes Pine Script on home page
2. **Quick Check**: Optional local syntax validation
3. **Validate**: Script tested in TradingView's editor via browser automation
4. **AI Corrections**: If errors found, AI suggests fixes
5. **Payment**: Stripe checkout for publishing fee
6. **Publish**: Script published as private indicator
7. **Success**: User receives indicator URL

## License

Private - All rights reserved
