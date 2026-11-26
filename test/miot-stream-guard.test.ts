import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyDeviceStop,
  STREAM_FAIL_WINDOW_MS,
  STREAM_TTS_GRACE_MS,
  type DeviceStopContext,
} from '../src/server/integrations/miot/streamGuard'

const base: DeviceStopContext = {
  position: 10,
  duration: 240,
  hasPosition: true,
  devicePosition: 0,
  playConfirmed: false,
  playStartedAt: 1_000,
  lastTtsAt: 0,
  now: 20_000,
}

test('stop near track end is treated as natural end', () => {
  assert.equal(classifyDeviceStop({ ...base, position: 238 }), 'ended')
})

test('confirmed playback stopping early keeps existing behavior', () => {
  assert.equal(classifyDeviceStop({ ...base, playConfirmed: true }), 'defer')
})

test('stop right after our own TTS is not a stream failure', () => {
  assert.equal(classifyDeviceStop({ ...base, lastTtsAt: base.now - STREAM_TTS_GRACE_MS + 1 }), 'tts-interrupted')
})

test('stop outside the start window is not a stream failure', () => {
  assert.equal(classifyDeviceStop({ ...base, playStartedAt: base.now - STREAM_FAIL_WINDOW_MS - 1 }), 'defer')
})

test('device position advanced means playback really started', () => {
  assert.equal(classifyDeviceStop({ ...base, devicePosition: 5 }), 'defer')
})

test('unconfirmed stop at position zero is a stream failure', () => {
  assert.equal(classifyDeviceStop(base), 'stream-failed')
})

test('natural end wins over TTS grace', () => {
  assert.equal(classifyDeviceStop({ ...base, position: 240, lastTtsAt: base.now }), 'ended')
})
