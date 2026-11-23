import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Alert, Box, Button, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core'
import {
  initialUpdatePanelState,
  updatePanelReducer,
  recoverFromStatus,
  type CheckResult,
  type StatusResult,
} from '../update/updatePanelReducer'

const POLL_MS = 2000
const GIVE_UP_MS = 10 * 60 * 1000
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const LAST_CHECK_KEY = 'frame.update.lastCheck'
const TARGET_KEY = 'frame.update.target'
const CHECK_ERROR = "Couldn't check for updates right now"

function readLastCheck(): number {
  try {
    const raw = localStorage.getItem(LAST_CHECK_KEY)
    const n = raw ? Number(raw) : 0
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

function writeLastCheck(): void {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()))
  } catch {
    // storage unavailable: auto-check simply runs on every mount
  }
}

function readTarget(): string | null {
  try {
    return sessionStorage.getItem(TARGET_KEY)
  } catch {
    return null
  }
}

function writeTarget(tag: string | null): void {
  try {
    if (tag) sessionStorage.setItem(TARGET_KEY, tag)
    else sessionStorage.removeItem(TARGET_KEY)
  } catch {
    // storage unavailable: recovery after reload just won't work
  }
}

function describeVersion(v: string | undefined): string {
  if (!v) return 'unknown'
  return v === 'dev' ? 'development build' : v
}

function UpdatePanel() {
  const [state, dispatch] = useReducer(updatePanelReducer, initialUpdatePanelState)
  const [installed, setInstalled] = useState<string | undefined>(undefined)
  const [installError, setInstallError] = useState<string | null>(null)
  const checkController = useRef<AbortController | null>(null)
  const installController = useRef<AbortController | null>(null)
  const deadline = useRef(0)

  const runCheck = useCallback(async () => {
    checkController.current?.abort()
    const controller = new AbortController()
    checkController.current = controller
    dispatch({ type: 'checkStarted' })
    let result: CheckResult
    try {
      const res = await fetch('/api/update/check', { method: 'POST', signal: controller.signal })
      if (!res.ok) throw new Error('bad status')
      result = (await res.json()) as CheckResult
      if (typeof result?.updateAvailable !== 'boolean') throw new Error('bad payload')
    } catch {
      if (controller.signal.aborted) return
      dispatch({ type: 'checkResult', result: { current: '', updateAvailable: false, error: CHECK_ERROR } })
      return
    }
    if (controller.signal.aborted) return
    if (!result.error) writeLastCheck()
    dispatch({ type: 'checkResult', result })
  }, [])

  // Installed version + one automatic check per 6 hours; cleanup on unmount.
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/version', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { version?: unknown } | null) => {
        if (d && typeof d.version === 'string' && !controller.signal.aborted) setInstalled(d.version)
      })
      .catch(() => {})
    // Resume an in-flight or just-finished update before considering the auto-check.
    const recover = async () => {
      let status: StatusResult | null = null
      try {
        const res = await fetch('/api/update/status', { signal: controller.signal })
        if (res.ok) status = (await res.json()) as StatusResult
      } catch {
        status = null
      }
      if (controller.signal.aborted) return
      const event = recoverFromStatus(readTarget(), status)
      if (event) {
        deadline.current = Date.now() + GIVE_UP_MS
        dispatch(event)
        return
      }
      if (Date.now() - readLastCheck() > AUTO_CHECK_INTERVAL_MS) void runCheck()
    }
    void recover()
    return () => {
      controller.abort()
      checkController.current?.abort()
      installController.current?.abort()
    }
  }, [runCheck])

  // The remembered target is only needed while an update is in flight.
  useEffect(() => {
    if (state.phase === 'succeeded' || state.phase === 'failed') writeTarget(null)
  }, [state.phase])

  // Single polling loop, selected by phase. The effect cleanup guarantees only one runs.
  const polling = state.phase === 'installing' || state.phase === 'reconnecting' ? state.phase : null
  useEffect(() => {
    if (!polling) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    installController.current = controller

    const tick = async () => {
      if (cancelled) return
      if (Date.now() > deadline.current) {
        dispatch({ type: 'timeout' })
        return
      }
      try {
        if (polling === 'installing') {
          const res = await fetch('/api/update/status', { signal: controller.signal })
          if (!res.ok) throw new Error('bad status')
          const status = (await res.json()) as StatusResult
          if (cancelled) return
          dispatch({ type: 'pollResult', status })
        } else {
          const health = await fetch('/api/health', { signal: controller.signal })
          if (!health.ok) throw new Error('unhealthy')
          const ver = await fetch('/api/version', { signal: controller.signal })
          if (!ver.ok) throw new Error('bad version')
          const data = (await ver.json()) as { version?: unknown }
          if (cancelled) return
          if (typeof data.version !== 'string') throw new Error('bad version')
          dispatch({ type: 'serverBack', version: data.version, ok: true })
        }
      } catch {
        if (cancelled) return
        dispatch({ type: 'fetchFailed' })
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      controller.abort()
    }
  }, [polling])

  const install = async (tag: string) => {
    setInstallError(null)
    const controller = new AbortController()
    installController.current?.abort()
    installController.current = controller
    try {
      const res = await fetch('/api/update/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag }),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      let body: { status?: string; error?: string } = {}
      try {
        body = await res.json()
      } catch {
        // no JSON body
      }
      if (controller.signal.aborted) return
      if (res.status === 202 || (res.status === 409 && body.status === 'already-running')) {
        deadline.current = Date.now() + GIVE_UP_MS
        writeTarget(tag)
        dispatch({ type: 'installStarted', tag })
      } else {
        setInstallError(body.error ?? 'Could not start the update')
      }
    } catch {
      if (controller.signal.aborted) return
      setInstallError('Could not start the update')
    }
  }

  const busy = state.phase === 'checking' || state.phase === 'installing' || state.phase === 'reconnecting'
  const shownVersion = state.phase === 'succeeded' ? state.current : installed ?? state.current

  return (
    <Paper shadow="sm" p="md" mb="xl" withBorder>
      <Title order={3} mb="md">Software Update</Title>
      <Stack gap="sm">
        <Text size="sm">Installed version: {describeVersion(shownVersion)}</Text>

        <Group>
          <Button variant="light" onClick={() => void runCheck()} disabled={busy} loading={state.phase === 'checking'}>
            Check for updates
          </Button>
        </Group>

        {state.phase === 'upToDate' && (
          <Text size="sm" c={state.message ? 'dimmed' : 'green'}>
            {state.message ?? "You're up to date"}
          </Text>
        )}

        {state.phase === 'available' && (
          <Stack gap="xs">
            <Text size="sm" fw={500}>
              Update available: {state.current} → {state.latest}
            </Text>
            {state.notes && (
              <Box>
                <Text size="xs" c="dimmed" mb={4}>Release notes</Text>
                <Text size="xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {state.notes}
                </Text>
              </Box>
            )}
            <Text size="xs" c="dimmed">
              The frame will restart and the slideshow will pause for about a minute.
            </Text>
            <Group>
              <Button onClick={() => void install(state.latest as string)}>Update to {state.latest}</Button>
            </Group>
          </Stack>
        )}

        {state.phase === 'installing' && (
          <Group gap="xs">
            <Loader size="sm" />
            <Text size="sm">{state.message ?? 'Updating…'}</Text>
          </Group>
        )}

        {state.phase === 'reconnecting' && (
          <Group gap="xs">
            <Loader size="sm" />
            <Text size="sm">Reconnecting…</Text>
          </Group>
        )}

        {state.phase === 'succeeded' && (
          <Alert color="green">Updated to {state.target ?? state.current}</Alert>
        )}

        {state.phase === 'failed' && (
          <Alert color="red" title="Update failed">
            {state.message}
          </Alert>
        )}

        {installError && <Alert color="red">{installError}</Alert>}
      </Stack>
    </Paper>
  )
}

export default UpdatePanel
