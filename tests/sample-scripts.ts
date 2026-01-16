// Sample Pine Scripts for testing

export const VALID_SIMPLE_INDICATOR = `//@version=5
indicator("Simple Moving Average", overlay=true)

// Input parameters
length = input.int(20, "MA Length", minval=1)
src = input.source(close, "Source")

// Calculate moving average
ma = ta.sma(src, length)

// Plot
plot(ma, "SMA", color=color.blue, linewidth=2)
`

export const VALID_RSI_STRATEGY = `//@version=5
strategy("RSI Strategy", overlay=true, default_qty_type=strategy.percent_of_equity, default_qty_value=10)

// RSI settings
rsiLength = input.int(14, "RSI Length")
overbought = input.int(70, "Overbought Level")
oversold = input.int(30, "Oversold Level")

// Calculate RSI
rsi = ta.rsi(close, rsiLength)

// Entry conditions
longCondition = ta.crossover(rsi, oversold)
shortCondition = ta.crossunder(rsi, overbought)

// Execute trades
if longCondition
    strategy.entry("Long", strategy.long)

if shortCondition
    strategy.close("Long")

// Plot RSI on separate pane
plot(rsi, "RSI", color=color.purple)
hline(overbought, "Overbought", color=color.red)
hline(oversold, "Oversold", color=color.green)
`

export const VALID_MACD_INDICATOR = `//@version=5
indicator("MACD Custom", overlay=false)

// MACD parameters
fastLength = input.int(12, "Fast Length")
slowLength = input.int(26, "Slow Length")
signalLength = input.int(9, "Signal Smoothing")

// Calculate MACD
[macdLine, signalLine, histLine] = ta.macd(close, fastLength, slowLength, signalLength)

// Colors
histColor = histLine >= 0 ? (histLine > histLine[1] ? color.green : color.lime) : (histLine < histLine[1] ? color.red : color.maroon)

// Plots
plot(macdLine, "MACD", color=color.blue)
plot(signalLine, "Signal", color=color.orange)
plot(histLine, "Histogram", style=plot.style_columns, color=histColor)
hline(0, "Zero Line", color=color.gray)
`

export const SCRIPT_WITH_ERRORS = `//@version=5
indicator("Broken Script", overlay=true)

// Missing variable declaration
plot(undefinedVariable)

// Wrong function name
ma = ta.smaa(close, 20)

// Missing closing parenthesis
if close > open
    plot(high
`

export const SCRIPT_WITH_WARNINGS = `//@version=5
indicator("Script with Warnings")

// Deprecated function (Pine v4 style)
sma_val = sma(close, 20)

// Repainting function usage
security_val = request.security(syminfo.tickerid, "D", close)

plot(sma_val)
plot(security_val)
`

export const MINIMAL_VALID = `//@version=5
indicator("Minimal")
plot(close)
`

// For automated testing
export const ALL_SCRIPTS = {
  valid: {
    simple: VALID_SIMPLE_INDICATOR,
    rsi: VALID_RSI_STRATEGY,
    macd: VALID_MACD_INDICATOR,
    minimal: MINIMAL_VALID,
  },
  invalid: {
    errors: SCRIPT_WITH_ERRORS,
    warnings: SCRIPT_WITH_WARNINGS,
  },
}
