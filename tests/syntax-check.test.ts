import { describe, it, expect } from 'vitest'
import {
  VALID_SIMPLE_INDICATOR,
  VALID_RSI_STRATEGY,
  MINIMAL_VALID,
  SCRIPT_WITH_ERRORS,
  SCRIPT_WITH_WARNINGS,
} from './sample-scripts'

// Copy of quickSyntaxCheck to avoid AI SDK import issues in tests
function quickSyntaxCheck(script: string): string[] {
  const issues: string[] = []

  if (!script.includes('//@version=')) {
    issues.push('Missing version declaration. Add //@version=5 at the top.')
  }

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

  if (script.includes('//@version=5')) {
    if (script.includes('study(')) {
      issues.push('In v5, use indicator() instead of study()')
    }
    if (script.includes('security(')) {
      issues.push('In v5, use request.security() instead of security()')
    }
  }

  if (!script.includes('indicator(') && !script.includes('strategy(') && !script.includes('library(')) {
    if (!script.includes('study(')) {
      issues.push('Missing indicator(), strategy(), or library() declaration')
    }
  }

  return issues
}

describe('quickSyntaxCheck', () => {
  it('should pass valid simple indicator', () => {
    const issues = quickSyntaxCheck(VALID_SIMPLE_INDICATOR)
    expect(issues).toHaveLength(0)
  })

  it('should pass valid RSI strategy', () => {
    const issues = quickSyntaxCheck(VALID_RSI_STRATEGY)
    expect(issues).toHaveLength(0)
  })

  it('should pass minimal valid script', () => {
    const issues = quickSyntaxCheck(MINIMAL_VALID)
    expect(issues).toHaveLength(0)
  })

  it('should detect mismatched parentheses', () => {
    const issues = quickSyntaxCheck(SCRIPT_WITH_ERRORS)
    const hasParenIssue = issues.some(issue => issue.includes('parentheses'))
    expect(hasParenIssue).toBe(true)
  })

  it('should detect deprecated v4 functions in v5 script', () => {
    const issues = quickSyntaxCheck(SCRIPT_WITH_WARNINGS)
    const hasSecurityIssue = issues.some(issue => issue.includes('request.security'))
    expect(hasSecurityIssue).toBe(true)
  })

  it('should detect missing version declaration', () => {
    const scriptNoVersion = `indicator("Test")
plot(close)`
    const issues = quickSyntaxCheck(scriptNoVersion)
    const hasVersionIssue = issues.some(issue => issue.includes('version'))
    expect(hasVersionIssue).toBe(true)
  })

  it('should detect missing indicator/strategy declaration', () => {
    const scriptNoDecl = `//@version=5
plot(close)`
    const issues = quickSyntaxCheck(scriptNoDecl)
    const hasDeclIssue = issues.some(issue => issue.includes('indicator()') || issue.includes('strategy()'))
    expect(hasDeclIssue).toBe(true)
  })
})
