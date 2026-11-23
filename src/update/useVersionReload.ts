import { useEffect } from 'react'

/** Reload only when both versions are real releases and they differ. */
export function shouldReload(initial: string | null, latest: string | null): boolean {
  if (!initial || !latest) return false
  if (initial === 'dev' || latest === 'dev') return false
  return initial !== latest
}

/**
 * Reloads the page when the server reports a different release version than
 * the one seen on mount (e.g. the frame was updated while the kiosk was open).
 */
export function useVersionReload(pollMs = 60000): void {
  useEffect(() => {
    let cancelled = false
    let initial: string | null = null
    let controller: AbortController | undefined

    const fetchVersion = async (): Promise<string | null> => {
      controller = new AbortController()
      try {
        const res = await fetch('/api/version', { signal: controller.signal })
        if (!res.ok) return null
        const data = (await res.json()) as { version?: unknown }
        return typeof data.version === 'string' ? data.version : null
      } catch {
        return null // transient failure (e.g. server restarting): ignore
      }
    }

    const tick = async () => {
      const latest = await fetchVersion()
      if (cancelled || latest === null) return
      if (initial === null) {
        initial = latest
        return
      }
      if (shouldReload(initial, latest)) window.location.reload()
    }

    void tick()
    const timer = setInterval(() => void tick(), pollMs)
    return () => {
      cancelled = true
      clearInterval(timer)
      controller?.abort()
    }
  }, [pollMs])
}
