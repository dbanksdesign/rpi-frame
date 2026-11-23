import { describe, it, expect } from 'vitest'
import { updatePanelReducer, initialUpdatePanelState, recoverFromStatus, type UpdatePanelState } from './updatePanelReducer'

const idle = initialUpdatePanelState
const available: UpdatePanelState = { phase: 'available', current: 'v1.0.0', latest: 'v1.1.0', notes: 'n' }
const installing: UpdatePanelState = { phase: 'installing', current: 'v1.0.0', latest: 'v1.1.0', target: 'v1.1.0' }
const reconnecting: UpdatePanelState = { phase: 'reconnecting', current: 'v1.0.0', latest: 'v1.1.0', target: 'v1.1.0' }

describe('updatePanelReducer', () => {
  it('check started moves idle to checking', () => {
    expect(updatePanelReducer(idle, { type: 'checkStarted' }).phase).toBe('checking')
  })

  it('check result with update -> available', () => {
    const s = updatePanelReducer(
      { ...idle, phase: 'checking' },
      { type: 'checkResult', result: { current: 'v1.0.0', latest: 'v1.1.0', updateAvailable: true, notes: 'hi' } },
    )
    expect(s).toMatchObject({ phase: 'available', current: 'v1.0.0', latest: 'v1.1.0', notes: 'hi' })
  })

  it('check result without update -> upToDate', () => {
    const s = updatePanelReducer(
      { ...idle, phase: 'checking' },
      { type: 'checkResult', result: { current: 'v1.0.0', updateAvailable: false } },
    )
    expect(s.phase).toBe('upToDate')
    expect(s.message).toBeUndefined()
  })

  it('check result with server error carries the message', () => {
    const s = updatePanelReducer(
      { ...idle, phase: 'checking' },
      { type: 'checkResult', result: { current: 'v1.0.0', updateAvailable: false, error: "Couldn't check for updates right now" } },
    )
    expect(s).toMatchObject({ phase: 'upToDate', message: "Couldn't check for updates right now" })
  })

  it('check result is ignored when not checking', () => {
    const s = updatePanelReducer(installing, {
      type: 'checkResult',
      result: { current: 'v1.0.0', updateAvailable: false },
    })
    expect(s).toBe(installing)
  })

  it('install started -> installing with target', () => {
    const s = updatePanelReducer(available, { type: 'installStarted', tag: 'v1.1.0' })
    expect(s).toMatchObject({ phase: 'installing', target: 'v1.1.0' })
  })

  it('install started is ignored while already installing', () => {
    expect(updatePanelReducer(installing, { type: 'installStarted', tag: 'v9.9.9' })).toBe(installing)
  })

  it('fetch failure while installing -> reconnecting, not failed', () => {
    expect(updatePanelReducer(installing, { type: 'fetchFailed' }).phase).toBe('reconnecting')
  })

  it('fetch failure while reconnecting stays reconnecting', () => {
    expect(updatePanelReducer(reconnecting, { type: 'fetchFailed' })).toBe(reconnecting)
  })

  it('fetch failure in other phases is ignored', () => {
    expect(updatePanelReducer(available, { type: 'fetchFailed' })).toBe(available)
  })

  it('server back with target version -> succeeded', () => {
    const s = updatePanelReducer(reconnecting, { type: 'serverBack', version: 'v1.1.0', ok: true })
    expect(s).toMatchObject({ phase: 'succeeded', current: 'v1.1.0' })
  })

  it('server back with a different version -> failed with rollback message', () => {
    const s = updatePanelReducer(reconnecting, { type: 'serverBack', version: 'v1.0.0', ok: true })
    expect(s).toMatchObject({
      phase: 'failed',
      message: "The update didn't finish; the previous version is still running",
    })
  })

  it('server back not ok stays reconnecting', () => {
    expect(updatePanelReducer(reconnecting, { type: 'serverBack', version: 'v1.1.0', ok: false })).toBe(reconnecting)
  })

  it('server back is ignored when not reconnecting', () => {
    expect(updatePanelReducer(installing, { type: 'serverBack', version: 'v1.1.0', ok: true })).toBe(installing)
  })

  it('status failed -> failed with server message', () => {
    const s = updatePanelReducer(installing, {
      type: 'pollResult',
      status: { state: 'failed', tag: 'v1.1.0', message: 'Rolled back to v1.0.0' },
    })
    expect(s).toMatchObject({ phase: 'failed', message: 'Rolled back to v1.0.0' })
  })

  it('status succeeded -> succeeded', () => {
    expect(updatePanelReducer(installing, { type: 'pollResult', status: { state: 'succeeded', tag: 'v1.1.0' } }).phase).toBe('succeeded')
  })

  it('status running updates progress message and stays installing', () => {
    const s = updatePanelReducer(installing, { type: 'pollResult', status: { state: 'running', message: 'Downloading' } })
    expect(s).toMatchObject({ phase: 'installing', message: 'Downloading' })
  })

  it('stale succeeded with a different tag is ignored', () => {
    expect(updatePanelReducer(installing, { type: 'pollResult', status: { state: 'succeeded', tag: 'v1.0.5' } })).toBe(installing)
  })

  it('succeeded with a missing tag is ignored', () => {
    expect(updatePanelReducer(installing, { type: 'pollResult', status: { state: 'succeeded' } })).toBe(installing)
  })

  it('failed with a different tag is ignored', () => {
    expect(updatePanelReducer(installing, { type: 'pollResult', status: { state: 'failed', tag: 'v1.0.5', message: 'old' } })).toBe(installing)
  })

  it('matching tag ignores a v prefix difference', () => {
    expect(updatePanelReducer(installing, { type: 'pollResult', status: { state: 'succeeded', tag: '1.1.0' } }).phase).toBe('succeeded')
  })

  it('status poll is ignored when not installing', () => {
    expect(updatePanelReducer(available, { type: 'pollResult', status: { state: 'failed', message: 'x' } })).toBe(available)
  })

  it('timeout while installing/reconnecting -> failed', () => {
    const msg = 'The frame is taking longer than expected — check it directly'
    expect(updatePanelReducer(reconnecting, { type: 'timeout' })).toMatchObject({ phase: 'failed', message: msg })
    expect(updatePanelReducer(installing, { type: 'timeout' })).toMatchObject({ phase: 'failed', message: msg })
  })

  it('reset -> idle', () => {
    expect(updatePanelReducer(installing, { type: 'reset' }).phase).toBe('idle')
  })
})

describe('recoverFromStatus', () => {
  it('running resumes installing with the status tag', () => {
    expect(recoverFromStatus('v1.1.0', { state: 'running', tag: 'v1.2.0' })).toEqual({ type: 'resume', phase: 'installing', target: 'v1.2.0' })
  })
  it('running falls back to the stored tag', () => {
    expect(recoverFromStatus('v1.1.0', { state: 'running' })).toEqual({ type: 'resume', phase: 'installing', target: 'v1.1.0' })
  })
  it('running with no tag and nothing stored yields no event', () => {
    expect(recoverFromStatus(null, { state: 'running' })).toBeNull()
  })
  it('succeeded with matching stored tag resumes as succeeded', () => {
    expect(recoverFromStatus('v1.1.0', { state: 'succeeded', tag: '1.1.0' })).toEqual({ type: 'resume', phase: 'succeeded', target: 'v1.1.0' })
  })
  it('failed with matching stored tag resumes as failed with the message', () => {
    expect(recoverFromStatus('v1.1.0', { state: 'failed', tag: 'v1.1.0', message: 'Rolled back' })).toEqual({
      type: 'resume', phase: 'failed', target: 'v1.1.0', message: 'Rolled back',
    })
  })
  it('final status without stored tag yields no event', () => {
    expect(recoverFromStatus(null, { state: 'succeeded', tag: 'v1.1.0' })).toBeNull()
  })
  it('final status with a different tag yields no event', () => {
    expect(recoverFromStatus('v1.1.0', { state: 'failed', tag: 'v1.0.0', message: 'x' })).toBeNull()
  })
  it('idle status yields no event', () => {
    expect(recoverFromStatus('v1.1.0', { state: 'idle' })).toBeNull()
  })
  it('fetch failure with stored tag resumes reconnecting', () => {
    expect(recoverFromStatus('v1.1.0', null)).toEqual({ type: 'resume', phase: 'reconnecting', target: 'v1.1.0' })
  })
  it('fetch failure without stored tag yields no event', () => {
    expect(recoverFromStatus(null, null)).toBeNull()
  })
})

describe('resume event', () => {
  it('applies from idle', () => {
    expect(updatePanelReducer(idle, { type: 'resume', phase: 'installing', target: 'v1.1.0' })).toMatchObject({ phase: 'installing', target: 'v1.1.0' })
    expect(updatePanelReducer(idle, { type: 'resume', phase: 'failed', target: 'v1.1.0', message: 'm' })).toMatchObject({ phase: 'failed', message: 'm' })
  })
  it('is ignored when not idle', () => {
    expect(updatePanelReducer(available, { type: 'resume', phase: 'installing', target: 'v1.1.0' })).toBe(available)
  })
})
