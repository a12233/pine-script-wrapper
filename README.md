# Pine Script Publisher

A web app that wraps TradingView's Pine Script editor functionality. Validate, correct, and publish Pine Scripts as private TradingView indicators.

## Features

- **Quick Syntax Check**: Instant local validation without external services
- **Script Validation**: Full validation against TradingView's compiler via browser automation
- **AI Corrections**: Intelligent suggestions to fix script errors (powered by Claude via OpenRouter)
- **One-Click Publishing**: Publish validated scripts as private TradingView indicators
- **Payment Integration**: Stripe checkout for one-time payments per script

## Quick Syntax Check

The "Quick Syntax Check" button provides instant, offline validation of your Pine Script. It runs entirely in your browser without needing any API keys or external services.

**What it checks:**

| Check | Description |
|-------|-------------|
| Version declaration | Warns if `//@version=5` is missing |
| Bracket matching | Counts `(` vs `)` and `[` vs `]` to catch unclosed brackets |
| v4→v5 migration | Detects deprecated syntax like `study()` → `indicator()`, `security()` → `request.security()` |
| Declaration check | Ensures `indicator()`, `strategy()`, or `library()` is present |

**Example issues it catches:**

```pine
// Missing //@version=5
indicator("Test")
plot(close    // ← Unclosed parenthesis
```

This is different from the full **Validate & Publish** flow, which uses TradingView's actual compiler via Browserless.io and provides AI-powered correction suggestions via OpenRouter.

## Tech Stack

- **Framework**: [TanStack Start](https://tanstack.com/start) (full-stack React with SSR)
- **Browser Automation**: [Browserless.io](https://browserless.io) + Puppeteer
- **Payments**: [Stripe](https://stripe.com) Checkout
- **AI**: [Vercel AI SDK](https://ai-sdk.dev) with [OpenRouter](https://openrouter.ai) (access to Claude, GPT-4, etc.)
- **State/Sessions**: In-memory store (dev) / [Vercel KV](https://vercel.com/storage/kv) (prod)
- **Hosting**: [Vercel](https://vercel.com)

## Getting Started

### Prerequisites

- Node.js 20+
- npm or bun

### Installation

```bash
# Clone the repo
cd ~/pine-script-wrapper

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
```

### Development

```bash
npm run dev
```

The app will be available at http://localhost:3000

### Environment Variables

For local development, most features work without external services:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | For AI corrections | OpenRouter API key |
| `OPENROUTER_MODEL` | Optional | Model to use (default: `anthropic/claude-sonnet-4`) |
| `BROWSERLESS_API_KEY` | For validation | Browserless.io API key |
| `STRIPE_SECRET_KEY` | For payments | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | For payments | Stripe webhook signing secret |
| `KV_REST_API_URL` | Optional | Vercel KV URL (uses in-memory store if not set) |
| `KV_REST_API_TOKEN` | Optional | Vercel KV token |

## Project Structure

```
pine-script-wrapper/
├── src/
│   ├── routes/              # TanStack file-based routes
│   │   ├── __root.tsx       # Root layout
│   │   ├── index.tsx        # Home - script input
│   │   ├── connect.tsx      # TradingView auth
│   │   ├── validate.tsx     # Validation results
│   │   └── success.tsx      # Post-payment confirmation
│   ├── server/              # Server-side services
│   │   ├── browserless.ts   # Browser automation client
│   │   ├── tradingview.ts   # TradingView-specific automation
│   │   ├── stripe.ts        # Stripe payment handling
│   │   ├── ai.ts            # AI script analysis
│   │   └── kv.ts            # Key-value storage
│   ├── styles.css           # Global styles
│   └── router.tsx           # Router configuration
├── specs/                   # Ralph project specs
├── .env.example             # Environment template
└── package.json
```

## User Flow

1. **Paste Script**: User pastes Pine Script on home page
2. **Quick Check**: Optional local syntax validation
3. **Connect TradingView**: User provides session cookies for their TV account
4. **Validate**: Script is tested in TradingView's editor via browser automation
5. **AI Corrections**: If errors found, AI suggests fixes
6. **Payment**: Stripe checkout for publishing fee
7. **Publish**: Script published as private indicator
8. **Success**: User receives indicator URL

## Scripts

```bash
npm run dev      # Start development server
npm run build    # Build for production
npm run preview  # Preview production build
npm run test     # Run tests
```

## Deployment

### Vercel (Recommended)

1. Push to GitHub
2. Import project in Vercel
3. Add environment variables in Vercel dashboard
4. Deploy

### Manual

```bash
npm run build
# Deploy .output directory to your hosting provider
```

## Configuration

### Stripe Setup

1. Create Stripe account at stripe.com
2. Get API keys from Dashboard → Developers → API keys
3. Set up webhook endpoint: `https://your-domain.com/api/stripe/webhook`
4. Add keys to `.env`

### Browserless Setup

1. Create account at browserless.io
2. Get API key from dashboard
3. Add to `.env` as `BROWSERLESS_API_KEY`

### Vercel KV Setup (Production)

1. In Vercel dashboard: Storage → Create Database → KV
2. Link to your project
3. Environment variables are automatically added

## License

Private - All rights reserved

## Support

For issues and feature requests, please open a GitHub issue.
