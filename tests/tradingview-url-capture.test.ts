import { describe, expect, it } from 'vitest'
import {
  canonicalizeTradingViewScriptUrl,
  extractScriptIdFromText,
  extractScriptIdFromUrl,
  resolveScriptsApiUsername,
  selectExactTitleMatchScriptUrl,
} from '../src/server/tradingview'

describe('tradingview URL capture helpers', () => {
  it('canonicalizes full script URLs to canonical form', () => {
    const result = canonicalizeTradingViewScriptUrl('https://www.tradingview.com/script/AbC123/My-Indicator/?foo=bar')
    expect(result).toBe('https://www.tradingview.com/script/AbC123/')
  })

  it('extracts script id from JSON payload text', () => {
    const result = extractScriptIdFromText('{"scriptId":"XyZ789"}')
    expect(result).toBe('XyZ789')
  })

  it('extracts script id from URL', () => {
    const result = extractScriptIdFromUrl('https://www.tradingview.com/script/LMN456/')
    expect(result).toBe('LMN456')
  })

  it('selects exact title match only from scripts API results', () => {
    const result = selectExactTitleMatchScriptUrl('My Exact Script', [
      { name: 'My Exact Script', chart_url: 'https://www.tradingview.com/script/AbC111/' },
      { name: 'My Exact Script Copy', chart_url: 'https://www.tradingview.com/script/Bad999/' },
    ])
    expect(result).toBe('https://www.tradingview.com/script/AbC111/')
  })

  it('rejects partial title matches', () => {
    const result = selectExactTitleMatchScriptUrl('My Exact Script', [
      { name: 'My Exact Script v2', chart_url: 'https://www.tradingview.com/script/Bad999/' },
    ])
    expect(result).toBeNull()
  })

  it('matches title case-insensitively with trimmed whitespace', () => {
    const result = selectExactTitleMatchScriptUrl('  My Exact Script  ', [
      { name: 'my exact script', chart_url: 'https://www.tradingview.com/script/Trim123/' },
    ])
    expect(result).toBe('https://www.tradingview.com/script/Trim123/')
  })

  it('falls back to url field when chart_url is missing', () => {
    const result = selectExactTitleMatchScriptUrl('My Exact Script', [
      { name: 'My Exact Script', url: 'https://www.tradingview.com/script/Url456/My-Exact-Script/' },
    ])
    expect(result).toBe('https://www.tradingview.com/script/Url456/')
  })

  it('falls back to image_url id when chart_url and url are missing', () => {
    const result = selectExactTitleMatchScriptUrl('My Exact Script', [
      { name: 'My Exact Script', image_url: 'Img789' },
    ])
    expect(result).toBe('https://www.tradingview.com/script/Img789/')
  })

  it('resolves scripts API username from TV_SERVICE_ACCOUNT_USERNAME first', () => {
    const result = resolveScriptsApiUsername({
      TV_SERVICE_ACCOUNT_USERNAME: 'service-user',
      TV_USERNAME: 'fallback-user',
    } as NodeJS.ProcessEnv)
    expect(result).toBe('service-user')
  })

  it('falls back to TV_USERNAME when TV_SERVICE_ACCOUNT_USERNAME is missing', () => {
    const result = resolveScriptsApiUsername({
      TV_USERNAME: 'main-tv-user',
    } as NodeJS.ProcessEnv)
    expect(result).toBe('main-tv-user')
  })

  it('returns null when both script lookup username env vars are missing', () => {
    const result = resolveScriptsApiUsername({} as NodeJS.ProcessEnv)
    expect(result).toBeNull()
  })
})
