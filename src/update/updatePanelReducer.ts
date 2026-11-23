export type UpdatePanelPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'upToDate'
  | 'installing'
  | 'reconnecting'
  | 'succeeded'
  | 'failed'

export interface UpdatePanelState {
  phase: UpdatePanelPhase
  current?: string
  latest?: string
  notes?: string
  message?: string
  /** Tag being installed; the server must report this version once it is back. */
  target?: string
}

export interface CheckResult {
  current: string
  latest?: string
  updateAvailable: boolean
  notes?: string
  error?: string
}

export interface StatusResult {
  state: 'idle' | 'running' | 'succeeded' | 'failed'
  tag?: string
  message?: string
}

export type UpdatePanelEvent =
  | { type: 'checkStarted' }
  | { type: 'checkResult'; result: CheckResult }
  | { type: 'installStarted'; tag: string }
  | { type: 'pollResult'; status: StatusResult }
  | { type: 'fetchFailed' }
  | { type: 'serverBack'; version: string; ok: boolean }
  | { type: 'timeout' }
  | { type: 'resume'; phase: 'installing' | 'reconnecting' | 'succeeded' | 'failed'; target: string; message?: string }
  | { type: 'reset' }

export const ROLLBACK_MESSAGE = "The update didn't finish; the previous version is still running"
export const TIMEOUT_MESSAGE = 'The frame is taking longer than expected — check it directly'

export const initialUpdatePanelState: UpdatePanelState = { phase: 'idle' }

const norm = (v: string) => v.trim().replace(/^v/i, '')

export function updatePanelReducer(state: UpdatePanelState, event: UpdatePanelEvent): UpdatePanelState {
  switch (event.type) {
    case 'checkStarted':
      if (state.phase === 'installing' || state.phase === 'reconnecting' || state.phase === 'checking') return state
      return { phase: 'checking', current: state.current }

    case 'checkResult': {
      if (state.phase !== 'checking') return state
      const r = event.result
      if (r.updateAvailable && r.latest) {
        return { phase: 'available', current: r.current, latest: r.latest, notes: r.notes }
      }
      return { phase: 'upToDate', current: r.current, ...(r.error ? { message: r.error } : {}) }
    }

    case 'installStarted':
      if (state.phase !== 'available' && state.phase !== 'failed') return state
      return { ...state, phase: 'installing', target: event.tag, message: undefined }

    case 'pollResult': {
      if (state.phase !== 'installing') return state
      const { status } = event
      if (status.state === 'succeeded' || status.state === 'failed') {
        // Ignore stale results left over from an earlier update.
        if (!state.target || !status.tag || norm(status.tag) !== norm(state.target)) return state
      }
      if (status.state === 'failed') return { ...state, phase: 'failed', message: status.message }
      if (status.state === 'succeeded') {
        return { ...state, phase: 'succeeded', current: state.target ?? state.current, message: undefined }
      }
      if (status.state === 'running' && status.message && status.message !== state.message) {
        return { ...state, message: status.message }
      }
      return state
    }

    case 'fetchFailed':
      if (state.phase === 'installing') return { ...state, phase: 'reconnecting' }
      return state

    case 'serverBack': {
      if (state.phase !== 'reconnecting' || !event.ok) return state
      if (state.target && norm(event.version) === norm(state.target)) {
        return { ...state, phase: 'succeeded', current: event.version, message: undefined }
      }
      return { ...state, phase: 'failed', current: event.version, message: ROLLBACK_MESSAGE }
    }

    case 'resume':
      if (state.phase !== 'idle') return state
      return {
        phase: event.phase,
        current: state.current,
        target: event.target,
        ...(event.phase === 'succeeded' ? { current: event.target } : {}),
        ...(event.message ? { message: event.message } : {}),
      }

    case 'timeout':
      if (state.phase !== 'installing' && state.phase !== 'reconnecting') return state
      return { ...state, phase: 'failed', message: TIMEOUT_MESSAGE }

    case 'reset':
      return { phase: 'idle', current: state.current }
  }
}

/**
 * Decide how a freshly mounted panel should resume an in-flight or just-finished
 * update. `stored` is the target tag remembered when the install started;
 * `status` is null when /api/update/status could not be fetched.
 */
export function recoverFromStatus(stored: string | null, status: StatusResult | null): UpdatePanelEvent | null {
  if (status === null) {
    return stored ? { type: 'resume', phase: 'reconnecting', target: stored } : null
  }
  if (status.state === 'running') {
    const target = status.tag ?? stored
    return target ? { type: 'resume', phase: 'installing', target } : null
  }
  if (status.state === 'succeeded' || status.state === 'failed') {
    if (!stored || !status.tag || norm(status.tag) !== norm(stored)) return null
    return {
      type: 'resume',
      phase: status.state,
      target: stored,
      ...(status.state === 'failed' && status.message ? { message: status.message } : {}),
    }
  }
  return null
}
