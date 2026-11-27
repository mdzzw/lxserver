import type { LocalTrack } from '@/server/music/subsonicLocal'

export interface MiotServiceToken {
  service_token: string
  ssecurity: string
  expires_at: number
}

export interface MiotTokenInfo {
  user_id: string
  device_id: string
  services: Record<string, MiotServiceToken>
  created_at: string
  expires_at: string
}

export interface MiotAccount {
  id: string
  username: string
  user_id: string
  device_id: string
  pass_token: string
  token_info: MiotTokenInfo
  created_at: number
  last_login_at: number
}

export type MiotPlayMode = 'order' | 'loop' | 'single' | 'singlePlay' | 'shuffle'

export interface MiotDeviceConfig {
  account_id: string
  device_id: string
  name: string
  alias: string
  model: string
  hardware: string
  miot_did: string
  presence: string
  managed: boolean
  voice_enabled: boolean
  volume: number
  play_mode: MiotPlayMode
  last_selected_at: number
}

export interface MiotSettings {
  enabled: boolean
  username: string
  quality: string
  public_base_url: string
  voice_enabled: boolean
  poll_interval_sec: number
  auto_next: boolean
  cache_on_play: boolean
  vip_auto_download: boolean
  default_playlist_id: string
  keep_light: boolean
  announce_song: boolean
  ai_recommend_enabled: boolean
  ai_daily_limit: number
  ai_failure_threshold: number
  ai_failure_window_min: number
  ai_intent_prompt: string
  ai_classify_prompt: string
}

export interface MiotAiError {
  message: string
  at: number
  account_id?: string
  device_id?: string
  device_name?: string
}

export interface MiotAiTypeCacheEntry {
  type: string
  at: number
}

export interface MiotAiState {
  enabled: boolean
  error: MiotAiError | null
  cachedTypes: number
  dailyCount: number
  dailyLimit: number
}

export interface PersistedPlayback {
  account_id: string
  device_id: string
  list_id: string
  list_name: string
  songs: any[]
  index: number
  mode: MiotPlayMode
  updated_at: number
}

export interface MiotStoreData {
  version: number
  settings: MiotSettings
  accounts: MiotAccount[]
  devices: MiotDeviceConfig[]
  playback: Record<string, PersistedPlayback>
  voice_commands: MiotVoiceCommand[]
  voice_commands_rev?: number
  ai_error?: MiotAiError | null
  ai_types?: Record<string, MiotAiTypeCacheEntry>
  ai_daily?: { date: string; count: number }
}

export interface MiotDeviceInfo {
  accountId: string
  accountName: string
  deviceId: string
  name: string
  alias: string
  model: string
  hardware: string
  miotDID: string
  presence: string
  managed: boolean
  voiceEnabled: boolean
  volume: number
  playMode: MiotPlayMode
  lastSelectedAt: number
}

export type MiotPlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error'

export interface MiotPlaybackView {
  accountId: string
  deviceId: string
  status: MiotPlayerStatus
  listId: string
  listName: string
  index: number
  song: MiotSong | null
  songs: MiotSong[]
  mode: MiotPlayMode
  position: number
  duration: number
  volume: number
  startedAt: number
  updatedAt: number
  error?: string
  sleepAt: number
  sleepRemaining: number
  sleepMode: 'time' | 'songs'
  autoRecommend?: boolean
  recommendType?: string
}

export interface MiotSong {
  id: string
  name: string
  singer: string
  source: string
  interval?: string
  vip?: boolean
  meta?: any
  types?: any[]
  _types?: any[]
  quality?: string
  [key: string]: any
}

export interface MiotPlaylistInfo {
  id: string
  name: string
  count: number
  source?: string
  builtin: boolean
}

export interface MiotDevicePlayState {
  status: number
  position: number
  duration: number
  hasPosition: boolean
}

/** timeout 表示云端未拿到设备回执（3012），不能据此判定音源不可播放 */
export type MiotPlayCommandResult = 'ok' | 'timeout' | 'failed'

export interface MiotDeviceController {
  playUrl(accountId: string, deviceId: string, url: string, meta: { title: string; artist?: string }): Promise<MiotPlayCommandResult>
  pause(accountId: string, deviceId: string): Promise<'paused' | 'stopped' | 'failed'>
  resume(accountId: string, deviceId: string): Promise<boolean>
  stop(accountId: string, deviceId: string): Promise<boolean>
  getPlayState(accountId: string, deviceId: string): Promise<MiotDevicePlayState | null>
  readVolume(accountId: string, deviceId: string): Promise<number>
  setVolume(accountId: string, deviceId: string, volume: number): Promise<boolean>
  textToSpeech(accountId: string, deviceId: string, text: string): Promise<boolean | null>
}

export interface MiotStreamTicket {
  token: string
  accountId: string
  deviceId: string
  song: MiotSong
  username: string
  quality: string
  kind: 'local' | 'cache' | 'remote'
  localTrack?: LocalTrack
  filename?: string
  folder?: 'cache' | 'music'
  remoteUrl?: string
  createdAt: number
  expiresAt: number
  lastAccessAt: number
}

export interface MiotVoiceCommand {
  type: string
  keywords: string[]
  param?: string
  enabled: boolean
}

export interface MiotVoiceMessage {
  account_id: string
  device_id: string
  device_name: string
  timestamp_ms: number
  question: string
  answer: string
  answer_label?: string
  received_at: number
  executed: boolean
  command?: string
  note?: string
}

export interface MiotVoiceTestResult {
  matched: boolean
  command?: string
  keyword?: string
  argument?: string
  note?: string
  executed?: boolean
  skipResume?: boolean
}

export interface MiotLoginResult {
  state: 'success' | 'need_captcha' | 'need_verify' | 'failed'
  loginId?: string
  accountId?: string
  captchaImage?: string
  verifyUrl?: string
  verifyType?: 'phone' | 'email'
  error?: string
}
