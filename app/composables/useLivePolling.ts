import { onBeforeUnmount, onMounted, toValue, watch } from 'vue'
import type { MaybeRefOrGetter } from 'vue'

const LIVE_POLL_INTERVAL_MS = 5 * 60 * 1000

type LiveRefresh = (options?: { manual?: boolean }) => Promise<void> | void

/**
 * Keeps page-level live views aligned to the official five-minute cadence.
 * The first request runs on mount; later requests run just after each boundary.
 */
export function useLivePolling(refresh: LiveRefresh, enabled: MaybeRefOrGetter<boolean>) {
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let startTimer: ReturnType<typeof setTimeout> | undefined

  function stop() {
    if (pollTimer) clearInterval(pollTimer)
    if (startTimer) clearTimeout(startTimer)
    pollTimer = undefined
    startTimer = undefined
  }

  function start() {
    if (!toValue(enabled) || pollTimer || startTimer) return
    void refresh()
    const delayToNextCheck = LIVE_POLL_INTERVAL_MS - (Date.now() % LIVE_POLL_INTERVAL_MS) + 2_000
    startTimer = setTimeout(() => {
      startTimer = undefined
      if (!toValue(enabled)) return
      void refresh()
      pollTimer = setInterval(() => { void refresh() }, LIVE_POLL_INTERVAL_MS)
    }, delayToNextCheck)
  }

  watch(() => toValue(enabled), (isEnabled) => {
    if (isEnabled) start()
    else stop()
  })
  onMounted(start)
  onBeforeUnmount(stop)

  return { start, stop }
}
