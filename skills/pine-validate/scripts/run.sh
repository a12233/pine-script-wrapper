#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Run Pine validate skill end-to-end (Fly logs + Playwright MCP via codex exec).

Usage:
  skills/pine-validate/scripts/run.sh [options]

Options:
  --title <text>         Indicator title (default: Pine Validate Smoke Test)
  --description <text>   Indicator description (default: Validation run via pine-validate skill)
  --script-file <path>   Optional Pine script file to paste instead of prefilled editor text
  --fly-app <name>       Fly app name (default: pine-script-wrapper)
  --site-url <url>       App URL (default: https://pine-script-wrapper.fly.dev)
  --log-seconds <n>      Max Fly log streaming duration in seconds (default: 180)
  --exec-seconds <n>     Max codex exec duration in seconds (default: 240)
  --out-dir <path>       Output directory (default: logs/pine-validate-<timestamp>)
  --prepare-only         Generate prompt/output files but do not execute run
  -h, --help             Show help
USAGE
}

TITLE='Pine Validate Smoke Test'
DESCRIPTION='Validation run via pine-validate skill'
SCRIPT_FILE=''
FLY_APP='pine-script-wrapper'
SITE_URL='https://pine-script-wrapper.fly.dev'
LOG_SECONDS='180'
EXEC_SECONDS='240'
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="logs/pine-validate-${STAMP}"
PREPARE_ONLY='false'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)
      TITLE="${2:-}"
      shift 2
      ;;
    --description)
      DESCRIPTION="${2:-}"
      shift 2
      ;;
    --script-file)
      SCRIPT_FILE="${2:-}"
      shift 2
      ;;
    --fly-app)
      FLY_APP="${2:-}"
      shift 2
      ;;
    --site-url)
      SITE_URL="${2:-}"
      shift 2
      ;;
    --log-seconds)
      LOG_SECONDS="${2:-}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --exec-seconds)
      EXEC_SECONDS="${2:-}"
      shift 2
      ;;
    --prepare-only)
      PREPARE_ONLY='true'
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_cmd codex
need_cmd fly
need_cmd timeout
need_cmd rg

if ! codex mcp get playwright >/dev/null 2>&1; then
  echo "Playwright MCP server is not configured. Run: codex mcp add playwright -- npx -y @playwright/mcp@latest" >&2
  exit 1
fi

if [[ -n "$SCRIPT_FILE" && ! -f "$SCRIPT_FILE" ]]; then
  echo "Script file not found: $SCRIPT_FILE" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
LOG_FILE="$OUT_DIR/fly.log"
CORRELATION_FILE="$OUT_DIR/correlation.log"
PROMPT_FILE="$OUT_DIR/prompt.md"
REPORT_FILE="$OUT_DIR/codex-report.txt"

SCRIPT_BLOCK='(none; use prefilled script from editor)'
if [[ -n "$SCRIPT_FILE" ]]; then
  SCRIPT_CONTENT="$(cat "$SCRIPT_FILE")"
  SCRIPT_BLOCK=$(cat <<BLOCK
\`\`\`pine
$SCRIPT_CONTENT
\`\`\`
BLOCK
)
fi

TEMPLATE="skills/pine-validate/references/prompt-template.md"
if [[ ! -f "$TEMPLATE" ]]; then
  echo "Missing prompt template: $TEMPLATE" >&2
  exit 1
fi

escape_sed() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

TMP_FILE="$OUT_DIR/prompt.tmp.md"
cp "$TEMPLATE" "$TMP_FILE"
sed -i \
  -e "s|{{SITE_URL}}|$(escape_sed "$SITE_URL")|g" \
  -e "s|{{TITLE}}|$(escape_sed "$TITLE")|g" \
  -e "s|{{DESCRIPTION}}|$(escape_sed "$DESCRIPTION")|g" \
  "$TMP_FILE"

SCRIPT_BLOCK_FILE="$OUT_DIR/script-block.md"
printf '%s\n' "$SCRIPT_BLOCK" > "$SCRIPT_BLOCK_FILE"
awk -v block_file="$SCRIPT_BLOCK_FILE" '
  {
    if ($0 ~ /{{SCRIPT_BLOCK}}/) {
      while ((getline line < block_file) > 0) print line
      close(block_file)
    } else {
      print $0
    }
  }
' "$TMP_FILE" > "$PROMPT_FILE"
rm -f "$TMP_FILE" "$SCRIPT_BLOCK_FILE"

cleanup() {
  if [[ -n "${LOG_PID:-}" ]]; then
    kill "$LOG_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ "$PREPARE_ONLY" == 'true' ]]; then
  cat <<DONE
[pine-validate] Prepared only.
- Prompt file: $PROMPT_FILE
- Title: $TITLE
- Description: $DESCRIPTION
- Script file: ${SCRIPT_FILE:-'(prefilled editor script)'}
DONE
  exit 0
fi

echo "[pine-validate] Output directory: $OUT_DIR"
echo "[pine-validate] Streaming Fly logs for up to ${LOG_SECONDS}s from app: $FLY_APP"
(timeout "${LOG_SECONDS}s" fly logs -a "$FLY_APP" 2>&1 | tee "$LOG_FILE") &
LOG_PID=$!

sleep 2

echo "[pine-validate] Running browser automation via codex exec + Playwright MCP"
if ! timeout "${EXEC_SECONDS}s" codex exec --dangerously-bypass-approvals-and-sandbox "$(cat "$PROMPT_FILE")" | tee "$REPORT_FILE"; then
  echo "[pine-validate] codex exec run failed" >&2
fi

wait "$LOG_PID" || true

echo "[pine-validate] Extracting correlation lines"
rg -n "ValidationLoop|Warm Validate|TV Publish|URL_CAPTURE_FAILED_AFTER_PUBLISH|Script published|publish" "$LOG_FILE" > "$CORRELATION_FILE" || true

cat <<DONE
[pine-validate] Completed.
- Browser report: $REPORT_FILE
- Fly logs: $LOG_FILE
- Correlation summary: $CORRELATION_FILE
DONE
