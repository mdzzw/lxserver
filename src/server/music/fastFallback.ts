export interface PlaybackRaceConfig {
  maxConcurrency: number
  staggerMs: number
  probeTimeoutMs: number
  deepProbeTimeoutMs: number
  successWaitMs: number
}

export const DEFAULT_PLAYBACK_RACE: PlaybackRaceConfig = {
  maxConcurrency: 2,
  staggerMs: 700,
  probeTimeoutMs: 2000,
  deepProbeTimeoutMs: 3000,
  successWaitMs: 400,
}

export const PLAYBACK_RACE_CONFIG_KEYS: Record<keyof PlaybackRaceConfig, string> = {
  maxConcurrency: 'playback.fallback.maxConcurrency',
  staggerMs: 'playback.fallback.staggerMs',
  probeTimeoutMs: 'playback.fallback.probeTimeoutMs',
  deepProbeTimeoutMs: 'playback.fallback.deepProbeTimeoutMs',
  successWaitMs: 'playback.fallback.successWaitMs',
}

const RACE_LIMITS: Record<keyof PlaybackRaceConfig, { min: number, max: number }> = {
  maxConcurrency: { min: 1, max: 4 },
  staggerMs: { min: 0, max: 10000 },
  probeTimeoutMs: { min: 500, max: 15000 },
  deepProbeTimeoutMs: { min: 500, max: 20000 },
  successWaitMs: { min: 0, max: 5000 },
}

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.round(numeric)))
}

/** 只返回本次实际提交的配置项，避免保存其它表单时把缺省值写回。 */
export const normalizePlaybackRacePatch = (patch: Record<string, unknown>): Partial<PlaybackRaceConfig> => {
  const result: Partial<PlaybackRaceConfig> = {}
  for (const field of Object.keys(PLAYBACK_RACE_CONFIG_KEYS) as Array<keyof PlaybackRaceConfig>) {
    const key = PLAYBACK_RACE_CONFIG_KEYS[field]
    if (patch[key] === undefined) continue
    const limits = RACE_LIMITS[field]
    result[field] = clampInt(patch[key], limits.min, limits.max, DEFAULT_PLAYBACK_RACE[field])
  }
  return result
}

export const getPlaybackRaceConfig = (): PlaybackRaceConfig => {
  const saved = ((global as any).lx?.config ?? {}) as Record<string, unknown>
  const read = (field: keyof PlaybackRaceConfig): number => {
    const limits = RACE_LIMITS[field]
    return clampInt(saved[PLAYBACK_RACE_CONFIG_KEYS[field]], limits.min, limits.max, DEFAULT_PLAYBACK_RACE[field])
  }
  return {
    maxConcurrency: read('maxConcurrency'),
    staggerMs: read('staggerMs'),
    probeTimeoutMs: read('probeTimeoutMs'),
    deepProbeTimeoutMs: read('deepProbeTimeoutMs'),
    successWaitMs: read('successWaitMs'),
  }
}

export interface FallbackAttempt<T> {
  result: T
  quality: string
  /** 音质排名，越小越好；由调用方按实际返回音质计算 */
  rank: number
  key?: string
}

export interface FallbackCandidate<T> {
  key: string
  run: () => Promise<FallbackAttempt<T> | null>
}

export interface FallbackStep<T> {
  target: T
  quality: string
  /** true 表示跨平台换源候选，false 表示原曲候选 */
  switched: boolean
}

/**
 * 按落雪用户优先级生成候选顺序，小爱与网页共用同一套规则：
 * - platformFirst：同一音质先原平台、再各换源平台，该音质全部失败后才降一档；
 * - qualityFirst：原平台逐档降品，全部失败后再换源（备选平台同样从请求音质起逐档兜底）。
 * qualities[0] 必须是请求音质；换源结果在轮到换源候选时才拉取，便于调用方提前并行搜索。
 */
export const planFallbackSteps = async function* <T>(
  original: T,
  qualities: readonly string[],
  platformFirst: boolean,
  getMatches: () => Promise<T[]>,
): AsyncGenerator<FallbackStep<T>> {
  yield { target: original, quality: qualities[0], switched: false }
  if (platformFirst) {
    for (let qualityIndex = 0; qualityIndex < qualities.length; qualityIndex++) {
      if (qualityIndex > 0) yield { target: original, quality: qualities[qualityIndex], switched: false }
      for (const match of await getMatches()) {
        yield { target: match, quality: qualities[qualityIndex], switched: true }
      }
    }
    return
  }
  for (const quality of qualities.slice(1)) yield { target: original, quality, switched: false }
  for (const quality of qualities) {
    for (const match of await getMatches()) {
      yield { target: match, quality, switched: true }
    }
  }
}

/**
 * 错峰多路竞速：按候选顺序逐个启动，最多 maxConcurrency 路同时在途。
 * 首个候选立即启动，其余在 staggerMs 后或前一路失败时补位；
 * 一旦有候选探测通过就停止启动新路，仅在还有其它在途候选时等待 successWaitMs，
 * 窗口结束后返回音质排名最高的结果（同排名保留先启动的候选）。
 */
export const raceFallbackCandidates = async <T>(
  plan: AsyncGenerator<FallbackCandidate<T>>,
  config: PlaybackRaceConfig,
): Promise<FallbackAttempt<T> | null> => {
  return new Promise<FallbackAttempt<T> | null>(resolve => {
    let active = 0
    let winner: FallbackAttempt<T> | null = null
    let finished = false
    let exhausted = false
    let pulling = false
    let staggerTimer: ReturnType<typeof setTimeout> | null = null
    let settleTimer: ReturnType<typeof setTimeout> | null = null

    const clearStagger = () => {
      if (!staggerTimer) return
      clearTimeout(staggerTimer)
      staggerTimer = null
    }

    const finish = (attempt: FallbackAttempt<T> | null) => {
      if (finished) return
      finished = true
      clearStagger()
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
      try {
        void plan.return(undefined as never)
      } catch {
        // 生成器已结束
      }
      resolve(attempt)
    }

    const maybeFinish = () => {
      if (finished) return
      if (winner && active === 0) {
        finish(winner)
        return
      }
      if (!winner && active === 0 && exhausted) finish(null)
    }

    const armSettle = () => {
      if (settleTimer || finished) return
      settleTimer = setTimeout(() => {
        settleTimer = null
        if (winner) finish(winner)
      }, config.successWaitMs)
    }

    const pullNext = async (): Promise<FallbackCandidate<T> | null> => {
      if (pulling || exhausted || finished) return null
      pulling = true
      try {
        const next = await plan.next()
        if (next.done) {
          exhausted = true
          return null
        }
        return next.value ?? null
      } catch {
        exhausted = true
        return null
      } finally {
        pulling = false
      }
    }

    const startNext = async (): Promise<void> => {
      if (finished || winner || active >= config.maxConcurrency) return
      clearStagger()
      const candidate = await pullNext()
      if (finished || winner) return
      if (!candidate) {
        maybeFinish()
        return
      }
      runCandidate(candidate)
      armStagger()
    }

    const runCandidate = (candidate: FallbackCandidate<T>): void => {
      active++
      void Promise.resolve()
        .then(() => candidate.run())
        .then(attempt => {
          active--
          if (finished) return
          if (attempt) {
            const hadWinner = !!winner
            // 排名相同保留先启动的候选，避免同音质下被后续平台顶掉策略顺序
            if (!winner || attempt.rank < winner.rank) {
              winner = { ...attempt, key: attempt.key || candidate.key }
            }
            if (!hadWinner && active > 0) armSettle()
          } else if (!winner) {
            clearStagger()
            void startNext()
          }
          maybeFinish()
        })
        .catch(() => {
          active--
          if (finished) return
          if (!winner) {
            clearStagger()
            void startNext()
          }
          maybeFinish()
        })
    }

    const armStagger = (): void => {
      if (finished || winner || staggerTimer) return
      staggerTimer = setTimeout(() => {
        staggerTimer = null
        void startNext()
      }, config.staggerMs)
    }

    void startNext()
  })
}
