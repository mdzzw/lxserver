import { AI_INTENT_MARKER, AI_SONG_TYPES } from './aiConstants'
import { renderPromptTemplate, stripPromptMarker } from './promptTemplate'
import type { MiotVoiceCommand } from './types'
import { getDefaultVoiceCommands } from './voiceDefaults'

export interface MiotVoiceIntent {
  type: string
  argument?: string
  param?: string
}

export interface MiotVoiceIntentResult {
  intent: MiotVoiceIntent | null
  failed?: boolean
  disabled?: boolean
  note?: string
}

export interface IntentParseResult {
  intent: MiotVoiceIntent | null
  noIntent: boolean
}

interface IntentEntry {
  label: string
  lower: string
  type: string
  param?: string
}

interface CommandGroup {
  type: string
  param?: string
  keywords: string[]
}

const INTENT_COMMAND_CATALOG_MAX_LENGTH = 1400

const AI_EXTENSION_LABELS: Record<'play_random' | 'play_hot', string[]> = {
  play_random: ['随机听歌', '随便放点歌曲', '来点音乐', '随机播放歌曲'],
  play_hot: ['播放热门', '热门歌曲', '来点热门歌曲'],
}

const AI_EXTENSION_GROUPS: CommandGroup[] = [
  { type: 'play_random', keywords: ['随机听歌'] },
  { type: 'play_hot', keywords: ['播放热门'] },
]

const REQUIRED_ARGUMENT_TYPES = new Set(['play_song', 'play_artist', 'play_playlist', 'play_index', 'favorite_to', 'sleep_timer'])

const PLAY_MODE_NAMES: Record<string, string> = {
  shuffle: '随机模式',
  single: '单曲循环',
  singlePlay: '单曲播放',
  loop: '列表循环',
  order: '顺序播放',
}

const COMMAND_ACTIONS: Record<string, string> = {
  play_song: '播放歌曲',
  play_artist: '播放歌手',
  play_playlist: '播放歌单',
  play_chart: '播放榜单',
  play_random: '随机听歌',
  play_hot: '播放热门',
  play_index: '按序号播放',
  next: '下一首',
  previous: '上一首',
  resume: '继续播放',
  stop: '暂停/停止',
  set_play_mode: '切换播放模式',
  set_volume: '调节音量',
  favorite: '收藏歌曲',
  favorite_to: '收藏到歌单',
  dislike_song: '不喜欢当前歌曲',
  dislike_artist: '不喜欢当前歌手',
  dislike_album: '不喜欢当前专辑',
  sleep_timer: '定时停止',
  cancel_sleep_timer: '取消定时',
  query_sleep_timer: '查询定时',
}

const COMMAND_ARGUMENT_HINTS: Record<string, string> = {
  play_song: '歌名',
  play_artist: '歌手名',
  play_playlist: '歌单名',
  play_chart: '榜单名（可选）',
  play_random: '类型（可选）',
  play_hot: '类型（可选）',
  play_index: '序号',
  favorite_to: '歌单名',
  sleep_timer: '时长（分钟或首数）',
}

const NO_INTENT_RE = /^(无关|无法判断|不能判断|不知道|未知|没有相关(指令)?|无相关(指令)?|none|unknown)[。.!！\s]*$/i
const NO_INTENT_LOOSE_RE = /无关|无法判断|不能判断|不知道|未知|没有相关|无相关/i

/** 明确的音乐名词：出现后直接交给 AI 判断，不受下面的非音乐词干扰 */
const STRONG_MUSIC_RE = /歌|曲|音乐|专辑|歌手|乐队|歌单|榜单|原声|ost|bgm|dj|[一二三四五六七八九十两\d]+\s*首/i
/** 与歌曲播放无关，且几乎不会出现在歌名里的场景词 */
const STRONG_NON_MUSIC_RE = /天气|新闻|广播|故事|笑话|相声|评书|小说|听书|有声书|广播剧|闹钟|提醒|会议|日程|翻译|视频|电影|电视|电视剧|综艺|课程|网课|讲座|asmr|快递|外卖|航班|机票|酒店|股票|基金|汇率|比特币|彩票|星座|运势|英语|数学|作业|限行|限号|空气质量|pm2\.5/i
/** 可能出现在歌名里的场景词：只有原话里没有播放动作时才视为点播之外的操作 */
const WEAK_NON_MUSIC_RE = /电话|导航|路线|路况|空调|窗帘|扫地|扫拖|净化器|加湿器|风扇|插座|灯|温度|湿度|时间|日期|几点|星期|附近|百科|计算|算一下|成语|单词|聊天|你是谁|你叫什么|下雨|下雪|气温|火车/i
/** 以“放/听”等开头的常见非音乐说法 */
const MISC_NON_MUSIC_RE = /放心|放假|放学|放屁|放盐|放糖|放油|放水|放风筝|放鞭炮|放烟花|听话/i
const PLAYER_ACTION_RE = /播放|放一下|放一|放首|放点|放个|来一首|来首|来点|我想听|想听|听听|听点|听首|听个|^听|^放|^播|给我放|帮我放|换一首|换首歌|切歌|下一首|上一首|暂停|继续播|恢复播放|停止播|静音|音量|声音[大小]|大声|小声|收藏|循环|随机|单曲|顺序播|定时|倒计时/i
const MUSIC_HINT_RE = /歌|曲|音乐|专辑|歌手|乐队|榜单|热歌|新歌|老歌|情歌|儿歌|童谣|dj|bgm|原声|ost|播放|放一下|放首|放点|放个|放一|来首|来点|来一|我想听|想听|听听|听点|听首|听个|听一|^听|^放|^播|给我放|帮我放|换一首|换首歌|切歌|下一首|上一首|暂停|继续播|恢复播放|停止播|静音|音量|声音[大小]|大声|小声|收藏|循环|随机|单曲|顺序播|轻音乐|纯音乐|摇滚|民谣|古风|爵士|古典|电子|说唱|好听|听的|定时|倒计时/i

const stripAnswer = (answer: string): string => {
  let text = String(answer || '')
    .replace(/```[a-z]*|```/gi, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) || ''
  text = text.replace(/^(好的|好|收到|明白)[，,。.!！\s]*/i, '')
  text = text.replace(/^(回复|口令|答案|输出)[：:\s]*/i, '')
  text = text.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
  return text.trim()
}

const cleanArgument = (value: string): string =>
  String(value || '')
    .replace(/^[\s:：|,，。.!！、]+/, '')
    .replace(/[\s。.!！,，;；]+$/, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .trim()

const unwrapCommands = (commands?: MiotVoiceCommand[]): MiotVoiceCommand[] => {
  if (commands === undefined) return getDefaultVoiceCommands()
  return Array.isArray(commands) ? commands : []
}

const groupCommands = (commands: MiotVoiceCommand[]): CommandGroup[] => {
  const groups: CommandGroup[] = []
  const index = new Map<string, number>()
  for (const command of commands) {
    if (!command || command.enabled === false) continue
    const keywords = (Array.isArray(command.keywords) ? command.keywords : [])
      .map(keyword => String(keyword).trim())
      .filter(Boolean)
    if (keywords.length === 0) continue
    const key = `${command.type}|${command.param || ''}`
    let position = index.get(key)
    if (position === undefined) {
      position = groups.length
      index.set(key, position)
      groups.push({ type: command.type, param: command.param, keywords: [] })
    }
    for (const keyword of keywords) {
      const existing = groups[position].keywords
      if (!existing.some(item => item.toLowerCase() === keyword.toLowerCase())) existing.push(keyword)
    }
  }
  return groups
}

const listLabels = (groups: CommandGroup[]): Set<string> => {
  const labels = new Set<string>()
  for (const group of groups) {
    for (const keyword of group.keywords) labels.add(keyword.toLowerCase())
  }
  return labels
}

const appendExtensionGroups = (groups: CommandGroup[]): CommandGroup[] => {
  const labels = listLabels(groups)
  const merged = [...groups]
  for (const group of AI_EXTENSION_GROUPS) {
    const missing = group.keywords.filter(keyword => !labels.has(keyword.toLowerCase()))
    if (missing.length === 0) continue
    merged.push({ ...group, keywords: missing })
    for (const keyword of missing) labels.add(keyword.toLowerCase())
  }
  return merged
}

const groupActionLabel = (group: CommandGroup): string => {
  if (group.type === 'set_play_mode') {
    return `切换播放模式（${PLAY_MODE_NAMES[group.param || ''] || group.param || '默认'}）`
  }
  if (group.type === 'favorite') return group.param === 'remove' ? '取消收藏' : '收藏当前歌曲'
  if (group.type.startsWith('dislike_')) {
    const action = COMMAND_ACTIONS[group.type] || group.type
    return group.param === 'remove' ? `取消${action}` : action
  }
  if (group.type === 'set_volume') {
    const label = group.param === 'up' ? '调大音量' : group.param === 'down' ? '调小音量' : '设置音量'
    return label
  }
  return COMMAND_ACTIONS[group.type] || group.type
}

const groupArgumentHint = (group: CommandGroup): string => {
  if (group.type === 'set_play_mode' || group.type === 'set_volume') return '无'
  if (group.type === 'play_random' || group.type === 'play_hot') return COMMAND_ARGUMENT_HINTS[group.type]
  return COMMAND_ARGUMENT_HINTS[group.type] || '无'
}

const buildCommandCatalog = (groups: CommandGroup[]): string => {
  const lines: string[] = ['口令表（只能使用下面的口令词）：']
  for (const group of groups) {
    const action = groupActionLabel(group)
    const hint = groupArgumentHint(group)
    const line = `${action} ｜ 口令词：${group.keywords.join('/')} ｜ 参数：${hint}`
    if (lines.join('\n').length + line.length + 1 > INTENT_COMMAND_CATALOG_MAX_LENGTH) break
    lines.push(line)
  }
  return lines.join('\n')
}

const firstKeyword = (groups: CommandGroup[], type: string, param?: string): string =>
  groups.find(group => group.type === type && (param === undefined || group.param === param))?.keywords[0] || ''

const buildExamples = (groups: CommandGroup[]): string => {
  const parts: string[] = []
  const song = firstKeyword(groups, 'play_song')
  if (song) parts.push(`我想听夜曲→${song}：夜曲`)
  const artist = firstKeyword(groups, 'play_artist')
  if (artist) parts.push(`放周杰伦→${artist}：周杰伦`)
  const random = firstKeyword(groups, 'play_random')
  if (random) parts.push(`来点摇滚→${random}：摇滚`)
  const next = firstKeyword(groups, 'next')
  if (next) parts.push(`下一首→${next}`)
  parts.push('今天天气怎么样→无关')
  return parts.length >= 2 ? `示例：${parts.join('；')}。` : ''
}

const buildIntentEntries = (commands?: MiotVoiceCommand[]): IntentEntry[] => {
  const groups = appendExtensionGroups(groupCommands(unwrapCommands(commands)))
  const entries: IntentEntry[] = []
  for (const group of groups) {
    for (const keyword of group.keywords) {
      entries.push({ label: keyword, lower: keyword.toLowerCase(), type: group.type, param: group.param })
    }
  }
  for (const [type, labels] of Object.entries(AI_EXTENSION_LABELS)) {
    for (const label of labels) {
      const lower = label.toLowerCase()
      if (entries.some(entry => entry.lower === lower)) continue
      entries.push({ label, lower, type })
    }
  }
  return entries
}

const findEntry = (text: string, entries: IntentEntry[]): { entry: IntentEntry; argument: string } | null => {
  const lower = text.toLowerCase()
  const separator = lower.search(/[|:：]/)
  if (separator >= 0) {
    const label = cleanArgument(lower.slice(0, separator))
    const argument = cleanArgument(text.slice(separator + 1))
    const exact = entries
      .filter(entry => entry.lower === label)
      .sort((a, b) => b.label.length - a.label.length)[0]
    if (exact) return { entry: exact, argument }
  }

  const prefix = entries
    .filter(entry => lower.startsWith(entry.lower))
    .sort((a, b) => b.label.length - a.label.length)[0]
  if (prefix) {
    return {
      entry: prefix,
      argument: cleanArgument(text.slice(prefix.label.length)),
    }
  }

  let earliest: { entry: IntentEntry; index: number } | null = null
  for (const entry of entries) {
    const index = lower.indexOf(entry.lower)
    if (index < 0) continue
    if (!earliest || index < earliest.index || (index === earliest.index && entry.label.length > earliest.entry.label.length)) {
      earliest = { entry, index }
    }
  }
  if (!earliest) return null
  return {
    entry: earliest.entry,
    argument: cleanArgument(text.slice(earliest.index + earliest.entry.label.length)),
  }
}

const normalizeArgument = (entry: IntentEntry, argument: string): string => {
  let value = cleanArgument(argument)
  if (entry.type === 'play_artist') value = value.replace(/的歌(曲)?$/, '').trim()
  if ((entry.type === 'play_random' || entry.type === 'play_hot') && /^(?:歌曲|音乐|歌)$/.test(value)) value = ''
  return value.slice(0, 40)
}

const CHART_VERB_RE = /^(?:请|帮我|给我)?(?:播放|放一下|放|来点|来首|听一下|听|我想听|我要听)?\s*/
const GENERIC_CHART_RE = /^(?:排行榜|榜单|榜|热门|热门榜单)$/

const chartArgument = (entry: IntentEntry, argument: string): string => {
  if (argument) return argument
  const derived = cleanArgument(entry.label.replace(CHART_VERB_RE, ''))
  return derived && !GENERIC_CHART_RE.test(derived) ? derived : '热歌榜'
}

export const parseIntentAnswer = (answer: string, commands?: MiotVoiceCommand[]): IntentParseResult => {
  const text = stripAnswer(answer)
  if (!text) return { intent: null, noIntent: false }
  if (NO_INTENT_RE.test(text)) return { intent: null, noIntent: true }

  const found = findEntry(text, buildIntentEntries(commands))
  if (!found) {
    if (NO_INTENT_LOOSE_RE.test(text)) return { intent: null, noIntent: true }
    return { intent: null, noIntent: false }
  }

  const { entry } = found
  let argument = normalizeArgument(entry, found.argument)
  if (entry.type === 'play_chart') argument = chartArgument(entry, argument)
  if (REQUIRED_ARGUMENT_TYPES.has(entry.type) && !argument) {
    return { intent: null, noIntent: true }
  }
  return {
    intent: {
      type: entry.type,
      argument: argument || undefined,
      param: entry.param,
    },
    noIntent: false,
  }
}

export const shouldAnalyzeIntent = (query: string, commands?: MiotVoiceCommand[]): boolean => {
  const text = String(query || '').trim()
  if (text.length < 2 || text.length > 40) return false
  if (text.includes(AI_INTENT_MARKER)) return false
  if (STRONG_MUSIC_RE.test(text)) return true

  const playerAction = PLAYER_ACTION_RE.test(text)
  if (MISC_NON_MUSIC_RE.test(text)) return false
  if (STRONG_NON_MUSIC_RE.test(text)) return false
  if (!playerAction && WEAK_NON_MUSIC_RE.test(text)) return false

  const lower = text.toLowerCase()
  for (const command of unwrapCommands(commands)) {
    if (!command || command.enabled === false) continue
    for (const keyword of command.keywords || []) {
      const label = String(keyword || '').trim().toLowerCase()
      if (label && lower.includes(label)) return true
    }
  }

  return MUSIC_HINT_RE.test(text)
}

export const sanitizeIntentQuery = (query: string): string =>
  String(query || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[“”"`]/g, '')
    .trim()
    .slice(0, 60)

export const DEFAULT_INTENT_PROMPT_TEMPLATE = `先判断用户原话是不是在操作歌曲或播放器（听歌、切歌、暂停/继续、音量、收藏、定时停止等具体你可以参考下面口令表）。
如果不是，只输出：无关。
如果是，从下面口令表中选一个口令词，改写成一行口令，格式为“口令词”或“口令词：参数”，参数只保留名称或数值本身；不执行、不解释、不闲聊。
{commands}
规则：
1. 具体歌名→播放歌曲；歌手名或“XX的歌”→播放歌手；歌单、收藏、列表名→播放歌单；XX榜、排行榜→播放榜单。
2. 只能使用口令表中出现的口令词，不要自创口令；口令表里没有对应功能时输出：无关。
3. 随机、随便听、来点歌→随机听歌，可带类型；热门、热歌→播放热门，可带类型。类型只能是：{types}，没有类型就留空。
4. 口令需要参数但原话没有给出时，不要猜测，输出：无关。
5. 天气、新闻、故事、闹钟、聊天、家电控制等与歌曲播放无关的内容→无关。
{examples}
只输出一行，不要加“好的”“为你播放”等任何回应。用户原话：{query}。口令：`

export const buildIntentPrompt = (query: string, template?: string, commands?: MiotVoiceCommand[]): string => {
  const text = sanitizeIntentQuery(query)
  const groups = appendExtensionGroups(groupCommands(unwrapCommands(commands)))
  const catalog = buildCommandCatalog(groups)
  const examples = buildExamples(groups)
  const custom = String(template || '').trim()
  const source = stripPromptMarker(custom || DEFAULT_INTENT_PROMPT_TEMPLATE, AI_INTENT_MARKER)
  const rendered = renderPromptTemplate(source, {
    query: text,
    types: AI_SONG_TYPES.join('、'),
    commands: catalog,
    examples,
  })
  let body = rendered.text.trim()
  if (!rendered.used.has('commands')) {
    const anchor = text ? body.lastIndexOf(text) : -1
    let insertAt = anchor
    if (anchor > 0) {
      const head = body.slice(0, anchor)
      const labels = ['用户原话', '用户说']
        .map(label => head.lastIndexOf(label))
        .filter(index => index >= 0)
      if (labels.length > 0) insertAt = Math.max(...labels)
    }
    const block = `\n${catalog}\n`
    body = insertAt >= 0
      ? `${body.slice(0, insertAt).trimEnd()}${block}${body.slice(insertAt)}`
      : `${body}\n${block}`
  }
  if (!rendered.used.has('query')) body = `${body}用户原话：${text}。口令：`
  return `${AI_INTENT_MARKER}：${body}`
}

export const formatIntent = (intent: MiotVoiceIntent): string => {
  const param = intent.argument || intent.param || ''
  return param ? `${intent.type}：${param}` : intent.type
}
