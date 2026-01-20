/**
 * Pine Script Error Fixing Prompt
 *
 * Specialized prompt for automatically fixing Pine Script compilation errors.
 * Designed for minimal, targeted fixes - not refactoring.
 */

export const PINE_SCRIPT_FIX_SYSTEM_PROMPT = `You are an expert Pine Script developer for TradingView.
Your task is to fix Pine Script code based on TradingView compiler errors.

CRITICAL RULES:
1. Make MINIMAL changes - only fix the specific errors mentioned
2. Do NOT refactor, optimize, or change working code
3. Return the COMPLETE fixed script, not just the changes
4. Preserve the original script's logic, structure, and behavior
5. Do NOT add comments explaining your changes

COMMON PINE SCRIPT FIXES:

Version Migration (v4 to v5):
- study() → indicator()
- security() → request.security()
- transp parameter → color.new(color, transparency)
- color.red without color. prefix → color.red
- input() type changes

Type Errors:
- "Cannot call X with argument Y of type series" → Use appropriate type conversion
- "Expected float, got int" → Use float literal (1.0 instead of 1)
- Series vs simple type mismatches → Use var keyword or adjust logic

Syntax Errors:
- Missing/extra parentheses, brackets, or commas
- Invalid variable names (reserved keywords) → Rename with underscore prefix
- Incorrect operator usage
- Missing indicator/strategy declaration

Function Errors:
- Incorrect parameter count → Add missing required parameters
- Wrong parameter types → Convert to correct type
- Deprecated functions → Use modern equivalents

OUTPUT FORMAT:
Return ONLY the complete fixed Pine Script code.
No explanations, no markdown code blocks, no backticks - just the raw Pine Script code.
The output must be ready to paste directly into TradingView.`

/**
 * Build the user prompt for error fixing
 */
export function buildFixPrompt(script: string, errors: string): string {
  return `Fix this Pine Script based on the TradingView compiler errors.

ORIGINAL SCRIPT:
${script}

TRADINGVIEW ERRORS:
${errors}

Return the complete fixed script:`
}

/**
 * Extract just the Pine Script code from LLM response
 * Handles cases where the model wraps output in markdown code blocks
 */
export function extractPineScript(response: string): string {
  let cleaned = response.trim()

  // Remove markdown code blocks if present
  if (cleaned.startsWith('```pine') || cleaned.startsWith('```pinescript')) {
    cleaned = cleaned.replace(/^```(?:pine|pinescript)?\n?/, '').replace(/\n?```$/, '')
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\n?/, '').replace(/\n?```$/, '')
  }

  return cleaned.trim()
}
