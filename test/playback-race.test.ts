import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PLAYBACK_RACE,
  getPlaybackRaceConfig,
  normalizePlaybackRacePatch,
  planFallbackSteps,
  raceFallbackCandidates,
  type FallbackAttempt,
  type FallbackCandidate,
  type PlaybackRaceConfig,
} from '../src/server/music/fastFallback'

const raceConfig = (overrides: Partial<PlaybackRaceConfig> = {}): PlaybackRaceConfig => ({
  ...DEFAULT_PLAYBACK_RACE,
  ...overrides,
})

const attempt = (key: string, rank: number): FallbackAttempt<string> => ({
  result: key,
  quality: String(rank),
  rank,
  key,
})

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const collect = async <T>(plan: AsyncGenerator<T>): Promise<T[]> => {
  const items: T[] = []
  for await (const item of plan) items.push(item)
  return items
}

const makePlan = (
  candidates: Array<FallbackCandidate<string>>,
): AsyncGenerator<FallbackCandidate<string>> => {
  return (async function* () {
    for (const candidate of candidates) yield candidate
  })()
}

test('playback race config normalization clamps and ignores missing fields', () => {
  assert.deepEqual(normalizePlaybackRacePatch({}), {})
  assert.deepEqual(normalizePlaybackRacePatch({
    'playback.fallback.maxConcurrency': 99,
    'playback.fallback.staggerMs': -5,
    'playback.fallback.probeTimeoutMs': '1800',
    'playback.fallback.deepProbeTimeoutMs': 1,
    'playback.fallback.successWaitMs': 99999,
  }), {
    maxConcurrency: 4,
    staggerMs: 0,
    probeTimeoutMs: 1800,
    deepProbeTimeoutMs: 500,
    successWaitMs: 5000,
  })
})

test('playback race config falls back to defaults and reads saved values', () => {
  const previous = (global as any).lx
  try {
    delete (global as any).lx
    assert.deepEqual(getPlaybackRaceConfig(), DEFAULT_PLAYBACK_RACE)

    ;(global as any).lx = {
      config: {
        'playback.fallback.maxConcurrency': 3,
        'playback.fallback.staggerMs': 1200,
        'playback.fallback.probeTimeoutMs': 1500,
        'playback.fallback.deepProbeTimeoutMs': 2500,
        'playback.fallback.successWaitMs': 600,
      },
    }
    assert.deepEqual(getPlaybackRaceConfig(), {
      maxConcurrency: 3,
      staggerMs: 1200,
      probeTimeoutMs: 1500,
      deepProbeTimeoutMs: 2500,
      successWaitMs: 600,
    })
  } finally {
    ;(global as any).lx = previous
  }
})

test('platform-first plan tries matches at current quality before lowering quality', async () => {
  const matches = ['wy', 'kw']
  const steps = await collect(planFallbackSteps(
    'origin',
    ['flac', '320k', '128k'],
    true,
    async () => matches,
  ))
  assert.deepEqual(steps, [
    { target: 'origin', quality: 'flac', switched: false },
    { target: 'wy', quality: 'flac', switched: true },
    { target: 'kw', quality: 'flac', switched: true },
    { target: 'origin', quality: '320k', switched: false },
    { target: 'wy', quality: '320k', switched: true },
    { target: 'kw', quality: '320k', switched: true },
    { target: 'origin', quality: '128k', switched: false },
    { target: 'wy', quality: '128k', switched: true },
    { target: 'kw', quality: '128k', switched: true },
  ])
})

test('quality-first plan lowers original quality before switching platforms', async () => {
  const steps = await collect(planFallbackSteps(
    'origin',
    ['flac', '320k'],
    false,
    async () => ['tx'],
  ))
  assert.deepEqual(steps, [
    { target: 'origin', quality: 'flac', switched: false },
    { target: 'origin', quality: '320k', switched: false },
    { target: 'tx', quality: 'flac', switched: true },
    { target: 'tx', quality: '320k', switched: true },
  ])
})

test('fast first success returns immediately without starting more candidates', async () => {
  const started: string[] = []
  const plan = makePlan([
    { key: 'a', run: async () => { started.push('a'); return attempt('a', 0) } },
    { key: 'b', run: async () => { started.push('b'); return attempt('b', 0) } },
  ])
  const startedAt = Date.now()
  const winner = await raceFallbackCandidates(plan, raceConfig({ staggerMs: 500, successWaitMs: 500 }))
  assert.equal(winner?.key, 'a')
  assert.deepEqual(started, ['a'])
  assert.ok(Date.now() - startedAt < 300)
})

test('failed candidate is replaced immediately instead of waiting the stagger interval', async () => {
  const started: string[] = []
  const plan = makePlan([
    { key: 'a', run: async () => { started.push('a'); return null } },
    { key: 'b', run: async () => { started.push('b'); return attempt('b', 0) } },
  ])
  const startedAt = Date.now()
  const winner = await raceFallbackCandidates(plan, raceConfig({ staggerMs: 2000, successWaitMs: 100 }))
  assert.equal(winner?.key, 'b')
  assert.deepEqual(started, ['a', 'b'])
  assert.ok(Date.now() - startedAt < 500)
})

test('staggered race waits for in-flight candidates and prefers the best quality', async () => {
  const started: string[] = []
  const plan = makePlan([
    {
      key: 'origin:flac',
      run: async () => {
        started.push('origin:flac')
        await delay(20)
        return attempt('origin:flac', 5)
      },
    },
    {
      key: 'switch:flac',
      run: async () => {
        started.push('switch:flac')
        await delay(20)
        return attempt('switch:flac', 1)
      },
    },
  ])
  const winner = await raceFallbackCandidates(plan, raceConfig({ maxConcurrency: 2, staggerMs: 5, successWaitMs: 300 }))
  assert.equal(winner?.key, 'switch:flac')
  assert.deepEqual(started, ['origin:flac', 'switch:flac'])
})

test('settle window keeps the first result when the in-flight candidate is not better', async () => {
  const plan = makePlan([
    { key: 'origin:flac', run: async () => { await delay(10); return attempt('origin:flac', 0) } },
    { key: 'switch:flac', run: async () => { await delay(300); return attempt('switch:flac', 4) } },
  ])
  const startedAt = Date.now()
  const winner = await raceFallbackCandidates(plan, raceConfig({ maxConcurrency: 2, staggerMs: 5, successWaitMs: 80 }))
  const elapsed = Date.now() - startedAt
  assert.equal(winner?.key, 'origin:flac')
  assert.ok(elapsed >= 70, `expected settle window to be awaited, got ${elapsed}ms`)
  assert.ok(elapsed < 250, `expected settle window to end before the slow candidate, got ${elapsed}ms`)
})

test('same quality keeps the earlier candidate', async () => {
  const plan = makePlan([
    { key: 'origin:flac', run: async () => { await delay(10); return attempt('origin:flac', 1) } },
    { key: 'switch:flac', run: async () => { await delay(10); return attempt('switch:flac', 1) } },
  ])
  const winner = await raceFallbackCandidates(plan, raceConfig({ maxConcurrency: 2, staggerMs: 5, successWaitMs: 80 }))
  assert.equal(winner?.key, 'origin:flac')
})

test('concurrency limit prevents starting more in-flight candidates than configured', async () => {
  let active = 0
  let maxActive = 0
  const makeCandidate = (key: string, delayMs: number, result: FallbackAttempt<string> | null): FallbackCandidate<string> => ({
    key,
    run: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(delayMs)
      active -= 1
      return result
    },
  })
  const plan = makePlan([
    makeCandidate('a', 30, null),
    makeCandidate('b', 30, attempt('b', 2)),
    makeCandidate('c', 5, attempt('c', 3)),
  ])
  const winner = await raceFallbackCandidates(plan, raceConfig({ maxConcurrency: 1, staggerMs: 0, successWaitMs: 20 }))
  assert.equal(winner?.key, 'b')
  assert.equal(maxActive, 1)
})

test('race returns null when every candidate fails', async () => {
  const plan = makePlan([
    { key: 'a', run: async () => null },
    { key: 'b', run: async () => null },
  ])
  const winner = await raceFallbackCandidates(plan, raceConfig({ maxConcurrency: 2, staggerMs: 0, successWaitMs: 20 }))
  assert.equal(winner, null)
})

test('rejected candidates are treated as failures and replaced', async () => {
  const plan = makePlan([
    { key: 'a', run: async () => { throw new Error('boom') } },
    { key: 'b', run: async () => attempt('b', 0) },
  ])
  const winner = await raceFallbackCandidates(plan, raceConfig({ maxConcurrency: 1, staggerMs: 0, successWaitMs: 20 }))
  assert.equal(winner?.key, 'b')
})
