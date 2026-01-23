#!/bin/bash
# Dev server with logging for Claude to read

LOG_FILE="/tmp/pine-dev.log"

# Clear old log and Chrome locks
> "$LOG_FILE"
rm -f ~/.puppeteer-chrome-profile/Singleton* 2>/dev/null

echo "Starting dev server..."
echo "Log file: $LOG_FILE"
echo ""

cd "$(dirname "$0")/.." && npm run dev 2>&1 | tee "$LOG_FILE"
