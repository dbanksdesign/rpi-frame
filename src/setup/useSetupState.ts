import { useCallback, useEffect, useState } from 'react'
import { screenFor, type Screen } from './screenFor'
import type { SetupState } from './types'

const POLL_MS = 3000

export function useSetupState(): { state: SetupState | null; screen: Screen; dismissReadyCard: () => void } {
  const [state, setState] = useState<SetupState | null>(null)
  // true = card already shown or not applicable. Undefined until first observation.
  const [cardShown, setCardShown] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined

    const poll = async () => {
      controller = new AbortController()
      try {
        const res = await fetch('/api/setup/state', { signal: controller.signal })
        if (res.ok) {
          const next = (await res.json()) as SetupState
          if (!cancelled && next && typeof next.phase === 'string') {
            setState(next)
            // Initialize on first observation: READY on first load => no card.
            setCardShown((prev) => (prev === null ? next.phase === 'READY' : prev))
            // A later non-READY phase re-arms the card.
            if (next.phase !== 'READY') setCardShown(false)
          }
        }
      } catch {
        // Unreachable server / bad JSON: keep last known state.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS)
    }
    poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      controller?.abort()
    }
  }, [])

  const dismissReadyCard = useCallback(() => setCardShown(true), [])

  const screen: Screen = state ? screenFor(state, cardShown ?? true) : 'slideshow'
  return { state, screen, dismissReadyCard }
}
