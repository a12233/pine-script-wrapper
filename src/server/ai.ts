import { generateText, generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'

// Pine Script analysis prompts
const ANALYSIS_SYSTEM_PROMPT = `You are an expert Pine Script developer for TradingView.
Your task is to analyze Pine Script code for potential issues and suggest corrections.

Pine Script is TradingView's programming language for creating custom indicators and strategies.
Key things to check:
1. Syntax errors (missing brackets, incorrect operators)
2. Version compatibility (v4 vs v5 syntax differences)
3. Reserved keyword usage
4. Function parameter types
5. Variable declarations and scoping
6. Series vs simple type mismatches
7. Security function limitations
8. Strategy-specific rules (position sizing, order types)

Always provide specific, actionable corrections with exact code changes.`

const CorrectionSchema = z.object({
  corrections: z.array(
    z.object({
      line: z.number().describe('Line number with the issue'),
      original: z.string().describe('The original problematic code'),
      corrected: z.string().describe('The corrected code'),
      explanation: z.string().describe('Brief explanation of the fix'),
    })
  ),
  summary: z.string().describe('Overall summary of issues found'),
  correctedScript: z.string().describe('The full corrected script'),
})

export type CorrectionResult = z.infer<typeof CorrectionSchema>

export interface AnalysisResult {
  hasIssues: boolean
  summary: string
  potentialProblems: string[]
}

/**
 * Pre-analyze a Pine Script before sending to TradingView
 * This catches obvious issues without needing browser automation
 */
export async function analyzePineScript(script: string): Promise<AnalysisResult> {
  const { text } = await generateText({
    model: anthropic('claude-sonnet-4-20250514'),
    system: ANALYSIS_SYSTEM_PROMPT,
    prompt: `Analyze this Pine Script for potential issues. Be concise.

Script:
\`\`\`pine
${script}
\`\`\`

List any potential syntax errors, version issues, or common mistakes you spot.
If the script looks valid, say so.`,
  })

  // Parse the response to determine if there are issues
  const hasIssues =
    text.toLowerCase().includes('error') ||
    text.toLowerCase().includes('issue') ||
    text.toLowerCase().includes('problem') ||
    text.toLowerCase().includes('incorrect')

  // Extract bullet points as potential problems
  const lines = text.split('\n')
  const potentialProblems = lines
    .filter((line) => line.trim().startsWith('-') || line.trim().startsWith('•'))
    .map((line) => line.replace(/^[-•]\s*/, '').trim())
    .filter((line) => line.length > 0)

  return {
    hasIssues,
    summary: text,
    potentialProblems,
  }
}

/**
 * Generate corrections for a Pine Script based on TradingView errors
 */
export async function generateCorrections(
  script: string,
  tvErrors: string
): Promise<CorrectionResult> {
  const { object } = await generateObject({
    model: anthropic('claude-sonnet-4-20250514'),
    system: ANALYSIS_SYSTEM_PROMPT,
    schema: CorrectionSchema,
    prompt: `Fix this Pine Script based on the TradingView compiler errors.

Original Script:
\`\`\`pine
${script}
\`\`\`

TradingView Errors:
${tvErrors}

Provide specific corrections for each error and the full corrected script.`,
  })

  return object
}

/**
 * Quick syntax check without full AI analysis
 * Uses pattern matching for common Pine Script issues
 */
export function quickSyntaxCheck(script: string): string[] {
  const issues: string[] = []

  // Check for version declaration
  if (!script.includes('//@version=')) {
    issues.push('Missing version declaration. Add //@version=5 at the top.')
  }

  // Check for unclosed brackets
  const openParens = (script.match(/\(/g) || []).length
  const closeParens = (script.match(/\)/g) || []).length
  if (openParens !== closeParens) {
    issues.push(`Mismatched parentheses: ${openParens} open, ${closeParens} close`)
  }

  const openBrackets = (script.match(/\[/g) || []).length
  const closeBrackets = (script.match(/\]/g) || []).length
  if (openBrackets !== closeBrackets) {
    issues.push(`Mismatched square brackets: ${openBrackets} open, ${closeBrackets} close`)
  }

  // Check for common v4 to v5 migration issues
  if (script.includes('//@version=5')) {
    if (script.includes('study(')) {
      issues.push('In v5, use indicator() instead of study()')
    }
    if (script.includes('security(')) {
      issues.push('In v5, use request.security() instead of security()')
    }
    if (script.match(/\bcolor\./)) {
      // This is fine in v5
    } else if (script.match(/\bcolor\s*=\s*[a-z]+\b/)) {
      issues.push('In v5, use color.red, color.blue, etc. instead of bare color names')
    }
  }

  // Check for indicator/strategy declaration
  if (!script.includes('indicator(') && !script.includes('strategy(') && !script.includes('library(')) {
    if (!script.includes('study(')) {
      issues.push('Missing indicator(), strategy(), or library() declaration')
    }
  }

  return issues
}
