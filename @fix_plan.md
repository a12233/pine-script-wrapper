# Ralph Fix Plan

## High Priority
- [x] Add "add to chart" validation to /src/server/tradingview.ts (already exists)

## Medium Priority
- [ ] Update /src/routes/validate.tsx to use validation loop (BLOCKED - needs permission)
- [ ] Update /src/routes/index.tsx to remove connection requirement
- [ ] Remove /src/routes/connect.tsx

## Low Priority
- [ ] Clean up /src/server/kv.ts - remove unused credential functions
- [ ] Update .env.example with service account vars
- [ ] Remove any other unused code referencing user credentials

## Completed
- [x] Create /src/server/service-validation.ts
- [x] Create /src/server/validation-loop.ts
- [x] Create /src/server/prompts/pine-script-fix.ts
- [x] Add fixPineScriptErrors() to validation-loop.ts (inline implementation)

## Notes
- Service account uses TV_USERNAME/TV_PASSWORD env vars
- Max 1 retry for auto-fix loop
- Show final result only to user
- "Add to chart" validation already exists in tradingview.ts validatePineScriptV2()
- BLOCKED: Need write permission for src/routes/validate.tsx and src/routes/index.tsx
