/**
 * Timing instrumentation utility for performance monitoring
 */

export function startTimer(prefix: string, operation: string) {
  const start = Date.now()
  console.log(`[${prefix}] ${operation} started`)
  return {
    mark: (label: string) => {
      console.log(`[${prefix}]   └─ ${label}: ${Date.now() - start}ms`)
    },
    end: () => {
      const duration = Date.now() - start
      console.log(`[${prefix}] ${operation} completed in ${duration}ms`)
      return duration
    },
  }
}
