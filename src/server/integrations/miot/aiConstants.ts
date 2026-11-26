export const AI_SONG_TYPES = [
  '儿歌',
  '流行',
  '摇滚',
  '民谣',
  '古风',
  '说唱',
  '电子',
  '爵士',
  '古典',
  '纯音乐',
  '其他',
] as const

export type MiotSongType = typeof AI_SONG_TYPES[number]

export const AI_TYPE_CACHE_TTL_MS = 30 * 24 * 3600 * 1000
export const AI_DAILY_LIMIT_DEFAULT = 60
export const AI_DAILY_LIMIT_MIN = 1
export const AI_DAILY_LIMIT_MAX = 200

export const normalizeAiDailyLimit = (value: unknown): number => {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number)) return AI_DAILY_LIMIT_DEFAULT
  return Math.max(AI_DAILY_LIMIT_MIN, Math.min(AI_DAILY_LIMIT_MAX, number))
}

export const AI_FAILURE_THRESHOLD_DEFAULT = 3
export const AI_FAILURE_THRESHOLD_MIN = 1
export const AI_FAILURE_THRESHOLD_MAX = 10
export const AI_FAILURE_WINDOW_DEFAULT = 10
export const AI_FAILURE_WINDOW_MIN = 1
export const AI_FAILURE_WINDOW_MAX = 60

export const normalizeAiFailureThreshold = (value: unknown): number => {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number)) return AI_FAILURE_THRESHOLD_DEFAULT
  return Math.max(AI_FAILURE_THRESHOLD_MIN, Math.min(AI_FAILURE_THRESHOLD_MAX, number))
}

export const normalizeAiFailureWindow = (value: unknown): number => {
  const number = Math.floor(Number(value))
  if (!Number.isFinite(number)) return AI_FAILURE_WINDOW_DEFAULT
  return Math.max(AI_FAILURE_WINDOW_MIN, Math.min(AI_FAILURE_WINDOW_MAX, number))
}

export const AI_CLASSIFY_TIMEOUT_MS = 25000
export const AI_CLASSIFY_POLL_MS = 900
export const AI_INTENT_TIMEOUT_MS = 8000
export const AI_INTENT_POLL_MS = 700

/** 内部询问前缀：语音监听据此跳过口令匹配，避免把 AI 提问当用户指令执行 */
export const AI_CLASSIFY_MARKER = '歌曲类型判断'
export const AI_INTENT_MARKER = '指令解析'

export const isAiInternalQuery = (query: string): boolean => {
  const text = String(query || '')
  return text.includes(AI_CLASSIFY_MARKER) || text.includes(AI_INTENT_MARKER)
}
