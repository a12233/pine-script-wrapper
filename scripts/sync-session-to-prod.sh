#!/bin/bash
#
# Sync TradingView session from local Redis to production Fly.io
#
# This script reads the service account session from local Redis
# and uploads it to the production environment via the admin API.
#
# Prerequisites:
# - Local Redis running with TradingView session saved
# - ADMIN_API_KEY set in production (fly secrets)
# - jq installed for JSON parsing
#
# Usage:
#   ./scripts/sync-session-to-prod.sh
#

set -e

# Configuration
REDIS_KEY="service-account:session"
PROD_URL="${PROD_URL:-https://pine-script-wrapper.fly.dev}"
ADMIN_API_KEY="${ADMIN_API_KEY:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== Syncing TradingView Session to Production ===${NC}"
echo ""

# Check for required tools
if ! command -v redis-cli &> /dev/null; then
    echo -e "${RED}Error: redis-cli not found. Install Redis CLI tools.${NC}"
    exit 1
fi

if ! command -v jq &> /dev/null; then
    echo -e "${RED}Error: jq not found. Install jq for JSON parsing.${NC}"
    exit 1
fi

if ! command -v curl &> /dev/null; then
    echo -e "${RED}Error: curl not found.${NC}"
    exit 1
fi

# Check for admin API key
if [ -z "$ADMIN_API_KEY" ]; then
    echo -e "${YELLOW}ADMIN_API_KEY not set. Reading from fly secrets...${NC}"
    ADMIN_API_KEY=$(fly secrets list --json 2>/dev/null | jq -r '.[] | select(.Name=="ADMIN_API_KEY") | .Digest' || echo "")

    if [ -z "$ADMIN_API_KEY" ] || [ "$ADMIN_API_KEY" == "null" ]; then
        echo -e "${RED}Error: ADMIN_API_KEY not found. Set it via:${NC}"
        echo "  export ADMIN_API_KEY=your-key"
        echo "  or"
        echo "  fly secrets set ADMIN_API_KEY=your-key"
        exit 1
    fi

    # We can't read the actual value from fly secrets, prompt for it
    echo -e "${YELLOW}Please enter your ADMIN_API_KEY:${NC}"
    read -s ADMIN_API_KEY
    echo ""
fi

# Read session from local Redis
echo -e "${YELLOW}Reading session from local Redis...${NC}"
SESSION_DATA=$(redis-cli GET "$REDIS_KEY" 2>/dev/null || echo "")

if [ -z "$SESSION_DATA" ]; then
    echo -e "${RED}Error: No session found in local Redis at key '$REDIS_KEY'${NC}"
    echo ""
    echo "Make sure you have a valid TradingView session saved locally."
    echo "You can save one by logging in via the app or using the admin upload endpoint."
    exit 1
fi

# Parse session data
SESSION_ID=$(echo "$SESSION_DATA" | jq -r '.sessionId')
SESSION_SIGN=$(echo "$SESSION_DATA" | jq -r '.signature')

if [ "$SESSION_ID" == "null" ] || [ -z "$SESSION_ID" ]; then
    echo -e "${RED}Error: Invalid session data - missing sessionId${NC}"
    exit 1
fi

if [ "$SESSION_SIGN" == "null" ] || [ -z "$SESSION_SIGN" ]; then
    echo -e "${RED}Error: Invalid session data - missing signature${NC}"
    exit 1
fi

echo -e "${GREEN}Found session in local Redis${NC}"
echo "  Session ID: ${SESSION_ID:0:10}..."
echo "  Signature: ${SESSION_SIGN:0:10}..."
echo ""

# Upload to production
echo -e "${YELLOW}Uploading session to production ($PROD_URL)...${NC}"

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$PROD_URL/api/admin/tv-session/upload" \
    -H "Content-Type: application/json" \
    -H "x-admin-key: $ADMIN_API_KEY" \
    -d "{\"sessionId\": \"$SESSION_ID\", \"sessionIdSign\": \"$SESSION_SIGN\", \"skipVerify\": true}")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" == "200" ]; then
    echo -e "${GREEN}Success! Session uploaded to production.${NC}"
    echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
else
    echo -e "${RED}Error: Upload failed (HTTP $HTTP_CODE)${NC}"
    echo "$BODY" | jq . 2>/dev/null || echo "$BODY"
    exit 1
fi

echo ""
echo -e "${GREEN}=== Done ===${NC}"
echo ""
echo "The warm local browser in production will now use these credentials."
echo "Monitor with: fly logs"
