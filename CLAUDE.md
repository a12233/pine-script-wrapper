# Development Workflow

## Deployment
- This project deploys to **Fly.io**
- Use `fly logs` (streaming) to tail logs in real-time - **prefer this over chunked fetches**
- Use `fly logs --no-tail` only for quick snapshots
- Use `fly status` to check app status
- Use `fly deploy` to deploy manually

## Branch Strategy
- Work in feature branches: `feat/<feature-name>`
- Never commit directly to `master`
- Create PRs to merge completed features into `master`

## PR Process
When a feature is complete:
1. Ensure all changes are committed to the feature branch
2. Push the branch to origin
3. Create a PR targeting `master`
4. Include a summary of changes in the PR description

## Historical Context
Daily development notes are stored in `~/notes/` (format: `YYYY-MM-DD.md`).
Project-specific notes: `~/notes/pine-script-wrapper/`

Reference these notes for:
- Prior decisions and rationale
- Setup changes and configurations
- Completed tasks and their context

## TradingView Automation Notes

### CRITICAL: /pine/ vs /chart/ - Publishing REQUIRES /chart/

**PUBLISHING CAN ONLY BE DONE ON /chart/ PAGE. NEVER ON /pine/.**

| Feature | /pine/ Page | /chart/ Page |
|---------|-------------|--------------|
| Validate script | ✅ Yes | ✅ Yes |
| Add to chart | ❌ NO (button not present) | ✅ Yes |
| **Publish script** | ❌ NO | ✅ **YES** |
| Has canvas element | ✅ Yes (mini preview) | ✅ Yes (full chart) |
| Has Monaco editor | ✅ Yes (fullscreen) | ✅ Yes (in panel) |

**2026-01-27 Finding**: The "Add to chart" button does NOT exist on `/pine/` page (confirmed via Playwright, logged in). This means the `/pine/` → "Add to chart" → `/chart/` navigation path documented in the code is not viable. The only reliable ways to get Pine Editor open on `/chart/` are: (1) warm session pre-warmed at startup, or (2) clicking an existing indicator legend.

**Common Pitfall**: The `/pine/` page has a canvas element (mini chart preview), which can trick code into thinking it's on the chart page. ALWAYS check the URL contains `/chart/` before attempting to publish.

### Script Name Dropdown on /pine/ (NO Publish option!)

The dropdown on `/pine/` page contains:
- Save script (Ctrl + S)
- Make a copy…
- Rename…
- Version history…
- Convert code to v6…
- Create new
- Open script… (Ctrl + O)

**NO Publish option exists in this menu on /pine/.**

### How to Publish

The "Publish script" button is ONLY available in the **Pine Editor toolbar on the /chart/ page**:
1. Navigate to `/chart/` (not `/pine/`)
2. Open the Pine Editor panel
3. The "Publish script" button appears in the Pine Editor's own toolbar

### Workflow Summary
- **Validation**: `/pine/` page for compile checks only (faster load, no "Add to chart")
- **Publishing**: MUST navigate to `/chart/` page (has "Publish script" button)

Combined validation+publish paths should prefer staying on `/chart/` end-to-end to avoid unstable cross-page transitions.

### Opening Pine Editor on /chart/

When navigating to a fresh `/chart/` page, the Pine Editor panel is NOT open by default.

**Working selectors:**
- `[data-name="pine-dialog-button"]` (sidebar toggle) - WORKS, opens Pine Editor panel on `/chart/` without navigating away
- `[data-name="open-pine-editor"]` - Only exists after Pine Editor has been opened once in the session

**Non-working approaches:**
- Keyboard shortcuts (Alt+P, Ctrl+,) - Not effective

The code tries `open-pine-editor` first (works on pre-warmed sessions), then falls back to `pine-dialog-button` (works on fresh `/chart/` pages).

## Local Testing with Warm Browser

### Setup

To debug the TradingView automation locally with a visible Chrome browser:

```bash
# Start dev server with local warm browser (Chrome with GUI)
USE_WARM_LOCAL_BROWSER=true npm run dev
```

This will:
1. Launch a visible Chrome window
2. Auto-login to TradingView using credentials from Redis
3. Navigate to the chart page and open Pine Editor
4. Keep the browser warm for validation requests

### Connecting Playwright MCP for Debugging

1. Get the Chrome debug port:
   ```bash
   cat /tmp/puppeteer_dev_chrome_profile-*/DevToolsActivePort | head -1
   ```

2. View Chrome's debug info:
   ```
   http://localhost:<port>/json
   ```

3. Use Playwright MCP to interact with the local web app:
   ```
   Navigate to: http://localhost:3000
   ```

### Debugging the Publish Dialog

When debugging publish dialog issues:

1. Start the dev server with `USE_WARM_LOCAL_BROWSER=true`
2. Navigate to `http://localhost:3000` in Playwright
3. Submit a validation request
4. Watch the Chrome window to see the TradingView publish dialog
5. Check terminal output for `[Warm Validate]` logs

### Key Differences: Local vs Production

| Aspect | Local | Production (Fly.io) |
|--------|-------|---------------------|
| Browser | Chrome with GUI | Headless Chromium |
| Visibility | Can see dialogs | Screenshots only |
| Performance | Faster | Network latency |
| Debugging | Real-time observation | Log analysis |

### Common Debug Patterns

**Dialog fill timeout**: If the dialog fill times out locally, check:
- Is the dialog actually visible in Chrome?
- Are the selectors finding the correct elements?
- Is TradingView showing any overlay/modal blocking the dialog?

**Script lookup issues**: Check logs for:
```
[Warm Validate] Script lookup debug: [...]
[Warm Validate] Title search failed, trying most recent script with recency check...
```

### Screenshot Locations

- Local: Screenshots saved to project root
- Production: `/data/screenshots/` on Fly.io volume
  ```bash
  fly ssh console -C "ls -lt /data/screenshots/"
  fly ssh sftp get /data/screenshots/<filename>.png
  ```
