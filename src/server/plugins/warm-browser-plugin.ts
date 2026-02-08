/**
 * Nitro plugin: Start warm browser and keep-alive at server startup.
 */
import { definePlugin } from 'nitro'
import { startPreWarm, startKeepAlive } from '../warm-browser'

export default definePlugin(() => {
  console.log('[Plugin:warm-browser] Initializing...')
  startPreWarm()
  startKeepAlive()
})
