import fs from 'node:fs'
import path from 'node:path'
import {
  AI_DAILY_LIMIT_DEFAULT,
  AI_FAILURE_THRESHOLD_DEFAULT,
  AI_FAILURE_WINDOW_DEFAULT,
  AI_TYPE_CACHE_TTL_MS,
  normalizeAiDailyLimit,
  normalizeAiFailureThreshold,
  normalizeAiFailureWindow,
} from './aiConstants'
import { getDefaultVoiceCommands, migrateVoiceCommands, VOICE_COMMAND_DEFAULTS_REV } from './voiceDefaults'
import { miotLog } from './log'
import { normalizePromptTemplate } from './promptTemplate'
import type {
  MiotAccount,
  MiotAiError,
  MiotAiTypeCacheEntry,
  MiotDeviceConfig,
  MiotPlayMode,
  MiotSettings,
  MiotStoreData,
  MiotVoiceCommand,
} from './types'

const STORE_FILE = 'miot.json'

export const getDeviceKey = (accountId: string, deviceId: string) => `${accountId}:${deviceId}`

export const defaultMiotSettings = (): MiotSettings => ({
  enabled: true,
  username: '',
  quality: '320k',
  public_base_url: '',
  voice_enabled: true,
  poll_interval_sec: 2,
  auto_next: true,
  cache_on_play: false,
  vip_auto_download: false,
  default_playlist_id: 'default',
  keep_light: false,
  announce_song: false,
  ai_recommend_enabled: false,
  ai_daily_limit: AI_DAILY_LIMIT_DEFAULT,
  ai_failure_threshold: AI_FAILURE_THRESHOLD_DEFAULT,
  ai_failure_window_min: AI_FAILURE_WINDOW_DEFAULT,
  ai_intent_prompt: '',
  ai_classify_prompt: '',
})

const defaultData = (): MiotStoreData => ({
  version: 1,
  settings: defaultMiotSettings(),
  accounts: [],
  devices: [],
  playback: {},
  voice_commands: getDefaultVoiceCommands(),
  voice_commands_rev: VOICE_COMMAND_DEFAULTS_REV,
  ai_error: null,
  ai_types: {},
  ai_daily: { date: '', count: 0 },
})

export const normalizePlayMode = (mode: unknown): MiotPlayMode => {
  switch (mode) {
    case 'loop':
    case 'single':
    case 'singlePlay':
    case 'shuffle':
    case 'order':
      return mode
    case 'random':
      return 'shuffle'
    default:
      return 'order'
  }
}

export class MiotStore {
  private file: string | null = null
  private data: MiotStoreData = defaultData()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  private getFile(): string {
    if (!this.file) this.file = path.join(global.lx.dataPath, STORE_FILE)
    return this.file
  }

  load(): MiotStoreData {
    const file = this.getFile()
    let raw: Partial<MiotStoreData> | null = null
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err: any) {
      if (err?.code !== 'ENOENT') miotLog.warn('[MIoT] 读取配置失败，使用默认配置:', err?.message || err)
    }

    const base = defaultData()
    const savedCommands = Array.isArray(raw?.voice_commands)
      ? (raw!.voice_commands as MiotVoiceCommand[]).filter(item => item && typeof item.type === 'string' && Array.isArray(item.keywords))
      : null
    let voiceCommands = savedCommands ?? getDefaultVoiceCommands()
    let voiceCommandsRev = savedCommands ? 1 : VOICE_COMMAND_DEFAULTS_REV
    let commandsMigrated = false
    if (savedCommands) {
      const savedRev = Math.floor(Number(raw?.voice_commands_rev))
      if (Number.isFinite(savedRev) && savedRev > 0) voiceCommandsRev = savedRev
      const migration = migrateVoiceCommands(voiceCommands, voiceCommandsRev)
      voiceCommands = migration.commands
      voiceCommandsRev = migration.rev
      commandsMigrated = migration.changed
    }
    this.data = {
      version: 1,
      settings: { ...base.settings, ...(raw?.settings || {}) },
      accounts: Array.isArray(raw?.accounts) ? raw!.accounts as MiotAccount[] : [],
      devices: Array.isArray(raw?.devices) ? (raw!.devices as MiotDeviceConfig[]).map(d => ({
        ...d,
        managed: d.managed ?? true,
        voice_enabled: d.voice_enabled ?? true,
        volume: d.volume ?? 0,
        play_mode: normalizePlayMode(d.play_mode),
      })) : [],
      playback: raw?.playback && typeof raw.playback === 'object' ? raw.playback as MiotStoreData['playback'] : {},
      voice_commands: voiceCommands,
      voice_commands_rev: voiceCommandsRev,
      ai_error: raw?.ai_error && typeof raw.ai_error === 'object' && typeof raw.ai_error.message === 'string'
        ? raw.ai_error as MiotAiError
        : null,
      ai_types: raw?.ai_types && typeof raw.ai_types === 'object' ? raw.ai_types as Record<string, MiotAiTypeCacheEntry> : {},
      ai_daily: raw?.ai_daily && typeof raw.ai_daily === 'object' && typeof raw.ai_daily.date === 'string'
        ? { date: raw.ai_daily.date, count: Math.max(0, Number(raw.ai_daily.count) || 0) }
        : { date: '', count: 0 },
    }
    const cutoff = Date.now() - AI_TYPE_CACHE_TTL_MS
    for (const [key, entry] of Object.entries(this.data.ai_types || {})) {
      if (!entry || typeof entry.type !== 'string' || Number(entry.at) < cutoff) delete this.data.ai_types![key]
    }
    this.data.settings.poll_interval_sec = Math.max(1, Math.min(30, Number(this.data.settings.poll_interval_sec) || 2))
    this.data.settings.quality = String(this.data.settings.quality || '320k')
    this.data.settings.ai_daily_limit = normalizeAiDailyLimit(this.data.settings.ai_daily_limit)
    this.data.settings.ai_failure_threshold = normalizeAiFailureThreshold(this.data.settings.ai_failure_threshold)
    this.data.settings.ai_failure_window_min = normalizeAiFailureWindow(this.data.settings.ai_failure_window_min)
    this.data.settings.ai_intent_prompt = normalizePromptTemplate(this.data.settings.ai_intent_prompt)
    this.data.settings.ai_classify_prompt = normalizePromptTemplate(this.data.settings.ai_classify_prompt)
    if (commandsMigrated) this.save()
    return this.data
  }

  get(): MiotStoreData {
    if (!this.file) this.load()
    return this.data
  }

  save(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 500)
  }

  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    const file = this.getFile()
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.get(), null, 2), 'utf8')
      fs.renameSync(tmp, file)
    } catch (err: any) {
      miotLog.error('[MIoT] 保存配置失败:', err?.message || err)
    }
  }

  getSettings(): MiotSettings {
    return this.get().settings
  }

  updateSettings(patch: Partial<MiotSettings>): MiotSettings {
    const settings = this.get().settings
    if (patch.username !== undefined) settings.username = String(patch.username || '')
    if (patch.quality !== undefined) settings.quality = String(patch.quality || '320k')
    if (patch.public_base_url !== undefined) settings.public_base_url = String(patch.public_base_url || '').trim().replace(/\/+$/, '')
    if (patch.voice_enabled !== undefined) settings.voice_enabled = !!patch.voice_enabled
    if (patch.poll_interval_sec !== undefined) settings.poll_interval_sec = Math.max(1, Math.min(30, Number(patch.poll_interval_sec) || 2))
    if (patch.auto_next !== undefined) settings.auto_next = !!patch.auto_next
    if (patch.cache_on_play !== undefined) settings.cache_on_play = !!patch.cache_on_play
    if (patch.vip_auto_download !== undefined) settings.vip_auto_download = !!patch.vip_auto_download
    if (patch.default_playlist_id !== undefined) settings.default_playlist_id = String(patch.default_playlist_id || 'default')
    if (patch.keep_light !== undefined) settings.keep_light = !!patch.keep_light
    if (patch.announce_song !== undefined) settings.announce_song = !!patch.announce_song
    if (patch.ai_recommend_enabled !== undefined) settings.ai_recommend_enabled = !!patch.ai_recommend_enabled
    if (patch.ai_daily_limit !== undefined) settings.ai_daily_limit = normalizeAiDailyLimit(patch.ai_daily_limit)
    if (patch.ai_failure_threshold !== undefined) settings.ai_failure_threshold = normalizeAiFailureThreshold(patch.ai_failure_threshold)
    if (patch.ai_failure_window_min !== undefined) settings.ai_failure_window_min = normalizeAiFailureWindow(patch.ai_failure_window_min)
    if (patch.ai_intent_prompt !== undefined) settings.ai_intent_prompt = normalizePromptTemplate(patch.ai_intent_prompt)
    if (patch.ai_classify_prompt !== undefined) settings.ai_classify_prompt = normalizePromptTemplate(patch.ai_classify_prompt)
    if (patch.enabled !== undefined) settings.enabled = !!patch.enabled
    this.save()
    return settings
  }

  upsertAccount(account: MiotAccount): void {
    const accounts = this.get().accounts
    const index = accounts.findIndex(item => item.id === account.id)
    if (index >= 0) accounts[index] = account
    else accounts.push(account)
    this.save()
  }

  removeAccount(accountId: string): void {
    const data = this.get()
    data.accounts = data.accounts.filter(item => item.id !== accountId)
    data.devices = data.devices.filter(item => item.account_id !== accountId)
    for (const key of Object.keys(data.playback)) {
      if (data.playback[key]?.account_id === accountId) delete data.playback[key]
    }
    this.save()
  }

  getAccount(accountId: string): MiotAccount | undefined {
    return this.get().accounts.find(item => item.id === accountId)
  }

  getAccounts(): MiotAccount[] {
    return this.get().accounts
  }

  getDevices(accountId?: string): MiotDeviceConfig[] {
    const devices = this.get().devices
    return accountId ? devices.filter(item => item.account_id === accountId) : devices
  }

  getDevice(accountId: string, deviceId: string): MiotDeviceConfig | undefined {
    return this.get().devices.find(item => item.account_id === accountId && item.device_id === deviceId)
  }

  upsertDevice(device: MiotDeviceConfig): void {
    const devices = this.get().devices
    const index = devices.findIndex(item => item.account_id === device.account_id && item.device_id === device.device_id)
    if (index >= 0) devices[index] = { ...devices[index], ...device }
    else devices.push(device)
    this.save()
  }

  updateDevice(accountId: string, deviceId: string, patch: Partial<MiotDeviceConfig>): MiotDeviceConfig | undefined {
    const device = this.getDevice(accountId, deviceId)
    if (!device) return undefined
    Object.assign(device, patch)
    if (patch.play_mode) device.play_mode = normalizePlayMode(patch.play_mode)
    this.save()
    return device
  }

  removeDevice(accountId: string, deviceId: string): void {
    const data = this.get()
    data.devices = data.devices.filter(item => !(item.account_id === accountId && item.device_id === deviceId))
    delete data.playback[getDeviceKey(accountId, deviceId)]
    this.save()
  }

  getPlayback(accountId: string, deviceId: string) {
    return this.get().playback[getDeviceKey(accountId, deviceId)]
  }

  setPlayback(accountId: string, deviceId: string, playback: MiotStoreData['playback'][string]): void {
    this.get().playback[getDeviceKey(accountId, deviceId)] = playback
    this.save()
  }

  removePlayback(accountId: string, deviceId: string): void {
    delete this.get().playback[getDeviceKey(accountId, deviceId)]
    this.save()
  }

  getVoiceCommands(): MiotVoiceCommand[] {
    return this.get().voice_commands
  }

  updateVoiceCommands(commands: MiotVoiceCommand[]): MiotVoiceCommand[] {
    const data = this.get()
    if (Array.isArray(commands)) {
      data.voice_commands = commands
        .filter(item => item && typeof item.type === 'string' && Array.isArray(item.keywords))
        .map(item => ({
          type: item.type,
          keywords: item.keywords.map(keyword => String(keyword).trim()).filter(Boolean),
          param: item.param,
          enabled: item.enabled !== false,
        }))
        .filter(item => item.keywords.length > 0)
    }
    this.save()
    return data.voice_commands
  }

  // ===== AI 推荐状态 =====

  getAiError(): MiotAiError | null {
    return this.get().ai_error ?? null
  }

  setAiError(error: MiotAiError): void {
    this.get().ai_error = error
    this.save()
  }

  clearAiError(): void {
    this.get().ai_error = null
    this.save()
  }

  getSongType(cacheKey: string): string {
    const entry = this.get().ai_types?.[cacheKey]
    if (!entry) return ''
    if (entry.at < Date.now() - AI_TYPE_CACHE_TTL_MS) {
      delete this.get().ai_types![cacheKey]
      this.save()
      return ''
    }
    return entry.type
  }

  setSongType(cacheKey: string, type: string): void {
    const data = this.get()
    if (!data.ai_types) data.ai_types = {}
    data.ai_types[cacheKey] = { type, at: Date.now() }
    this.save()
  }

  getAiTypeCount(): number {
    return Object.keys(this.get().ai_types || {}).length
  }

  getAiDailyCount(): { date: string; count: number } {
    const daily = this.get().ai_daily
    const today = new Date().toISOString().slice(0, 10)
    if (!daily || daily.date !== today) return { date: today, count: 0 }
    return daily
  }

  /** 先占额度再调用 AI，避免失败时被反复重试打爆配额 */
  bumpAiDaily(limit = AI_DAILY_LIMIT_DEFAULT): { allowed: boolean; count: number } {
    const data = this.get()
    const today = new Date().toISOString().slice(0, 10)
    if (!data.ai_daily || data.ai_daily.date !== today) data.ai_daily = { date: today, count: 0 }
    if (data.ai_daily.count >= limit) return { allowed: false, count: data.ai_daily.count }
    data.ai_daily.count += 1
    this.save()
    return { allowed: true, count: data.ai_daily.count }
  }
}
