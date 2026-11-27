import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyDeviceStop,
  isStreamFetchLoop,
  STREAM_FAIL_WINDOW_MS,
  STREAM_LOOP_MIN_FETCHES,
  STREAM_LOOP_WINDOW_MS,
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

const now = 1_000_000

test('repeated re-fetches within the window flag a stream loop', () => {
  const fetches = Array.from({ length: STREAM_LOOP_MIN_FETCHES }, (_, i) => now - i * 4_000)
  assert.equal(isStreamFetchLoop(fetches, now), true)
})

test('re-fetches outside the window are ignored', () => {
  const fetches = [
    now - STREAM_LOOP_WINDOW_MS - 5_000,
    now - 12_000,
    now - 8_000,
    now - 4_000,
    now - 1_000,
  ]
  assert.equal(isStreamFetchLoop(fetches, now), false)
})

test('fewer re-fetches than the threshold are not a loop', () => {
  const fetches = Array.from({ length: STREAM_LOOP_MIN_FETCHES - 1 }, (_, i) => now - i * 4_000)
  assert.equal(isStreamFetchLoop(fetches, now), false)
})

test('no fetches is not a loop', () => {
  assert.equal(isStreamFetchLoop([], now), false)
})
