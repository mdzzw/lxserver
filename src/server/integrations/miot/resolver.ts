import { checkCache, downloadAndCache } from '@/server/music/fileCache'
import { findLocalTrack, getLocalTracks, localFile, localMusic, type LocalTrack } from '@/server/music/subsonicLocal'
import { getDownloadQualityCandidates } from '@/server/music/downloadQuality'
import { findSourceMatches } from '@/server/music/sourceMatch'
import { callUserApiGetMusicUrl, isSourceSupported } from '@/server/sources/userApi'
import musicSdkRaw from '@/modules/utils/musicSdk/index.js'
import { miotLog } from './log'
import type { MiotSong } from './types'

const musicSdk = musicSdkRaw as any

const MAX_SWITCH_MATCHES = 4

/** 每个平台只取匹配度最高的版本，避免原版失败时误播伴奏/DJ 版。 */
const pickSwitchCandidates = (matches: any[]): MiotSong[] => {
  const picked: MiotSong[] = []
  const seenSources = new Set<string>()
  for (const match of matches) {
    const source = String(match?.source || '')
    if (!source || seenSources.has(source)) continue
    seenSources.add(source)
    picked.push(match)
    if (picked.length >= MAX_SWITCH_MATCHES) break
  }
  return picked
}

export type MiotStreamKind = 'local' | 'cache' | 'remote'

export interface ResolvedSongSource {
  kind: MiotStreamKind
  quality: string
  localTrack?: LocalTrack
  filename?: string
  folder?: 'cache' | 'music'
  remoteUrl?: string
}

export const openLibraryUser = (username: string): string => username && username !== 'default' ? username : '_open'

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

/** 同一平台内：多自定义源轮询（callUserApiGetMusicUrl 内部处理）+ 逐级降音质。 */
const resolveFromSource = async (song: MiotSong, username: string, quality: string): Promise<ResolvedSongSource | null> => {
  const source = song.source
  if (!source || source === 'local') return null
  if (!isSourceSupported(source, username || undefined)) {
    miotLog.warn(`[MIoT] source "${source}" 没有可用的自定义源，无法为 "${song.name}" 取播放链接`)
    return null
  }
  for (const candidate of getDownloadQualityCandidates(quality)) {
    try {
      const result = await callUserApiGetMusicUrl(source, song, candidate, username || undefined, undefined, true)
      if (result?.url) {
        return {
          kind: 'remote',
          quality: result.type || candidate,
          remoteUrl: result.url.trim(),
        }
      }
    } catch (err: any) {
      miotLog.warn(`[MIoT] resolve "${song.name}" source=${source} quality=${candidate} failed: ${err?.message || err}`)
    }
  }
  return null
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

  const cached = cachedSourceOf(song, username, quality)
  if (cached) return cached

  const direct = await resolveFromSource(song, username, quality)
  if (direct) return direct

  // 原平台不可用或全音质解析失败：跨平台匹配同曲后再试，全部失败才交给播放器删除。
  const candidates = pickSwitchCandidates(await findSourceMatches(song, username))
  if (candidates.length === 0) return null
  miotLog.info(`[MIoT] "${song.name}" 原平台 ${song.source || '未知'} 无法播放，尝试跨平台换源（${candidates.map(item => item.source).join('/')}）`)

  for (const match of candidates) {
    const hit = cachedSourceOf(match, username, quality)
    if (hit) {
      miotLog.info(`[MIoT] 换源命中本地 (${hit.kind}) "${song.name}" ${song.source || '未知'} -> ${match.source}`)
      return hit
    }
    const resolved = await resolveFromSource(match, username, quality)
    if (resolved) {
      miotLog.info(`[MIoT] 换源播放 "${song.name}" ${song.source || '未知'} -> ${match.source}/${match.singer} (${resolved.quality})`)
      return resolved
    }
  }
  return null
}

export const warmSongCache = (song: MiotSong, username: string, resolved: ResolvedSongSource): void => {
  if (resolved.kind !== 'remote' || !resolved.remoteUrl) return
  void downloadAndCache(song, resolved.remoteUrl, resolved.quality, username || undefined)
    .then(() => miotLog.info(`[MIoT] 已缓存 "${song.name}" (${resolved.quality})`))
    .catch((err: any) => miotLog.warn(`[MIoT] 缓存 "${song.name}" 失败: ${err?.message || err}`))
}

/** VIP 自动下载：直接落到用户下载目录（音乐库），之后再播优先命中本地。歌单旧数据没有 vip 字段时也走这里。 */
export const warmVipDownload = (song: MiotSong, username: string, resolved: ResolvedSongSource): void => {
  if (resolved.kind !== 'remote' || !resolved.remoteUrl) return
  const label = song.vip ? 'VIP 歌曲' : '未标记 VIP 歌曲'
  void downloadAndCache(song, resolved.remoteUrl, resolved.quality, username || undefined, undefined, true)
    .then(() => miotLog.info(`[MIoT] ${label}已下载到本地 "${song.name}" (${resolved.quality})`))
    .catch((err: any) => miotLog.warn(`[MIoT] ${label}下载 "${song.name}" 失败: ${err?.message || err}`))
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
