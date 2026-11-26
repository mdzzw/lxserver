export const ACCOUNT_BASE_URL = 'https://account.xiaomi.com'
export const MINA_API_HOST = 'api2.mina.mi.com'
export const MINA_API_BASE_URL = `https://${MINA_API_HOST}`
export const MINA_SID = 'micoapi'
export const XIAOMI_IO_SID = 'xiaomiio'

export const USER_AGENT_TEMPLATE = 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-%s APP/xiaomi.smarthome APPV/62830'

export const DEFAULT_HTTP_TIMEOUT = 30000
export const SERVICE_TOKEN_VALID_HOURS = 12
export const TOKEN_REFRESH_THRESHOLD_HOURS = 3
export const MAX_REDIRECTS = 10
export const MAX_RETRIES = 3

export const LATEST_ASK_API_TEMPLATE = 'https://userprofile.mina.mi.com/device_profile/v2/conversation?source=dialogu&hardware=%s&timestamp=%d&limit=%l'

export const LoginState = {
  SUCCESS: 'success',
  NEED_CAPTCHA: 'need_captcha',
  NEED_VERIFY: 'need_verify',
  FAILED: 'failed',
} as const

export type LoginStateType = typeof LoginState[keyof typeof LoginState]

/** 这些型号不支持对话记录 HTTP API，需改用 ubus nlp_result_get */
export const GET_ASK_BY_MINA: string[] = ['M01']

/** 默认使用 player_play_music 接口的硬件型号（其余走 player_play_url） */
export const DEFAULT_MUSIC_API_MODELS: readonly string[] = [
  'X08C',
  'X08E',
  'X8S',
  'X8F',
  'X4B',
  'LX05',
  'OH11',
  'OH2',
  'OH2P',
  'X6A',
  'LX04',
  'L05B',
  'L05C',
  'LX06',
  'L06A',
  'X08A',
  'X10A',
  'L15A',
  'L16A',
  'L17A',
]

export const shouldUseMinaForAsk = (hardware: string): boolean => GET_ASK_BY_MINA.includes(hardware)

export const needUsePlayMusicAPI = (hardware: string): boolean => DEFAULT_MUSIC_API_MODELS.includes(hardware)

export const formatUserAgent = (deviceId: string): string => USER_AGENT_TEMPLATE.replace('%s', deviceId)

export const formatLatestAskUrl = (hardware: string, timestamp: number, limit = 2): string =>
  LATEST_ASK_API_TEMPLATE.replace('%s', hardware).replace('%d', String(timestamp)).replace('%l', String(limit))
