import musicSdkRaw from '@/modules/utils/musicSdk/index.js'
import { isSourceSupported } from '@/server/sources/userApi'
import { miotLog } from './log'
import type { MiotSong } from './types'

const musicSdk = musicSdkRaw as any

const PLAYLIST_SOURCE_ORDER = ['wy', 'tx', 'kg', 'kw', 'mg']
const CHART_SOURCE_ORDER = ['kg', 'tx', 'kw', 'wy', 'mg']
const PLAYLIST_SEARCH_LIMIT = 10

const PLATFORM_PREFIXES: Array<{ re: RegExp; source: string }> = [
  { re: /^(?:网易云音乐|网易云|网易|wy)/i, source: 'wy' },
  { re: /^(?:qq音乐|qq|腾讯音乐|腾讯|tx)/i, source: 'tx' },
  { re: /^(?:酷狗音乐|酷狗|kg)/i, source: 'kg' },
  { re: /^(?:酷我音乐|酷我|kw)/i, source: 'kw' },
  { re: /^(?:咪咕音乐|咪咕|mg)/i, source: 'mg' },
]

const CHART_QUERY_ALIASES: Record<string, string> = {
  '热门': '热歌榜',
  '热榜': '热歌榜',
  '热门榜': '热歌榜',
  '热门榜单': '热歌榜',
  '排行榜': '热歌榜',
  '榜单': '热歌榜',
}

export interface OnlinePlaylist {
  source: string
  id: string
  name: string
  count: number
}

export interface OnlineSongs {
  source: string
  name: string
  songs: MiotSong[]
}

const normalizeText = (value: unknown): string =>
  String(value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')

const stripPlayVerb = (value: string): string =>
  String(value || '')
    .replace(/[。.!！?？]+$/g, '')
    .replace(/^(?:请|帮我|给我|小爱)\s*/, '')
    .replace(/^(?:播放|放一下|放|来点|来首|听一下|听|我想听|我要听)\s*/, '')
    .replace(/^[\s:：,，|、]+/, '')
    .trim()

const cleanChartQuery = (raw: string): { query: string; preferred?: string } => {
  let text = stripPlayVerb(raw)
  let preferred: string | undefined
  for (const item of PLATFORM_PREFIXES) {
    if (!item.re.test(text)) continue
    preferred = item.source
    text = text.replace(item.re, '').trim()
    break
  }
  text = text.replace(/^(?:排行榜|榜单)(?:\s*[:：,，|、]\s*|\s+)/, '').trim()
  text = CHART_QUERY_ALIASES[text] || text
  return { query: text || '热歌榜', preferred }
}

export const normalizeChartQuery = (raw: string): string => cleanChartQuery(raw).query

const scoreName = (candidate: string, query: string): number => {
  const c = normalizeText(candidate)
  const q = normalizeText(query)
  if (!c || !q) return 0
  if (c === q) return 1000
  if (c.startsWith(q)) return 700 - Math.min(200, c.length - q.length)
  if (c.includes(q)) return 500 - Math.min(200, c.length - q.length)
  if (q.includes(c)) return 300 - Math.min(200, q.length - c.length)
  return 0
}

const scoreBoard = (name: string, query: string): number =>
  scoreName(normalizeText(name).replace(/榜$/, ''), normalizeText(query).replace(/榜$/, ''))

const firstText = (...values: any[]): string => {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue
    return String(value)
  }
  return ''
}

const normalizeSong = (raw: any): MiotSong | null => {
  if (!raw || !raw.name) return null
  const source = String(raw.source || '')
  if (!source) return null
  const songmid = firstText(raw.songmid, raw.songId, raw.id)
  const id = firstText(raw.id, songmid)
  if (!id) return null
  return {
    ...raw,
    id,
    source,
    songmid: raw.songmid === undefined || raw.songmid === null ? songmid : String(raw.songmid),
  }
}

const normalizeSongList = (list: any, limit: number): MiotSong[] => {
  if (!Array.isArray(list)) return []
  const songs: MiotSong[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const song = normalizeSong(item)
    if (!song) continue
    const key = `${normalizeText(song.name)}|${normalizeText(song.singer)}`
    if (seen.has(key)) continue
    seen.add(key)
    songs.push(song)
    if (songs.length >= limit) break
  }
  return songs
}

export interface OnlineChart {
  source: string
  bangid: string
  name: string
}

interface BoardCandidate extends OnlineChart {
  score: number
  rank: number
}

export const findOnlineChart = async (rawQuery: string, username: string): Promise<OnlineChart | null> => {
  const { query, preferred } = cleanChartQuery(rawQuery)
  const candidates: BoardCandidate[] = []
  for (let rank = 0; rank < CHART_SOURCE_ORDER.length; rank++) {
    const source = CHART_SOURCE_ORDER[rank]
    if (!isSourceSupported(source, username || undefined)) continue
    try {
      const data = await musicSdk[source]?.leaderboard?.getBoards?.()
      const list: any[] = Array.isArray(data?.list) ? data.list : []
      for (const board of list) {
        const name = String(board?.name || '').trim()
        const bangid = firstText(board?.bangid, String(board?.id || '').split('__').pop())
        if (!name || !bangid) continue
        const score = scoreBoard(name, query)
        if (score <= 0) continue
        candidates.push({
          source,
          bangid,
          name,
          score,
          rank,
        })
      }
    } catch (err: any) {
      miotLog.warn(`[MIoT] 获取在线榜单列表失败 ${source}: ${err?.message || err}`)
    }
  }
  if (candidates.length === 0) return null
  const preferredPool = preferred ? candidates.filter(item => item.source === preferred) : []
  const pool = preferredPool.length > 0 ? preferredPool : candidates
  pool.sort((a, b) => b.score - a.score || a.rank - b.rank)
  const best = pool[0]
  return { source: best.source, bangid: best.bangid, name: best.name }
}

export const loadOnlineChartSongs = async (rawQuery: string, username: string, limit: number): Promise<OnlineSongs | null> => {
  const chart = await findOnlineChart(rawQuery, username)
  if (!chart) return null
  try {
    const result = await musicSdk[chart.source]?.leaderboard?.getList?.(chart.bangid, 1)
    const songs = normalizeSongList(result?.list, limit)
    if (songs.length === 0) return null
    return { source: chart.source, name: chart.name, songs }
  } catch (err: any) {
    miotLog.warn(`[MIoT] 获取在线榜单歌曲失败 ${chart.source}/${chart.name}: ${err?.message || err}`)
    return null
  }
}

export const searchOnlinePlaylist = async (keyword: string, username: string): Promise<OnlinePlaylist | null> => {
  const query = String(keyword || '').trim()
  if (!query) return null
  let best: (OnlinePlaylist & { score: number }) | null = null
  for (const source of PLAYLIST_SOURCE_ORDER) {
    if (!isSourceSupported(source, username || undefined)) continue
    try {
      const result = await musicSdk[source]?.songList?.search?.(query, 1, PLAYLIST_SEARCH_LIMIT)
      const list: any[] = Array.isArray(result?.list) ? result.list : []
      for (const item of list) {
        const name = String(item?.name || '').trim()
        const id = String(item?.id || '').trim()
        if (!name || !id) continue
        const score = scoreName(name, query)
        if (score <= 0) continue
        if (!best || score > best.score) {
          best = { source, id, name, count: Number(item?.total) || 0, score }
        }
      }
      if (best && best.score >= 1000) break
    } catch (err: any) {
      miotLog.warn(`[MIoT] 在线歌单搜索失败 ${source} "${query}": ${err?.message || err}`)
    }
  }
  if (!best) return null
  return { source: best.source, id: best.id, name: best.name, count: best.count }
}

export const loadOnlinePlaylistSongs = async (playlist: OnlinePlaylist, limit: number): Promise<OnlineSongs | null> => {
  try {
    const result = await musicSdk[playlist.source]?.songList?.getListDetail?.(playlist.id, 1)
    const songs = normalizeSongList(result?.list, limit)
    if (songs.length === 0) return null
    const name = String(result?.info?.name || playlist.name || '').trim() || playlist.name
    return { source: playlist.source, name, songs }
  } catch (err: any) {
    miotLog.warn(`[MIoT] 获取在线歌单歌曲失败 ${playlist.source}/${playlist.name}: ${err?.message || err}`)
    return null
  }
}
