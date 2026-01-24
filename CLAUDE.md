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
| Add to chart | ✅ Yes | ✅ Yes |
| **Publish script** | ❌ NO | ✅ **YES** |
| Has canvas element | ✅ Yes (mini preview) | ✅ Yes (full chart) |
| Has Monaco editor | ✅ Yes (fullscreen) | ✅ Yes (in panel) |

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
- **Validation**: `/pine/` page (fast, has "Add to chart")
- **Publishing**: MUST navigate to `/chart/` page (has "Publish script" button)

The combined validation+publish flow MUST navigate from /pine/ to /chart/ after validation.

### Known Issue: Opening Pine Editor on /chart/

When navigating to a fresh `/chart/` page, the Pine Editor panel is NOT open by default.
Attempts to open it have been problematic:

- `button[aria-label="Pine"]` - May navigate AWAY from `/chart/` to `/pine/` (page reload)
- `[data-name="open-pine-editor"]` - Not found on fresh `/chart/` page
- Keyboard shortcuts (Alt+P, Ctrl+,) - Not effective

The Pine Editor only appears reliably when:
1. You navigate from `/pine/` via "Add to chart" (preserves script context)
2. You use a pre-warmed session that already has Pine Editor open
3. You click on an existing indicator legend on the chart

This is why the publish flow may fail with "Monaco editor not found".
