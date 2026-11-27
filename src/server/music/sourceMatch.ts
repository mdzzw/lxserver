import musicSdkRaw from '@/modules/utils/musicSdk/index.js'
import { isSourceSupported } from '@/server/sources/userApi'

const musicSdk = musicSdkRaw as any

const AUTO_SOURCE_ORDER = ['wy', 'tx', 'kw', 'kg', 'mg']
const SOURCE_MATCH_CACHE_TTL = 60_000
const sourceMatchCache = new Map<string, { expiresAt: number, promise: Promise<any[]> }>()

const normalizeSongMatchText = (value: unknown) => String(value || '')
  .toLowerCase()
  .replace(/[（(\[].*?[）)\]]/g, '')
  .replace(/[\s\p{P}\p{S}]/gu, '')

const normalizeSongNameText = (value: unknown) => String(value || '')
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]/gu, '')

const splitSingerNames = (value: unknown) => String(value || '')
  .toLowerCase()
  .split(/[、，,&；;|/+]/)
  .map(normalizeSongMatchText)
  .filter(Boolean)

const isSingerMatch = (candidateSinger: unknown, targetSinger: unknown) => {
  const candidateText = normalizeSongMatchText(candidateSinger)
  const targetText = normalizeSongMatchText(targetSinger)
  if (!targetText) return true
  if (!candidateText) return false
  if (candidateText.includes(targetText) || targetText.includes(candidateText)) return true

  const candidateParts = splitSingerNames(candidateSinger)
  const targetParts = splitSingerNames(targetSinger)
  return candidateParts.some(candidatePart => targetParts.some(targetPart => (
    candidatePart.includes(targetPart) || targetPart.includes(candidatePart)
  )))
}

const getSongDurationSeconds = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10000 ? Math.round(value / 1000) : Math.round(value)
  }

  const text = String(value || '').trim()
  if (!text) return 0
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const parsed = Number(text)
    return parsed > 10000 ? Math.round(parsed / 1000) : Math.round(parsed)
  }

  const parts = text.split(':').map(Number)
  if (parts.some(part => !Number.isFinite(part))) return 0
  if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1])
  if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2])
  return 0
}

const getSongMatchScore = (candidate: any, target: any) => {
  const candidateName = normalizeSongNameText(candidate?.name)
  const targetName = normalizeSongNameText(target?.name)
  if (!candidateName || !targetName) return -1
  if (!candidateName.includes(targetName) && !targetName.includes(candidateName)) return -1
  if (!isSingerMatch(candidate?.singer, target?.singer)) return -1

  const candidateDuration = getSongDurationSeconds(candidate?.interval)
  const targetDuration = getSongDurationSeconds(target?.interval)
  let durationScore = 0
  if (candidateDuration > 0 && targetDuration > 0) {
    const durationDiff = Math.abs(candidateDuration - targetDuration)
    if (durationDiff > 8) return -1
    durationScore = 8 - durationDiff
  }

  const nameScore = candidateName === targetName ? 20 : 10
  const candidateAlbum = normalizeSongMatchText(candidate?.albumName)
  const targetAlbum = normalizeSongMatchText(target?.albumName)
  const albumScore = candidateAlbum && targetAlbum && candidateAlbum === targetAlbum ? 3 : 0
  return nameScore + durationScore + albumScore
}

const MAX_SWITCH_MATCHES = 4

/** 每个平台只取匹配度最高的版本，避免原版失败时误播伴奏/DJ 版。 */
export const pickSwitchCandidates = <T extends { source?: string }>(matches: T[]): T[] => {
  const picked: T[] = []
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

/**
 * 跨平台同曲匹配：只搜索当前用户已加载自定义源的平台，按标题/歌手/时长严格过滤后按匹配度排序。
 * 结果缓存 60 秒，避免播放失败连续跳过时对同一首歌重复搜索。
 */
export const findSourceMatches = async (songInfo: any, username: string): Promise<any[]> => {
  if (!songInfo?.name || !songInfo?.singer) return []

  const cacheKey = [
    username,
    songInfo.source,
    normalizeSongMatchText(songInfo.name),
    normalizeSongMatchText(songInfo.singer),
    getSongDurationSeconds(songInfo.interval),
  ].join(':')
  const now = Date.now()
  const cached = sourceMatchCache.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.promise

  for (const [key, value] of sourceMatchCache) {
    if (value.expiresAt <= now) sourceMatchCache.delete(key)
  }

  const searchSources = AUTO_SOURCE_ORDER.filter(source => (
    source !== songInfo.source && isSourceSupported(source, username) && musicSdk[source]?.musicSearch?.search
  ))
  const query = `${songInfo.name} ${songInfo.singer}`
  const promise = Promise.all(searchSources.map(async source => {
    try {
      const searchData = await musicSdk[source].musicSearch.search(query, 1, 20)
      const list = Array.isArray(searchData?.list) ? searchData.list : []
      return list.map((item: any) => ({ ...item, source }))
    } catch (err: any) {
      console.warn(`[自动换源] 搜索 ${source} 失败: ${err?.message || err}`)
      return []
    }
  })).then(resultGroups => resultGroups.flat()
    .map(candidate => ({ candidate, score: getSongMatchScore(candidate, songInfo) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.candidate))

  sourceMatchCache.set(cacheKey, { expiresAt: now + SOURCE_MATCH_CACHE_TTL, promise })
  return promise
}
