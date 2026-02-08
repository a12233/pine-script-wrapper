---
name: pine-validate
description: Validate and publish Pine Script using browser automation with Fly log correlation for debugging TradingView automation issues.
metadata:
  short-description: Validate and debug Pine publish flow
---

# Pine Validate

Validate and publish a Pine Script indicator through the Pine Script Publisher web app using Playwright MCP and correlate browser actions with live Fly logs.

## Use This Skill

Use this skill when you need one or more of:
- End-to-end validate+publish smoke test.
- Repro of TradingView automation regressions.
- Fly log correlation with a concrete browser run.

## Required Prerequisites

- `codex` CLI installed and authenticated.
- Playwright MCP installed and registered as `playwright`:
  - `codex mcp list`
  - Must show `playwright` and `enabled`.
- Fly CLI authenticated with access to app logs.

## Default Behavior

- Use the prefilled script in the web app unless the user explicitly provides script code or a script file.
- Always collect Fly logs while running browser automation.
- Always capture initial and final snapshots.

## Fast Path

Run the bundled script:

```bash
skills/pine-validate/scripts/run.sh
```

Optional arguments:

```bash
skills/pine-validate/scripts/run.sh \
  --title "My Indicator" \
  --description "Validation run from pine-validate skill" \
  --script-file src/test-scripts/complex-valid.pine \
  --fly-app pine-script-wrapper \
  --site-url https://pine-script-wrapper.fly.dev
```

## Workflow

1. Start Fly logs in background (`fly logs -a <app>`).
2. Run `codex exec` with a Playwright MCP prompt that:
   - navigates to the app
   - keeps prefilled script unless explicit script input exists
   - clicks Validate & Publish
   - fills title/description if needed
   - waits for final validation/publish result
   - reports outcome and any failure point
3. Stop logs and extract correlation lines:
   - `ValidationLoop`
   - `Warm Validate`
   - `TV Publish`
   - `URL_CAPTURE_FAILED_AFTER_PUBLISH`
4. Return:
   - MCP run output
   - raw Fly logs
   - correlation summary

## Files In This Skill

- `scripts/run.sh`:
  - end-to-end runner for Fly logs + Playwright MCP automation + correlation output.
- `references/prompt-template.md`:
  - shared automation prompt template used by `run.sh`.

## Critical TradingView Rules

- Publishing must complete from `/chart/` context, not `/pine/`.
- Do not press `Escape` during Pine editor interactions.
- If publish URL is missing, inspect logs for indexing delay and `URL_CAPTURE_FAILED_AFTER_PUBLISH`.
