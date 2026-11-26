import musicSdkRaw from '@/modules/utils/musicSdk/index.js'
import { httpFetch } from '@/modules/utils/request'
import { AI_CLASSIFY_MARKER, AI_SONG_TYPES, type MiotSongType } from './aiConstants'
import { miotLog } from './log'
import { renderPromptTemplate, stripPromptMarker } from './promptTemplate'
import { searchSongs } from './resolver'
import type { MiotSong } from './types'

const musicSdk = musicSdkRaw as any

const NETEASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://music.163.com/',
}

/** 类型 → 酷狗榜单 ID；AI 分类失败时仍能按类型兜底 */
const KG_TOP_BOARD_ID = '8888'
const KG_BOARD_BY_TYPE: Record<string, string> = {
  '儿歌': '65234',
  '流行': '59703',
  '摇滚': '59896',
  '民谣': '51341',
  '古风': '33161',
  '说唱': '44412',
  '电子': '33160',
  '爵士': '59897',
  '古典': '59899',
  '纯音乐': '59900',
  '其他': '8888',
}

const CHILD_HINTS = [
  '儿歌', '童谣', '儿童', '宝宝', '幼儿', '亲子', '贝瓦', '儿歌多多', '小伴龙',
  '兔小贝', '亲宝', '咕力', '火火兔', '宝宝巴士', '碰碰狐', '贝乐虎', '巴塔木',
  '超级宝贝', '宝宝巴士', 'jojo', 'cocomelon',
]

const TYPE_ALIASES: Array<[MiotSongType, string[]]> = [
  ['儿歌', ['儿歌', '童谣', '儿童歌曲', '宝宝', '亲子']],
  ['说唱', ['说唱', 'rap', 'hip-hop', 'hiphop', '嘻哈']],
  ['摇滚', ['摇滚', 'rock']],
  ['民谣', ['民谣', 'folk']],
  ['古典', ['古典', 'classical', '交响']],
  ['爵士', ['爵士', 'jazz']],
  ['古风', ['古风', '国风', '中国风']],
  ['电子', ['电子', '电音', 'edm', 'electronic']],
  ['纯音乐', ['纯音乐', '轻音乐', '器乐', '钢琴曲', 'instrumental']],
  ['流行', ['流行', 'pop', '通俗']],
]

const normalizeText = (value: unknown): string =>
  String(value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')

export const songKey = (song: MiotSong): string =>
  `${normalizeText(song?.name)}|${normalizeText(song?.singer)}`

export const songTypeCacheKey = (song: MiotSong): string => {
  const album = song?.albumName || song?.album?.name || song?.meta?.albumName || ''
  return `${normalizeText(song?.name)}|${normalizeText(song?.singer)}|${normalizeText(album)}`
}

export const DEFAULT_CLASSIFY_PROMPT_TEMPLATE =
  '{song}。只回复一句话：少爷将继续为您推荐（类型），不要解释。类型只能是：{types}。'

export const buildClassifyPrompt = (song: MiotSong, template?: string): string => {
  const title = String(song?.name || '').trim()
  const singer = String(song?.singer || '').trim()
  const songLabel = singer ? `${title}，${singer}` : title
  const custom = String(template || '').trim()
  const source = stripPromptMarker(custom || DEFAULT_CLASSIFY_PROMPT_TEMPLATE, AI_CLASSIFY_MARKER)
  const rendered = renderPromptTemplate(source, {
    title,
    singer,
    song: songLabel,
    types: AI_SONG_TYPES.join('、'),
  })
  let body = rendered.text.trim()
  if (!rendered.used.has('song') && !rendered.used.has('title')) body = `${songLabel}。${body}`
  if (!rendered.used.has('types')) body = `${body}类型只能是：${AI_SONG_TYPES.join('、')}。`
  return `${AI_CLASSIFY_MARKER}：${body}`
}

/** 从大模型回答里提取封闭类型；优先取文本中最早出现的类型词 */
export const parseSongType = (answer: string): MiotSongType | '' => {
  const text = String(answer || '').toLowerCase()
  if (!text) return ''
  let best: { type: MiotSongType; index: number } | null = null
  for (const [type, aliases] of TYPE_ALIASES) {
    for (const alias of aliases) {
      const index = text.indexOf(alias.toLowerCase())
      if (index < 0) continue
      if (!best || index < best.index) best = { type, index }
    }
  }
  if (best) return best.type
  if (text.includes('其他') || text.includes('other')) return '其他'
  return ''
}

/** 无 AI 时的轻量启发式：只用于兜底推荐，不写进类型缓存 */
export const guessSongType = (song: MiotSong): MiotSongType | '' => {
  const text = `${song?.name || ''} ${song?.singer || ''} ${song?.albumName || ''}`.toLowerCase()
  return CHILD_HINTS.some(hint => text.includes(hint)) ? '儿歌' : ''
}

const formatDuration = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds || 0))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

interface NeteaseSong {
  id?: number | string
  name?: string
  duration?: number
  dt?: number
  fee?: number
  artists?: Array<{ name?: string }>
  ar?: Array<{ name?: string }>
  album?: { name?: string; picUrl?: string }
  al?: { name?: string; picUrl?: string }
  privilege?: { fee?: number }
}

const neteaseSongToMiot = (item: NeteaseSong): MiotSong => {
  const id = String(item?.id ?? '')
  const artists = item?.artists || item?.ar || []
  const album = item?.album || item?.al || {}
  const durationMs = Number(item?.duration ?? item?.dt ?? 0)
  return {
    id,
    name: String(item?.name || ''),
    singer: artists.map(artist => artist?.name).filter(Boolean).join('、'),
    source: 'wy',
    songmid: id,
    albumName: album?.name || '',
    img: album?.picUrl || '',
    interval: formatDuration(durationMs > 1000 ? durationMs / 1000 : durationMs),
    vip: Number(item?.fee ?? item?.privilege?.fee ?? 0) > 0,
    meta: { songId: id },
  }
}

const fetchJson = async (url: string): Promise<any> => {
  try {
    const { body } = await (httpFetch as any)(url, { headers: NETEASE_HEADERS }).promise
    return body
  } catch (err: any) {
    miotLog.warn(`[MIoT] 网易云接口请求失败: ${err?.message || err}`)
    return null
  }
}

const neteaseIdCache = new Map<string, { id: string; at: number }>()
const NETEASE_ID_CACHE_TTL_MS = 30 * 60 * 1000

/** 把种子歌曲映射到网易云 ID：同源直接取，其他源按歌名 + 歌手搜索匹配 */
const findNeteaseId = async (seed: MiotSong): Promise<string> => {
  if (seed.source === 'wy' && seed.songmid) return String(seed.songmid)
  const cacheKey = songKey(seed)
  const cached = neteaseIdCache.get(cacheKey)
  if (cached && Date.now() - cached.at < NETEASE_ID_CACHE_TTL_MS) return cached.id

  const query = encodeURIComponent(`${seed.name} ${seed.singer || ''}`.trim())
  const body = await fetchJson(`https://music.163.com/api/search/get/web?csrf_token=&s=${query}&type=1&offset=0&total=true&limit=5`)
  const list: NeteaseSong[] = body?.result?.songs || []
  const nameKey = normalizeText(seed.name)
  const singerKey = normalizeText(seed.singer)
  let bestId = ''
  let bestScore = 0
  for (const item of list) {
    const itemName = normalizeText(item?.name)
    if (!itemName) continue
    let score = itemName === nameKey ? 100 : (itemName.includes(nameKey) || nameKey.includes(itemName) ? 50 : 0)
    if (score <= 0) continue
    const artistText = (item.artists || []).map(artist => artist?.name).filter(Boolean).join(' ')
    if (singerKey && normalizeText(artistText).includes(singerKey)) score += 30
    if (score > bestScore) {
      bestScore = score
      bestId = String(item?.id ?? '')
    }
  }
  if (bestId) neteaseIdCache.set(cacheKey, { id: bestId, at: Date.now() })
  return bestId
}

const fetchSimilarSongs = async (neteaseId: string, limit: number): Promise<MiotSong[]> => {
  const body = await fetchJson(`https://music.163.com/api/v1/discovery/simiSong?songid=${encodeURIComponent(neteaseId)}&limit=${limit}`)
  const list: NeteaseSong[] = body?.songs || body?.data?.songs || []
  return list.map(neteaseSongToMiot).filter(song => song.name && song.songmid)
}

export const fetchChartSongs = async (type: string): Promise<MiotSong[]> => {
  const bangid = type ? KG_BOARD_BY_TYPE[type] : KG_TOP_BOARD_ID
  if (!bangid || !musicSdk?.kg?.leaderboard?.getList) return []
  try {
    const data = await musicSdk.kg.leaderboard.getList(bangid, 1)
    return Array.isArray(data?.list) ? data.list : []
  } catch (err: any) {
    miotLog.warn(`[MIoT] 获取 ${type} 榜单失败: ${err?.message || err}`)
    return []
  }
}

export interface RecommendOptions {
  username: string
  type: string
  exclude: string[]
  limit: number
}

export interface RecommendResult {
  songs: MiotSong[]
  type: string
}

/**
 * 同类推荐：网易云相似歌曲为主，类型榜单/关键词搜索/同歌手其他作品依次兜底。
 * 全部过滤与种子同名的翻唱版本，避免又回到单曲循环。
 */
export const collectRecommendations = async (seed: MiotSong, options: RecommendOptions): Promise<RecommendResult> => {
  const limit = Math.max(1, Math.min(30, options.limit || 20))
  const songs: MiotSong[] = []
  const seen = new Set((options.exclude || []).filter(Boolean))
  const seedNameKey = normalizeText(seed.name)

  const push = (items: MiotSong[]): boolean => {
    for (const item of items) {
      if (!item?.name) continue
      if (normalizeText(item.name) === seedNameKey) continue
      const key = songKey(item)
      if (seen.has(key)) continue
      seen.add(key)
      songs.push(item)
      if (songs.length >= limit) return true
    }
    return false
  }

  const neteaseId = await findNeteaseId(seed)
  if (neteaseId) {
    const similar = await fetchSimilarSongs(neteaseId, Math.min(30, limit + 10))
    if (push(similar)) return { songs, type: options.type }
  }

  if (songs.length < limit && options.type) {
    const chart = await fetchChartSongs(options.type)
    if (push(chart)) return { songs, type: options.type }
  }

  if (songs.length < Math.min(8, limit) && options.type) {
    const keywords = options.type === '儿歌' ? ['儿歌', '童谣'] : [options.type]
    for (const keyword of keywords) {
      if (songs.length >= Math.min(8, limit)) break
      const found = await searchSongs(keyword, options.username, 12)
      if (push(found)) return { songs, type: options.type }
    }
  }

  if (songs.length < Math.min(5, limit) && seed.singer) {
    const found = await searchSongs(String(seed.singer), options.username, 12)
    push(found)
  }

  return { songs, type: options.type }
}
