import type { LoginStateType } from './constants'
import type { MiotTokenInfo } from './types'

export interface LoginStep1Data {
  _sign?: string
  qs?: string
  callback?: string
  sid?: string
  [key: string]: unknown
}

export interface CaptchaResult {
  imageBase64: string
  ick: string
}

export interface AuthLoginResult {
  state: LoginStateType
  error?: string
  tokenInfo?: MiotTokenInfo
  captchaImage?: string
  verifyUrl?: string
  verifyType?: 'phone' | 'email'
}

export interface DeviceInfoRaw {
  deviceID: string
  serialNumber?: string
  name: string
  alias: string
  model: string
  modelName?: string
  mac?: string
  ssid?: string
  ip?: string
  hardware: string
  rom?: string
  presence: string
  miotDID: string
  deviceSNProfile?: string
}

export interface DeviceListResponse {
  code: number
  message: string
  data: DeviceInfoRaw[]
}

export interface UbusResponse {
  code: number
  message?: string
  data?: unknown
  sampledAt?: number
  [key: string]: unknown
}

export interface MusicSearchResponse {
  code: number
  data?: {
    songList?: Array<{
      audioID?: string | number
      songID?: string | number
      name?: string
      artist?: { name?: string }
    }>
  }
}

export interface ConversationRecord {
  time: number
  query: string
  answers: Array<{
    type: string
    tts?: { text: string }
    llm?: { text: string }
  }>
}

export interface ConversationData {
  records: ConversationRecord[]
}

export interface NlpResultData {
  code: number
  info?: string
}

export interface NlpInfoData {
  result: Array<{
    nlp?: string
    [key: string]: unknown
  }>
}

export interface NlpDetail {
  meta: {
    request_id: string
    timestamp: string
  }
  response: {
    answer: Array<{
      domain: string
      action: string
      content: { to_speak: string }
      intention: { query: string }
    }>
  }
}

export interface AskMessage {
  request_id?: string
  timestamp_ms: number
  response: {
    answer: Array<{
      domain?: string
      action?: string
      content?: string
      question?: string
    }>
  }
}

export interface MinaDevice {
  deviceID: string
  name: string
  miotDID: string
  model: string
  hardware: string
  alias: string
  presence: string
}
