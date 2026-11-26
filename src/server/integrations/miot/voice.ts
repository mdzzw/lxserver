import { createPlaylist, findPlaylist } from './library'
import { fetchChartSongs, parseSongType, songKey } from './aiRecommend'
import { getSongAlbumName, setAlbumDisliked, setArtistsDisliked, setSongDisliked } from './dislike'
import type { MiotVoiceIntentResult } from './aiIntent'
import { miotLog } from './log'
import { loadOnlineChartSongs, loadOnlinePlaylistSongs, normalizeChartQuery, searchOnlinePlaylist } from './onlineLibrary'
import type { MiotPlayer } from './player'
import { normalizePlayMode } from './store'
import { pickRandomLocalSongs, searchSongs } from './resolver'
import type { MiotSettings, MiotSong, MiotVoiceCommand, MiotVoiceMessage, MiotVoiceTestResult } from './types'

/** 口令类型优先级（数字越小优先级越高） */
const COMMAND_PRIORITY: Record<string, number> = {
  'play_artist': 1,
  'play_song': 1,
  'play_playlist': 2,
  'play_chart': 2,
  'play_index': 2,
  'set_play_mode': 3,
  'set_volume': 4,
  'favorite': 5,
  'favorite_to': 5,
  'dislike_song': 5,
  'dislike_artist': 5,
  'dislike_album': 5,
  'next': 6,
  'previous': 7,
  'sleep_timer': 7,
  'cancel_sleep_timer': 7,
  'query_sleep_timer': 7,
  'resume': 8,
  'stop': 8,
}

const SEARCH_COMMAND_TYPES = new Set(['play_song', 'play_playlist', 'play_artist', 'play_chart', 'favorite_to'])
const BUILTIN_STOP_KEYWORDS = ['暂停播放', '停止播放', '暂停音乐', '停一下', 'pause', 'stop', '暂停']
const BUILTIN_PLAYLIST_NAMES = new Set(['我的收藏', '试听列表'])
const BUILTIN_CHART_NAME_RE = /(热歌|飙升|新歌|原创|儿歌|古风|摇滚|民谣|电音|说唱|欧美|华语|粤语|日语|韩语|抖音|快手|dj|影视金曲|流行|怀旧|会员|热门|排行榜|榜单|top500)/i
const BUILTIN_CHART_QUESTION_RE = /什么|哪些|哪个|查询|介绍|多少|有没有|怎么/
const BUILTIN_CHART_VERB_RE = /^(?:请|帮我|给我|小爱)?\s*(?:播放|放一下|放|来点|来首|听一下|听|我想听|我要听)\s*/
const ONLINE_PLAYLIST_LIMIT = 100
const FUZZY_MAX_GAP = 4
const FUZZY_MIN_KEYWORD_LEN = 3
const VOLUME_SETTLE_MS = 800
const AI_LIST_BATCH = 20

/** 这些口令不改变播放内容，语音唤醒打断流播放后需要恢复 */
const RESUME_AFTER_COMMANDS = new Set(['set_volume', 'favorite', 'favorite_to', 'dislike_song', 'dislike_artist', 'dislike_album', 'sleep_timer', 'cancel_sleep_timer', 'query_sleep_timer'])

export interface MiotVoiceMatch {
  command: MiotVoiceCommand
  keyword: string
  argument: string
}

export interface MiotVoiceExecuteContext {
  player: MiotPlayer | null
  settings: MiotSettings
  deviceName: string
  resolveIntent?: (query: string) => Promise<MiotVoiceIntentResult>
}

export interface MiotVoiceMonitorContext {
  getPlayer(accountId: string, deviceId: string): MiotPlayer | null
  getSettings(): MiotSettings
  getCommands(): MiotVoiceCommand[]
  getHardware(accountId: string, deviceId: string): string | null
  getLatestAsk(accountId: string, deviceId: string, hardware: string, limit: number): Promise<Array<{ timestamp_ms: number; query: string; answer: string }> | null>
  isInternalQuery(question: string): boolean
  resolveIntent(accountId: string, deviceId: string, query: string): Promise<MiotVoiceIntentResult>
  onMessage(message: MiotVoiceMessage): void
}

export const chineseToNumber = (text: string): string => {
  const digitMap: Record<string, number> = {
    '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
  }
  const digitChars = '零一二两三四五六七八九'
  const segmentRe = new RegExp(`[${digitChars}十百千]+`, 'g')
  return text.replace(segmentRe, (segment) => {
    if (/[十百千]/.test(segment)) {
      const parsed = parseChineseSegment(segment, digitMap)
      return parsed === null ? segment : String(parsed)
    }
    let per = ''
    for (const char of segment) per += String(digitMap[char] ?? char)
    return per
  })
}

const parseChineseSegment = (segment: string, digitMap: Record<string, number>): number | null => {
  let section = 0
  let current = 0
  let hasUnit = false
  for (const char of segment) {
    if (char in digitMap) current = digitMap[char]
    else if (char === '十') {
      section += (current === 0 ? 1 : current) * 10
      current = 0
      hasUnit = true
    } else if (char === '百') {
      if (current === 0) return null
      section += current * 100
      current = 0
      hasUnit = true
    } else if (char === '千') {
      if (current === 0) return null
      section += current * 1000
      current = 0
      hasUnit = true
    } else return null
  }
  const total = section + current
  return total === 0 && !hasUnit ? null : total
}

export const parseTimeDuration = (text: string): number => {
  if (/[一1]个半\s*小时/.test(text)) return 90
  if (/[两二2]个半\s*小时/.test(text)) return 150
  if (/半个?\s*小时/.test(text)) return 30
  const normalized = chineseToNumber(text)
  const hourFloat = normalized.match(/(\d+(?:\.\d+)?)\s*(?:个\s*)?小时/)
  if (hourFloat) return Math.round(parseFloat(hourFloat[1]) * 60)
  const minutes = normalized.match(/(\d+)\s*分(?:钟)?/)
  if (minutes) return parseInt(minutes[1], 10)
  const number = normalized.match(/(\d+)/)
  return number ? parseInt(number[1], 10) : 0
}

export const parseSongsCount = (text: string): number => {
  const match = chineseToNumber(text).match(/(\d+)\s*首/)
  return match ? parseInt(match[1], 10) : 0
}

export const parseSongIndex = (text: string): number => {
  const normalized = chineseToNumber(text)
  const start = normalized.indexOf('第')
  if (start < 0) return 0
  const match = normalized.slice(start).match(/^第\s*(\d+)\s*(?:首(?:\s*歌)?)?\s*[。！？,.!?]*\s*$/)
  if (!match) return 0
  const index = Number(match[1])
  return Number.isSafeInteger(index) && index > 0 ? index : 0
}

const detectSleepMode = (text: string): 'time' | 'songs' | null => {
  if (/首/.test(text)) return 'songs'
  if (/分钟|分|小时|半/.test(text)) return 'time'
  return null
}

const formatSleepRemaining = (state: { active: boolean; mode: 'time' | 'songs'; remaining: number }): string => {
  if (!state.active) return '当前没有定时任务'
  if (state.mode === 'songs') return `还剩${state.remaining}首后停止`
  const remainMin = Math.ceil(state.remaining / 60000)
  if (remainMin >= 60) {
    const hours = Math.floor(remainMin / 60)
    const minutes = remainMin % 60
    return minutes > 0 ? `还剩${hours}小时${minutes}分钟后停止` : `还剩${hours}小时后停止`
  }
  return `还剩${remainMin}分钟后停止`
}

const fuzzySubseqMatch = (query: string[], keyword: string[], maxGap: number): { lastIdx: number; inserted: number } | null => {
  const kwLen = keyword.length
  if (kwLen < FUZZY_MIN_KEYWORD_LEN || query.length < kwLen) return null
  let best: { lastIdx: number; inserted: number } | null = null
  for (let start = 0; start <= query.length - kwLen; start++) {
    if (query[start] !== keyword[0]) continue
    let ki = 1
    let qi = start + 1
    while (qi < query.length && ki < kwLen) {
      if (query[qi] === keyword[ki]) ki++
      qi++
    }
    if (ki < kwLen) continue
    const lastIdx = qi - 1
    const inserted = (lastIdx - start + 1) - kwLen
    if (inserted > maxGap) continue
    if (best === null || inserted < best.inserted) best = { lastIdx, inserted }
  }
  return best
}

/**
 * 两趟匹配：先全局最长关键词精确包含，再对有界跳字做兜底。
 * 搜索口令之后的内容视为名称参数，不再参与控制词匹配。
 */
export const matchVoiceCommand = (rawQuery: string, commands: MiotVoiceCommand[]): MiotVoiceMatch | null => {
  const query = rawQuery.toLowerCase()
  const enabled = commands
    .filter(item => item.enabled && item.keywords.length > 0)
    .map(item => ({ cmd: item, priority: COMMAND_PRIORITY[item.type] ?? 99 }))
  if (enabled.length === 0) return null

  let argumentStart = Infinity
  let searchStart = Infinity
  let searchKeywordLen = 0
  for (const { cmd } of enabled) {
    if (!SEARCH_COMMAND_TYPES.has(cmd.type)) continue
    for (const keyword of cmd.keywords) {
      const lower = keyword.toLowerCase()
      if (!lower) continue
      const idx = query.indexOf(lower)
      const len = Array.from(lower).length
      if (idx >= 0 && (idx < searchStart || (idx === searchStart && len > searchKeywordLen))) {
        searchStart = idx
        argumentStart = idx + lower.length
        searchKeywordLen = len
      }
    }
  }

  let best: MiotVoiceMatch | null = null
  let bestKeywordLen = 0
  let bestPriority = 99

  for (const item of enabled) {
    for (const keyword of item.cmd.keywords) {
      const lower = keyword.toLowerCase()
      if (!lower) continue
      const idx = query.indexOf(lower)
      if (idx < 0 || idx >= argumentStart) continue
      if (item.cmd.type === 'play_index' && parseSongIndex(rawQuery.slice(idx)) <= 0) continue
      const len = Array.from(lower).length
      if (len > bestKeywordLen || (len === bestKeywordLen && item.priority < bestPriority)) {
        bestKeywordLen = len
        bestPriority = item.priority
        best = {
          command: item.cmd,
          keyword,
          argument: rawQuery.slice(idx + lower.length).trim(),
        }
      }
    }
  }
  if (best) return best

  const queryRunes = Array.from(query)
  let bestInserted = Infinity
  for (const item of enabled) {
    if (item.cmd.type === 'play_index') continue
    for (const keyword of item.cmd.keywords) {
      const keywordRunes = Array.from(keyword.toLowerCase())
      const match = fuzzySubseqMatch(queryRunes, keywordRunes, FUZZY_MAX_GAP)
      if (!match) continue
      const len = keywordRunes.length
      const better =
        len > bestKeywordLen ||
        (len === bestKeywordLen && match.inserted < bestInserted) ||
        (len === bestKeywordLen && match.inserted === bestInserted && item.priority < bestPriority)
      if (better) {
        bestKeywordLen = len
        bestInserted = match.inserted
        bestPriority = item.priority
        best = {
          command: item.cmd,
          keyword,
          argument: queryRunes.slice(match.lastIdx + 1).join('').trim(),
        }
      }
    }
  }
  return best
}

const matchBuiltinStop = (query: string): MiotVoiceMatch | null => {
  const normalized = query.toLowerCase()
  const keyword = BUILTIN_STOP_KEYWORDS
    .filter(item => normalized.includes(item))
    .sort((a, b) => Array.from(b).length - Array.from(a).length)[0]
  if (!keyword) return null
  return { command: { type: 'stop', keywords: BUILTIN_STOP_KEYWORDS, enabled: true }, keyword, argument: '' }
}

/** AI 关闭时也能直接听懂“播放飙升榜”这类榜单口令 */
const matchBuiltinChart = (query: string): MiotVoiceMatch | null => {
  const text = query.trim().replace(/[。.!！?？]+$/g, '')
  if (!text || text.length > 20) return null
  if (!/榜$/.test(text) || !BUILTIN_CHART_NAME_RE.test(text)) return null
  if (BUILTIN_CHART_QUESTION_RE.test(text)) return null
  const argument = text.replace(BUILTIN_CHART_VERB_RE, '').trim()
  if (!argument) return null
  return { command: { type: 'play_chart', keywords: [], enabled: true }, keyword: '内置榜单', argument }
}

const MODE_LABELS: Record<string, string> = {
  shuffle: '随机播放',
  single: '单曲循环',
  singlePlay: '单曲播放',
  loop: '列表循环',
  order: '顺序播放',
}

const shuffleSongs = (songs: MiotSong[]): MiotSong[] => {
  const copy = [...songs]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const temp = copy[i]
    copy[i] = copy[j]
    copy[j] = temp
  }
  return copy
}

const mergeSongs = (base: MiotSong[], extra: MiotSong[], limit: number): MiotSong[] => {
  const seen = new Set(base.map(songKey))
  const result = [...base]
  for (const song of extra) {
    if (!song?.name) continue
    const key = songKey(song)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(song)
    if (result.length >= limit) break
  }
  return result
}

/** 规则只匹配到“半截口令”时才值得交给 AI，完整口令保持原有的零延迟执行 */
const needsIntent = (match: MiotVoiceMatch | null): boolean => {
  if (!match) return true
  if ((match.command.type === 'play_song' || match.command.type === 'play_artist') && !match.argument) return true
  if (match.command.type === 'set_play_mode' && match.argument && !/^(模式|播放模式)$/.test(match.argument)) return true
  return false
}

const executeCommand = async (
  match: MiotVoiceMatch,
  rawQuery: string,
  context: MiotVoiceExecuteContext,
): Promise<{ executed: boolean; note: string }> => {
  const { player, settings, deviceName } = context
  if (!player) return { executed: false, note: '播放器未初始化' }
  const type = match.command.type
  const argument = match.argument
  const username = settings.username

  try {
    switch (type) {
      case 'play_playlist': {
        if (!argument) {
          const ok = await player.playPlaylist(settings.default_playlist_id, { announce: true })
          return { executed: ok, note: ok ? `播放默认歌单 ${settings.default_playlist_id}` : '默认歌单为空或播放失败' }
        }
        const listName = argument.trim()
        const playlist = await findPlaylist(username, listName)
        if (playlist) {
          const okLocal = await player.playPlaylist(playlist.id, { announce: true })
          if (okLocal) {
            return { executed: true, note: `播放本地歌单 ${playlist.name || playlist.id}` }
          }
        }
        if (!BUILTIN_PLAYLIST_NAMES.has(listName)) {
          const online = await searchOnlinePlaylist(listName, username)
          if (online) {
            const loaded = await loadOnlinePlaylistSongs(online, ONLINE_PLAYLIST_LIMIT)
            if (loaded) {
              const okOnline = await player.playSongs(loaded.songs, `歌单 · ${loaded.name}`, { announce: true })
              if (okOnline) {
                return { executed: true, note: `在线歌单 ${loaded.name}（${loaded.source}，${loaded.songs.length} 首）` }
              }
            }
          }
        }
        if (playlist) {
          return { executed: false, note: `本地歌单 ${playlist.name || playlist.id} 为空或播放失败` }
        }
        await player.announce(`没有找到歌单 ${listName}`)
        return { executed: false, note: `未找到歌单 "${listName}"` }
      }
      case 'play_song':
      case 'play_artist': {
        if (!argument) {
          await player.announce('请说歌名')
          return { executed: false, note: '缺少歌名' }
        }
        const songs = await searchSongs(argument, username, 10)
        if (songs.length === 0) {
          await player.announce(`没有找到 ${argument}`)
          return { executed: false, note: `搜索无结果: ${argument}` }
        }
        // 开启 AI 推歌时只播搜索第一名作为种子，播完由播放器续播同类推荐
        const autoRecommend = settings.ai_recommend_enabled
        const ok = await player.playSongs(autoRecommend ? songs.slice(0, 1) : songs, `搜索：${argument}`, {
          announce: true,
          autoRecommend,
        })
        return {
          executed: ok,
          note: ok
            ? `播放搜索 ${argument}（${songs[0].name}${autoRecommend ? '，AI 同类续播' : ''}）`
            : '播放失败',
        }
      }
      case 'play_index': {
        const index = parseSongIndex(rawQuery)
        if (index <= 0) return { executed: false, note: '无法识别序号' }
        const view = await player.getView()
        if (index > view.songs.length) {
          await player.announce(`没有第${index}首`)
          return { executed: false, note: `序号超出范围: ${index}/${view.songs.length}` }
        }
        const ok = await player.playAt(index - 1, { announce: true })
        return { executed: ok, note: ok ? `跳到第 ${index} 首` : '跳播失败' }
      }
      case 'play_random': {
        const keyword = argument.trim()
        const type = keyword ? parseSongType(keyword) : ''
        let songs = await pickRandomLocalSongs(username, AI_LIST_BATCH, keyword)
        if (keyword && !type) {
          if (songs.length < AI_LIST_BATCH) {
            const found = shuffleSongs(await searchSongs(keyword, username, AI_LIST_BATCH))
            songs = mergeSongs(songs, found, AI_LIST_BATCH)
          }
        } else {
          if (songs.length < AI_LIST_BATCH) {
            const chart = shuffleSongs(await fetchChartSongs(type))
            songs = mergeSongs(songs, chart, AI_LIST_BATCH)
          }
          if (songs.length === 0) {
            songs = shuffleSongs(await searchSongs(keyword || '热门歌曲', username, AI_LIST_BATCH))
          }
        }
        if (songs.length === 0) {
          await player.announce('没有找到可以随机播放的歌曲')
          return { executed: false, note: '随机听歌无结果' }
        }
        await player.setMode('shuffle')
        const okRandom = await player.playSongs(songs, keyword ? `随机听歌 · ${keyword}` : '随便听听', { announce: true })
        return {
          executed: okRandom,
          note: okRandom ? `随机播放 ${songs.length} 首${keyword ? `（${keyword}）` : ''}` : '随机播放失败',
        }
      }
      case 'play_hot': {
        const keyword = argument.trim()
        const type = keyword ? parseSongType(keyword) : ''
        let songs = type ? await fetchChartSongs(type) : []
        if (keyword && !type) songs = await searchSongs(keyword, username, AI_LIST_BATCH)
        if (songs.length === 0) {
          songs = await searchSongs(keyword ? `${keyword}热门` : '热门歌曲', username, AI_LIST_BATCH)
        }
        songs = songs.slice(0, AI_LIST_BATCH)
        if (songs.length === 0) {
          await player.announce('没有找到热门歌曲')
          return { executed: false, note: '热门歌曲无结果' }
        }
        const view = await player.getView()
        if (view.mode === 'single' || view.mode === 'singlePlay') await player.setMode('order')
        const listName = keyword ? `热门 · ${keyword}` : '热门歌曲'
        const okHot = await player.playSongs(songs, listName, { announce: true })
        return {
          executed: okHot,
          note: okHot ? `播放热门 ${songs.length} 首${keyword ? `（${keyword}）` : ''}` : '热门播放失败',
        }
      }
      case 'play_chart': {
        const chartQuery = normalizeChartQuery(argument || match.keyword)
        const online = await loadOnlineChartSongs(chartQuery, username, AI_LIST_BATCH)
        if (online) {
          const viewOnline = await player.getView()
          if (viewOnline.mode === 'single' || viewOnline.mode === 'singlePlay') await player.setMode('order')
          const okOnline = await player.playSongs(online.songs, `榜单 · ${online.name}`, { announce: true })
          if (okOnline) {
            return { executed: true, note: `在线榜单 ${online.name}（${online.source}，${online.songs.length} 首）` }
          }
        }

        const localPlaylist = await findPlaylist(username, chartQuery)
        if (localPlaylist) {
          const okLocalList = await player.playPlaylist(localPlaylist.id, { announce: true })
          if (okLocalList) return { executed: true, note: `本地歌单 ${localPlaylist.name}（榜单兜底）` }
        }

        const keyword = chartQuery.replace(/(?:排行榜|榜单|榜)$/, '').trim()
        const type = keyword ? parseSongType(keyword) : ''
        let songs = await pickRandomLocalSongs(username, AI_LIST_BATCH, type || keyword)
        if (songs.length === 0) songs = await pickRandomLocalSongs(username, AI_LIST_BATCH)
        if (songs.length === 0) {
          await player.announce(`没有找到榜单 ${chartQuery}`)
          return { executed: false, note: `榜单无结果: ${chartQuery}` }
        }
        const viewLocal = await player.getView()
        if (viewLocal.mode === 'single' || viewLocal.mode === 'singlePlay') await player.setMode('order')
        const okLocal = await player.playSongs(songs, `榜单 · ${chartQuery}（本地）`, { announce: true })
        return {
          executed: okLocal,
          note: okLocal ? `本地兜底 ${songs.length} 首（${chartQuery}）` : '榜单播放失败',
        }
      }
      case 'set_play_mode': {
        const mode = normalizePlayMode(match.command.param)
        await player.setMode(mode)
        await player.announce(MODE_LABELS[mode] ?? '已切换播放模式')
        return { executed: true, note: `播放模式 → ${mode}` }
      }
      case 'set_volume': {
        // 音量由小爱固件原生处理，这里只回读设备真实值；重发会导致双重调节和静音 bug
        await new Promise(resolve => setTimeout(resolve, VOLUME_SETTLE_MS))
        const volume = await player.syncVolume()
        return { executed: volume >= 0, note: volume >= 0 ? `音量同步为 ${volume}` : '音量回读失败' }
      }
      case 'favorite': {
        const action = match.command.param === 'remove' ? 'remove' : 'add'
        const ok = await player.favoriteCurrent(action)
        await player.announce(ok ? (action === 'add' ? '已收藏' : '已取消收藏') : '操作失败')
        return { executed: ok, note: action === 'add' ? '收藏当前歌曲' : '取消收藏当前歌曲' }
      }
      case 'favorite_to': {
        if (!argument) {
          await player.announce('请说收藏到哪个歌单')
          return { executed: false, note: '缺少歌单名' }
        }
        if (!await player.ensureCurrentSong()) {
          await player.announce('当前没有播放歌曲')
          return { executed: false, note: '当前无播放歌曲' }
        }
        let playlist = await findPlaylist(username, argument)
        let created = false
        if (!playlist) {
          try {
            playlist = await createPlaylist(username, argument)
            created = true
            miotLog.info(`[MIoT] 语音收藏自动创建歌单 "${playlist.name}"`)
          } catch (err: any) {
            await player.announce('创建歌单失败')
            return { executed: false, note: `创建歌单 "${argument}" 失败: ${err?.message || err}` }
          }
        }
        const result = await player.addCurrentToList(playlist.id)
        if (result === 'no-song') {
          await player.announce('当前没有播放歌曲')
          return { executed: false, note: '当前无播放歌曲' }
        }
        const ok = result === 'added' || result === 'exists'
        await player.announce(ok
          ? (result === 'exists' ? `已经在歌单${playlist.name}里了`
            : created ? `已新建歌单${playlist.name}并收藏` : `已收藏到歌单${playlist.name}`)
          : '收藏失败')
        return { executed: ok, note: ok ? (created ? `新建歌单 ${playlist.name} 并收藏` : `收藏到歌单 ${playlist.name}`) : '收藏到歌单失败' }
      }
      case 'dislike_song': {
        const action = match.command.param === 'remove' ? 'remove' : 'add'
        const song = await player.ensureCurrentSong()
        if (!song) {
          await player.announce('当前没有播放歌曲')
          return { executed: false, note: '当前无播放歌曲' }
        }
        const singer = String(song.singer || '').trim()
        if (!singer) {
          await player.announce('当前歌曲没有歌手信息，无法标记')
          return { executed: false, note: '当前歌曲缺少歌手信息' }
        }
        const result = await setSongDisliked(username, song, action === 'add')
        const name = result.names[0] || song.name
        // 标记成功后切歌；取消不喜欢不改变播放内容
        const skipped = action === 'add' && result.ok ? await player.next() : false
        let message = '操作失败'
        if (result.ok) {
          message = action === 'add'
            ? (result.changed ? `已不喜欢${name}` : `${name}已经在不喜欢列表里了`)
            : (result.changed ? `已取消不喜欢${name}` : `${name}不在不喜欢列表里`)
          if (skipped) message += '，已切到下一首'
        }
        await player.announce(message)
        return {
          executed: result.ok,
          note: result.ok
            ? action === 'add'
              ? `${result.changed ? '不喜欢歌曲' : '歌曲已在不喜欢列表'}：${name} - ${singer}${skipped ? '，已切到下一首' : ''}`
              : (result.changed ? `取消不喜欢歌曲：${name} - ${singer}` : `歌曲不在不喜欢列表：${name} - ${singer}`)
            : '同步不喜欢歌曲失败',
        }
      }
      case 'dislike_artist': {
        const action = match.command.param === 'remove' ? 'remove' : 'add'
        const song = await player.ensureCurrentSong()
        if (!song) {
          await player.announce('当前没有播放歌曲')
          return { executed: false, note: '当前无播放歌曲' }
        }
        if (!String(song.singer || '').trim()) {
          await player.announce('当前歌曲没有歌手信息')
          return { executed: false, note: '当前歌曲缺少歌手信息' }
        }
        const result = await setArtistsDisliked(username, song, action === 'add')
        const names = result.names.join('、') || String(song.singer)
        const skipped = action === 'add' && result.ok ? await player.next() : false
        let message = '操作失败'
        if (result.ok) {
          message = action === 'add'
            ? (result.changed ? `已不喜欢歌手${names}` : `${names}已经在不喜欢歌手列表里了`)
            : (result.changed ? `已取消不喜欢歌手${names}` : `${names}不在不喜欢歌手列表里`)
          if (skipped) message += '，已切到下一首'
        }
        await player.announce(message)
        return {
          executed: result.ok,
          note: result.ok
            ? action === 'add'
              ? `${result.changed ? '不喜欢歌手' : '歌手已在不喜欢列表'}：${names}${skipped ? '，已切到下一首' : ''}`
              : (result.changed ? `取消不喜欢歌手：${names}` : `歌手不在不喜欢列表：${names}`)
            : '同步不喜欢歌手失败',
        }
      }
      case 'dislike_album': {
        const action = match.command.param === 'remove' ? 'remove' : 'add'
        const song = await player.ensureCurrentSong()
        if (!song) {
          await player.announce('当前没有播放歌曲')
          return { executed: false, note: '当前无播放歌曲' }
        }
        const albumName = getSongAlbumName(song)
        if (!albumName) {
          await player.announce('当前歌曲没有专辑信息')
          return { executed: false, note: '当前歌曲缺少专辑信息' }
        }
        const result = await setAlbumDisliked(username, song, action === 'add')
        const name = result.names[0] || albumName
        const skipped = action === 'add' && result.ok ? await player.next() : false
        let message = '操作失败'
        if (result.ok) {
          message = action === 'add'
            ? (result.changed ? `已不喜欢专辑${name}` : `${name}已经在不喜欢专辑列表里了`)
            : (result.changed ? `已取消不喜欢专辑${name}` : `${name}不在不喜欢专辑列表里`)
          if (skipped) message += '，已切到下一首'
        }
        await player.announce(message)
        return {
          executed: result.ok,
          note: result.ok
            ? action === 'add'
              ? `${result.changed ? '不喜欢专辑' : '专辑已在不喜欢列表'}：${name}${skipped ? '，已切到下一首' : ''}`
              : (result.changed ? `取消不喜欢专辑：${name}` : `专辑不在不喜欢列表：${name}`)
            : '同步不喜欢专辑失败',
        }
      }
      case 'next': {
        const ok = await player.next()
        if (!ok) await player.announce('已经是最后一首了')
        return { executed: ok, note: ok ? '下一首' : '没有下一首' }
      }
      case 'previous': {
        const ok = await player.previous()
        if (!ok) await player.announce('已经是第一首了')
        return { executed: ok, note: ok ? '上一首' : '没有上一首' }
      }
      case 'resume': {
        const ok = await player.resume()
        if (!ok) await player.announce('恢复播放失败')
        return { executed: ok, note: ok ? '继续播放' : '恢复失败' }
      }
      case 'stop': {
        await player.stop()
        return { executed: true, note: '停止播放' }
      }
      case 'sleep_timer': {
        const mode = detectSleepMode(rawQuery)
        if (!mode) {
          await player.announce('请说多少分钟或多少首后停止')
          return { executed: false, note: '未识别定时时长' }
        }
        const value = mode === 'time' ? parseTimeDuration(rawQuery) : parseSongsCount(rawQuery)
        if (value <= 0) {
          await player.announce('请说多少分钟或多少首后停止')
          return { executed: false, note: '定时数值无效' }
        }
        const state = player.setSleepTimer(mode, value)
        await player.announce(formatSleepRemaining(state))
        return { executed: true, note: `睡眠定时 ${mode} ${value}` }
      }
      case 'cancel_sleep_timer': {
        const cancelled = player.cancelSleepTimer()
        await player.announce(cancelled ? '已取消定时' : '当前没有定时任务')
        return { executed: cancelled, note: cancelled ? '取消定时' : '无定时任务' }
      }
      case 'query_sleep_timer': {
        const state = player.getSleepState()
        await player.announce(formatSleepRemaining(state))
        return { executed: true, note: formatSleepRemaining(state) }
      }
      default:
        return { executed: false, note: `未知口令 ${type}` }
    }
  } catch (err: any) {
    miotLog.warn(`[MIoT] 口令执行失败 type=${type} device=${deviceName}: ${err?.message || err}`)
    return { executed: false, note: `执行异常: ${err?.message || err}` }
  }
}

/**
 * 处理一条语音查询：规则匹配 → 执行 → 必要时恢复被打断的播放。
 * 返回结果供接口测试和管理页日志使用。
 */
export const handleVoiceQuery = async (
  query: string,
  commands: MiotVoiceCommand[],
  context: MiotVoiceExecuteContext,
): Promise<MiotVoiceTestResult> => {
  const text = query.trim()
  if (!text) return { matched: false }
  let matched = matchVoiceCommand(text, commands) || matchBuiltinStop(text) || matchBuiltinChart(text)
  let aiFailureNote = ''

  if (context.resolveIntent && needsIntent(matched)) {
    const resolved = await context.resolveIntent(text)
    if (resolved.failed) {
      aiFailureNote = resolved.note || 'AI 分析异常，本次跳过'
    } else if (resolved.intent) {
      matched = {
        command: {
          type: resolved.intent.type,
          keywords: [],
          param: resolved.intent.param,
          enabled: true,
        },
        keyword: 'AI',
        argument: resolved.intent.argument || '',
      }
    }
  }

  if (aiFailureNote) {
    return { matched: false, note: aiFailureNote, skipResume: true }
  }
  if (!matched) return { matched: false }

  const result = await executeCommand(matched, text, context)
  return {
    matched: true,
    command: matched.command.type,
    keyword: matched.keyword,
    argument: matched.argument,
    note: result.note,
    executed: result.executed,
  }
}

export class MiotVoiceMonitor {
  private accountId: string
  private deviceId: string
  private deviceName: string
  private context: MiotVoiceMonitorContext
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private polling = false
  private primed = false
  private lastTimestampMs = 0
  private failures = 0

  constructor(accountId: string, deviceId: string, deviceName: string, context: MiotVoiceMonitorContext) {
    this.accountId = accountId
    this.deviceId = deviceId
    this.deviceName = deviceName
    this.context = context
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.loop()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private intervalMs(): number {
    const seconds = this.context.getSettings().poll_interval_sec
    return Math.max(1, Math.min(30, Number(seconds) || 2)) * 1000
  }

  private async loop(): Promise<void> {
    if (this.stopped) return
    let delay = this.intervalMs()
    try {
      delay = await this.pollOnce()
    } catch (err: any) {
      miotLog.warn(`[MIoT] 对话轮询异常 device=${this.deviceName}: ${err?.message || err}`)
    }
    if (this.stopped) return
    this.timer = setTimeout(() => { void this.loop() }, delay)
  }

  private async pollOnce(): Promise<number> {
    if (this.polling) return this.intervalMs()
    const hardware = this.context.getHardware(this.accountId, this.deviceId)
    if (!hardware) return this.intervalMs()

    this.polling = true
    try {
      const messages = await this.context.getLatestAsk(this.accountId, this.deviceId, hardware, 3)
      if (messages === null) {
        this.failures++
        const base = this.intervalMs()
        return Math.min(60000, Math.max(base * 2, base * Math.pow(2, Math.min(this.failures, 4))))
      }
      this.failures = 0

      if (!this.primed) {
        this.primed = true
        this.lastTimestampMs = messages.length > 0
          ? Math.max(...messages.map(item => item.timestamp_ms))
          : 0
        miotLog.info(`[MIoT] 对话基线 device=${this.deviceName} lastTimestamp=${this.lastTimestampMs}`)
        return this.intervalMs()
      }

      const fresh = messages
        .filter(item => item.timestamp_ms > this.lastTimestampMs)
        .sort((a, b) => a.timestamp_ms - b.timestamp_ms)
      for (const message of fresh) {
        this.lastTimestampMs = Math.max(this.lastTimestampMs, message.timestamp_ms)
        await this.process(message)
      }
      return this.intervalMs()
    } finally {
      this.polling = false
    }
  }

  private async process(message: { timestamp_ms: number; query: string; answer: string }): Promise<void> {
    const question = (message.query || '').trim()
    if (!question) return
    const player = this.context.getPlayer(this.accountId, this.deviceId)
    const wasPlaying = player?.isPlaying() ?? false
    const settings = this.context.getSettings()

    if (this.context.isInternalQuery(question)) {
      // 分类/意图请求与结果由 MiotService 写入设备对话记录，这里只跳过口令匹配，避免重复
      miotLog.info(`[MIoT] AI 内部询问 device=${this.deviceName} answer="${(message.answer || '').slice(0, 80)}"`)
      return
    }

    const result = await handleVoiceQuery(question, this.context.getCommands(), {
      player,
      settings,
      deviceName: this.deviceName,
      resolveIntent: (text: string) => this.context.resolveIntent(this.accountId, this.deviceId, text),
    })

    const resumeNeeded = wasPlaying && !result.skipResume && (!result.command || RESUME_AFTER_COMMANDS.has(result.command))
    if (resumeNeeded && player) await player.ensureDevicePlaying()

    const logMessage: MiotVoiceMessage = {
      account_id: this.accountId,
      device_id: this.deviceId,
      device_name: this.deviceName,
      timestamp_ms: message.timestamp_ms,
      question,
      answer: message.answer || '',
      received_at: Date.now(),
      executed: !!result.executed,
      command: result.command,
      note: result.note,
    }
    this.context.onMessage(logMessage)
    miotLog.info(`[MIoT] 语音 device=${this.deviceName} query="${question}" → ${result.command || '未匹配'} ${result.note || ''}`)
  }
}
