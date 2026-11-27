import { checkCache, downloadAndCache } from '@/server/music/fileCache'
import { findLocalTrack, getLocalTracks, localFile, localMusic, type LocalTrack } from '@/server/music/subsonicLocal'
import { getDownloadQualityCandidates, getQualityRank } from '@/server/music/downloadQuality'
import { readUserPlaybackFallback, openLibraryUser, parseSongIntervalSeconds } from '@/server/music/playbackFallback'
import { getPlaybackRaceConfig, planFallbackSteps, raceFallbackCandidates, type FallbackAttempt, type FallbackCandidate, type PlaybackRaceConfig } from '@/server/music/fastFallback'
import { findSourceMatches, pickSwitchCandidates } from '@/server/music/sourceMatch'
import { callUserApiGetMusicUrl, isSourceSupported } from '@/server/sources/userApi'
import musicSdkRaw from '@/modules/utils/musicSdk/index.js'
import { miotLog } from './log'
import { inspectRemoteUrl } from './reachability'
import type { MiotSong } from './types'

const musicSdk = musicSdkRaw as any

export type MiotStreamKind = 'local' | 'cache' | 'remote'

export interface ResolvedSongSource {
  kind: MiotStreamKind
  quality: string
  localTrack?: LocalTrack
  filename?: string
  folder?: 'cache' | 'music'
  remoteUrl?: string
  /** 探测到的真实音频时长（秒），仅在线源且能解析容器头时提供 */
  durationSeconds?: number | null
}

const cachedSourceOf = (song: MiotSong, username: string, fallbackQuality: string): ResolvedSongSource | null => {
  // 用本次请求音质做“同名同歌手”判定：同音质命中即视为已存在；音质不同则走在线解析并按升级流程下载。
  const cached = checkCache({ ...song, quality: fallbackQuality || song.quality }, username || undefined)
  if (!cached.exists || !cached.filename) return null
  return {
    kind: 'cache',
    quality: cached.quality || fallbackQuality,
    filename: cached.filename,
    folder: cached.folder as 'cache' | 'music',
  }
}

/** 单平台单音质在线解析：同平台多自定义源轮询由 callUserApiGetMusicUrl 处理，最后做可达性/试听探测。 */
const resolveFromSource = async (
  song: MiotSong,
  username: string,
  quality: string,
  expectedSeconds: number,
  race: PlaybackRaceConfig,
): Promise<ResolvedSongSource | null> => {
  const source = song.source
  if (!source || source === 'local') return null
  if (!isSourceSupported(source, username || undefined)) {
    miotLog.warn(`[MIoT] source "${source}" 没有可用的自定义源，无法为 "${song.name}" 取播放链接`)
    return null
  }
  try {
    const result = await callUserApiGetMusicUrl(source, song, quality, username || undefined, undefined, true)
    if (!result?.url) return null
    const remoteUrl = result.url.trim()
    const inspection = await inspectRemoteUrl(remoteUrl, expectedSeconds, race.probeTimeoutMs, race.deepProbeTimeoutMs)
    if (inspection.verdict !== 'ok') {
      const size = formatSize(inspection.totalBytes)
      const reason = inspection.verdict === 'trial'
        ? `疑似试听（实际时长约 ${Math.max(1, Math.round(inspection.durationSeconds || 0))}s，${size}）`
        : inspection.verdict === 'invalid'
          ? `返回内容不是音频（${inspection.contentType || '未知类型'}，${size}）`
          : '不可达'
      miotLog.warn(`[MIoT] resolve "${song.name}" source=${source} quality=${quality} 返回的链接${reason}，继续降级/换源`)
      return null
    }
    if (inspection.durationSeconds != null && expectedSeconds >= 30 && inspection.durationSeconds < expectedSeconds * 0.6) {
      miotLog.info(`[MIoT] resolve "${song.name}" source=${source} quality=${quality} 实际时长约 ${Math.round(inspection.durationSeconds)}s，短于标注 ${expectedSeconds}s，仍尝试播放`)
    }
    return {
      kind: 'remote',
      quality: result.type || quality,
      remoteUrl,
      durationSeconds: inspection.durationSeconds,
    }
  } catch (err: any) {
    miotLog.warn(`[MIoT] resolve "${song.name}" source=${source} quality=${quality} failed: ${err?.message || err}`)
    return null
  }
}

const trySongAtQuality = async (
  song: MiotSong,
  username: string,
  quality: string,
  fallbackSeconds: number,
  race: PlaybackRaceConfig,
): Promise<ResolvedSongSource | null> => {
  const cached = cachedSourceOf(song, username, quality)
  if (cached) return cached
  return resolveFromSource(song, username, quality, parseSongIntervalSeconds(song.interval) || fallbackSeconds, race)
}

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes > 0) return `${Math.max(1, Math.round(bytes / 1024))}KB`
  return '大小未知'
}

export const resolveSongSource = async (song: MiotSong, username: string, quality: string): Promise<ResolvedSongSource | null> => {
  if (!song) return null
  const songId = String(song.id || '')

  if (songId.startsWith('local_')) {
    const embedded = song.meta?.localTrack as LocalTrack | undefined
    if (embedded && localFile(embedded)) {
      return { kind: 'local', quality: 'local', localTrack: embedded }
    }
    const track = await findLocalTrack(openLibraryUser(username), songId)
    return track ? { kind: 'local', quality: 'local', localTrack: track } : null
  }

  // 音源搜索结果的站内 ID 常在 songmid/songId 上，没有统一的 id 字段。
  if (!songId && !song.songmid && !song.songId) return null

  // 请求音质已有缓存时直接播放，避免为命中缓存的歌曲白跑一次跨平台匹配搜索
  const cached = cachedSourceOf(song, username, quality)
  if (cached) return cached

  const config = readUserPlaybackFallback(username)
  const race = getPlaybackRaceConfig()
  const qualities = config.degradeQuality ? getDownloadQualityCandidates(quality) : [quality]
  const expectedSeconds = parseSongIntervalSeconds(song.interval)

  // 匹配搜索与首路解析同时启动：竞速轮到换源候选时通常已拿到结果，不再等原平台失败后才开始搜索
  const matchesTask: Promise<MiotSong[]> | null = config.switchPlatform
    ? findSourceMatches(song, username).then(pickSwitchCandidates).catch(() => [])
    : null
  let matchesLogged = false
  const getMatches = async (): Promise<MiotSong[]> => {
    if (!matchesTask) return []
    const matches = await matchesTask
    if (matches.length > 0 && !matchesLogged) {
      matchesLogged = true
      miotLog.info(`[MIoT] "${song.name}" 换源候选（${matches.map(item => `${item.source}/${item.singer}`).join('，')}）`)
    }
    return matches
  }

  const plan = async function* (): AsyncGenerator<FallbackCandidate<ResolvedSongSource>> {
    for await (const step of planFallbackSteps(song, qualities, config.platformFirst, getMatches)) {
      const kind = step.switched ? 'switch' : 'origin'
      const key = `${kind}:${step.target.source || 'unknown'}:${step.quality}`
      yield {
        key,
        run: async (): Promise<FallbackAttempt<ResolvedSongSource> | null> => {
          const hit = await trySongAtQuality(step.target, username, step.quality, expectedSeconds, race)
          if (!hit) return null
          return { result: hit, quality: hit.quality, rank: getQualityRank(hit.quality), key }
        },
      }
    }
  }

  const winner = await raceFallbackCandidates(plan(), race)
  if (!winner) return null
  if (winner.key?.startsWith('switch:')) {
    miotLog.info(`[MIoT] 换源播放 "${song.name}" ${song.source || '未知'} -> ${winner.key.split(':')[1]} (${winner.quality})`)
  } else if (winner.quality !== quality) {
    miotLog.info(`[MIoT] 降质播放 "${song.name}" ${quality} -> ${winner.quality}`)
  }
  return winner.result
}

const WARM_FAIL_COOLDOWN_MS = 10 * 60 * 1000
const warmFailures = new Map<string, number>()

const warmFailureKey = (song: MiotSong, quality: string): string =>
  `${song.source || ''}\u0000${song.songmid || song.id || ''}\u0000${song.name || ''}\u0000${song.singer || ''}\u0000${quality}`

/** 上游失效时避免每次拉流都重复触发同一个必然失败的下载（例如整张歌单 522）。 */
const warmAllowed = (song: MiotSong, quality: string): boolean => {
  const at = warmFailures.get(warmFailureKey(song, quality))
  return !at || Date.now() - at >= WARM_FAIL_COOLDOWN_MS
}

const noteWarmFailure = (song: MiotSong, quality: string): void => {
  if (warmFailures.size > 500) {
    const cutoff = Date.now() - WARM_FAIL_COOLDOWN_MS
    for (const [key, at] of warmFailures) if (at < cutoff) warmFailures.delete(key)
  }
  warmFailures.set(warmFailureKey(song, quality), Date.now())
}

export const warmSongCache = (song: MiotSong, username: string, resolved: ResolvedSongSource): void => {
  if (resolved.kind !== 'remote' || !resolved.remoteUrl) return
  if (!warmAllowed(song, resolved.quality)) return
  void downloadAndCache(song, resolved.remoteUrl, resolved.quality, username || undefined)
    .then(() => {
      warmFailures.delete(warmFailureKey(song, resolved.quality))
      miotLog.info(`[MIoT] 已缓存 "${song.name}" (${resolved.quality})`)
    })
    .catch((err: any) => {
      noteWarmFailure(song, resolved.quality)
      miotLog.warn(`[MIoT] 缓存 "${song.name}" 失败: ${err?.message || err}`)
    })
}

/** VIP 自动下载：直接落到用户下载目录（音乐库），之后再播优先命中本地。歌单旧数据没有 vip 字段时也走这里。 */
export const warmVipDownload = (song: MiotSong, username: string, resolved: ResolvedSongSource): void => {
  if (resolved.kind !== 'remote' || !resolved.remoteUrl) return
  if (!warmAllowed(song, resolved.quality)) return
  const label = song.vip ? 'VIP 歌曲' : '未标记 VIP 歌曲'
  void downloadAndCache(song, resolved.remoteUrl, resolved.quality, username || undefined, undefined, true)
    .then(() => {
      warmFailures.delete(warmFailureKey(song, resolved.quality))
      miotLog.info(`[MIoT] ${label}已下载到本地 "${song.name}" (${resolved.quality})`)
    })
    .catch((err: any) => {
      noteWarmFailure(song, resolved.quality)
      miotLog.warn(`[MIoT] ${label}下载 "${song.name}" 失败: ${err?.message || err}`)
    })
}

const normalizeText = (value: unknown): string => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

const tokenize = (value: unknown): string[] => String(value ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

const compactKey = (value: unknown): string => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

const formatDuration = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds || 0))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

const scoreLocalTrack = (track: LocalTrack, tokens: string[], query: string): number => {
  const title = normalizeText(track.title)
  const artist = normalizeText(track.artist)
  const album = normalizeText(track.album)
  const haystack = `${title} ${artist} ${album}`
  if (!tokens.every(token => haystack.includes(token))) return 0
  let score = tokens.length * 10
  if (title === query) score += 1000
  else if (title.startsWith(query)) score += 400
  else if (title.includes(query)) score += 250
  else if (tokens.every(token => title.includes(token))) score += 150
  if (artist === query) score += 300
  else if (artist.includes(query)) score += 120
  if (album === query) score += 80
  else if (album.includes(query)) score += 40
  return score
}

/** 本地优先：标题/歌手/专辑全部关键词命中才计入，按精确度排序。 */
const searchLocalSongs = async (username: string, keyword: string, limit: number): Promise<MiotSong[]> => {
  if (limit <= 0) return []
  const tokens = tokenize(keyword)
  if (!tokens.length) return []
  try {
    const tracks = await getLocalTracks(openLibraryUser(username))
    const query = normalizeText(keyword)
    const matches: Array<{ track: LocalTrack; score: number }> = []
    for (const track of tracks) {
      const score = scoreLocalTrack(track, tokens, query)
      if (score > 0) matches.push({ track, score })
    }
    matches.sort((a, b) => b.score - a.score || a.track.title.localeCompare(b.track.title))
    return matches.slice(0, limit).map(({ track }) => ({
      ...(localMusic(track) as MiotSong),
      interval: formatDuration(track.duration),
      vip: false,
    }))
  } catch (err: any) {
    miotLog.warn(`[MIoT] 本地搜索 "${keyword}" 失败: ${err?.message || err}`)
    return []
  }
}

/** 随机听歌：优先从本地曲库抽取；带关键词时按类型/标题/歌手/专辑过滤。 */
export const pickRandomLocalSongs = async (username: string, limit: number, keyword = ''): Promise<MiotSong[]> => {
  if (limit <= 0) return []
  try {
    const tracks = await getLocalTracks(openLibraryUser(username))
    const key = keyword.trim().toLowerCase()
    const pool = key
      ? tracks.filter(track => `${track.genre || ''} ${track.title || ''} ${track.artist || ''} ${track.album || ''}`.toLowerCase().includes(key))
      : tracks
    if (pool.length === 0) return []
    const copy = [...pool]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const temp = copy[i]
      copy[i] = copy[j]
      copy[j] = temp
    }
    return copy.slice(0, limit).map(track => ({
      ...(localMusic(track) as MiotSong),
      interval: formatDuration(track.duration),
      vip: false,
    }))
  } catch (err: any) {
    miotLog.warn(`[MIoT] 本地随机取歌失败: ${err?.message || err}`)
    return []
  }
}

export const searchSongs = async (keyword: string, username: string, limit = 10): Promise<MiotSong[]> => {
  const query = keyword.trim()
  if (!query) return []
  const local = await searchLocalSongs(username, query, limit)
  const merged: MiotSong[] = [...local]
  const seen = new Set(local.map(song => `${compactKey(song.name)}|${compactKey(song.singer)}`))
  for (const source of ['wy', 'tx', 'kw', 'kg', 'mg']) {
    if (merged.length >= limit) break
    if (!isSourceSupported(source, username || undefined)) continue
    try {
      const result = await musicSdk[source]?.musicSearch?.search(query, 1, limit)
      const list: MiotSong[] = Array.isArray(result) ? result : (result?.list ?? [])
      let added = 0
      for (const song of list) {
        if (merged.length >= limit) break
        const key = `${compactKey(song.name)}|${compactKey(song.singer)}`
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(song)
        added += 1
      }
      if (added > 0) break
    } catch (err: any) {
      miotLog.warn(`[MIoT] search "${query}" on ${source} failed: ${err?.message || err}`)
    }
  }
  return merged
}
