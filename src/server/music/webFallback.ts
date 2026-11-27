import { inspectRemoteUrl } from '@/server/integrations/miot/reachability'
import { callUserApiGetMusicUrl, isSourceSupported } from '@/server/sources/userApi'
import { getDownloadQualityCandidates, getQualityRank } from './downloadQuality'
import { getPlaybackRaceConfig, planFallbackSteps, raceFallbackCandidates, type FallbackAttempt, type FallbackCandidate } from './fastFallback'
import { parseSongIntervalSeconds, readUserPlaybackFallback } from './playbackFallback'
import { findSourceMatches, pickSwitchCandidates } from './sourceMatch'

export interface WebSongSourceResult {
  url: string
  type: string
  sourceName?: string
  sourceId?: string
  hasMoreSources?: boolean
  attempts?: any[]
}

export interface WebSongSourceOutcome {
  result: WebSongSourceResult
  /** 实际播放的平台：原平台失败时可能已换源 */
  source: string
  attempts: any[]
}

/**
 * 落雪网页端播放兜底：与小爱共用落雪用户设置（换源/降品开关与优先级）和后台竞速配置。
 * 首路解析的同时并行发起跨平台匹配搜索，按错峰竞速择优返回音质最高的可用链接。
 */
export const resolveWebSongSource = async (
  songInfo: any,
  requestedQuality: string,
  username: string,
  enableAutoSwitchApiSource: boolean,
  excludeApiSources?: string[],
): Promise<WebSongSourceOutcome> => {
  const config = readUserPlaybackFallback(username)
  const race = getPlaybackRaceConfig()
  const qualities = config.degradeQuality ? getDownloadQualityCandidates(requestedQuality) : [requestedQuality]
  const expectedSeconds = parseSongIntervalSeconds(songInfo.interval)

  // 匹配搜索与首路解析同时启动：竞速轮到换源候选时通常已拿到结果
  const matchesTask: Promise<any[]> | null = config.switchPlatform
    ? findSourceMatches(songInfo, username).then(pickSwitchCandidates).catch(() => [])
    : null
  const attempts: any[] = []
  let firstError: any = null

  const getMatches = async (): Promise<any[]> => matchesTask ? matchesTask : []

  const plan = async function* (): AsyncGenerator<FallbackCandidate<WebSongSourceResult>> {
    for await (const step of planFallbackSteps(songInfo, qualities, config.platformFirst, getMatches)) {
      const source = String(step.target?.source || '')
      if (!source || !isSourceSupported(source, username)) continue
      const key = `${source}:${step.quality}`
      yield {
        key,
        run: async (): Promise<FallbackAttempt<WebSongSourceResult> | null> => {
          try {
            const result = await callUserApiGetMusicUrl(
              source,
              step.target,
              step.quality,
              username,
              undefined,
              enableAutoSwitchApiSource,
              step.switched ? undefined : excludeApiSources,
            )
            if (!result?.url) return null
            const inspection = await inspectRemoteUrl(
              result.url,
              parseSongIntervalSeconds(step.target.interval) || expectedSeconds,
              race.probeTimeoutMs,
              race.deepProbeTimeoutMs,
            )
            const actualQuality = result.type || step.quality
            if (inspection.verdict !== 'ok') {
              const reason = inspection.verdict === 'trial'
                ? '疑似试听片段'
                : inspection.verdict === 'invalid'
                  ? '返回内容不是音频'
                  : '链接不可达'
              attempts.push({ name: result.sourceName || source, status: 'fail', message: `${reason}（${step.quality}）` })
              return null
            }
            attempts.push(...(result.attempts || []))
            return {
              result: { ...result, type: actualQuality },
              quality: actualQuality,
              rank: getQualityRank(actualQuality),
              key,
            }
          } catch (err: any) {
            if (Array.isArray(err?.attempts) && err.attempts.length > 0) attempts.push(...err.attempts)
            else attempts.push({ name: source, status: 'fail', message: err?.message || '解析失败' })
            if (!step.switched && !firstError) firstError = err
            return null
          }
        },
      }
    }
  }

  const winner = await raceFallbackCandidates(plan(), race)
  if (!winner) {
    const err: any = firstError || new Error('所有候选音源均无法播放')
    err.attempts = attempts
    throw err
  }
  return {
    result: { ...winner.result, attempts },
    source: winner.key?.split(':')[0] || songInfo.source,
    attempts,
  }
}
