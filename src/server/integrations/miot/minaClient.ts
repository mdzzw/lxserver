import { CookieJar, fetchWithRedirects } from './http'
import { generateDeviceId, generateRequestId } from './crypto'
import {
  MINA_API_BASE_URL,
  MINA_SID,
  MAX_RETRIES,
  SERVICE_TOKEN_VALID_HOURS,
  formatLatestAskUrl,
  formatUserAgent,
  needUsePlayMusicAPI,
  shouldUseMinaForAsk,
} from './constants'
import { miotLog } from './log'
import type {
  AskMessage,
  ConversationData,
  DeviceInfoRaw,
  DeviceListResponse,
  MinaDevice,
  NlpDetail,
  NlpInfoData,
  NlpResultData,
  UbusResponse,
} from './models'
import type { MiotPlayCommandResult, MiotTokenInfo } from './types'

const DEFAULT_MUSIC_AUDIO_ID = '1732418460076477549'
const MUSIC_CP_ID = '355454500'

const PLAY_STATUS_PLAYING = 1
/** 云端“远程控制超时”：设备可能已收到指令，不能据此判定播放失败 */
const CONTROL_TIMEOUT_CODE = 3012
const PAUSE_VERIFY_ATTEMPTS = 2
const PAUSE_VERIFY_DELAY_MS = 700

const UBUS_TIMEOUT_MS = 5000
const STATUS_INTERVAL_MS = 5000
const STATUS_MIN_INTERVAL_MS = 3000
const STATUS_TAIL_INTERVAL_MS = 1000
const STATUS_TAIL_FAST_QUERIES = 4
const STATUS_FAILURE_DELAYS_MS = [5000, 60000, 300000, 600000]

export interface StatusQueryOptions {
  verify?: boolean
  maxAgeMs?: number
  tail?: boolean
}

interface StatusQuery {
  revision: number
  failures: number
  nextAt: number
  tailFastQueries: number
  sample?: { revision: number; result: UbusResponse; at: number }
  inflight?: { revision: number; promise: Promise<UbusResponse | null> }
}

interface UbusTask {
  status: boolean
  run: () => Promise<UbusResponse | null>
  resolve: (value: UbusResponse | null) => void
  reject: (reason: unknown) => void
}

interface UbusQueue {
  running: boolean
  tasks: UbusTask[]
}

const summarize = (value: unknown, maxLength = 600): string => {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.length > maxLength ? `${text.slice(0, maxLength)}...(truncated)` : text
  } catch {
    return String(value)
  }
}

/**
 * 小爱音箱 UBus / 对话记录 API 客户端。
 * 包含按设备的请求队列、播放状态采样缓存和 401 自动刷新 token。
 */
export class MinaHTTPClient {
  private tokenInfo: MiotTokenInfo
  private userAgent: string
  private onTokenExpired?: () => Promise<boolean>
  private ubusQueues = new Map<string, UbusQueue>()
  private statusQueries = new Map<string, StatusQuery>()

  constructor(tokenInfo: MiotTokenInfo, onTokenExpired?: () => Promise<boolean>) {
    this.tokenInfo = tokenInfo
    this.userAgent = formatUserAgent(tokenInfo.device_id)
    this.onTokenExpired = onTokenExpired
  }

  static fromManualToken(userId: string, serviceToken: string, ssecurity = ''): MinaHTTPClient {
    const deviceId = generateDeviceId()
    const now = new Date()
    const expiresAt = now.getTime() + SERVICE_TOKEN_VALID_HOURS * 3600 * 1000
    return new MinaHTTPClient({
      user_id: userId,
      device_id: deviceId,
      services: {
        [MINA_SID]: { service_token: serviceToken, ssecurity, expires_at: expiresAt },
      },
      created_at: now.toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
    })
  }

  getTokenInfo(): MiotTokenInfo {
    return this.tokenInfo
  }

  updateTokenInfo(info: MiotTokenInfo): void {
    this.tokenInfo = info
    this.userAgent = formatUserAgent(info.device_id)
  }

  setOnTokenExpired(fn: () => Promise<boolean>): void {
    this.onTokenExpired = fn
  }

  isTokenValid(): boolean {
    if (!this.tokenInfo || !this.tokenInfo.user_id) return false
    const service = this.tokenInfo.services[MINA_SID]
    if (!service || !service.service_token) return false
    if (service.expires_at && Date.now() > service.expires_at) return false
    return true
  }

  async getDeviceList(): Promise<MinaDevice[]> {
    const result = await this.doGetRequest<DeviceListResponse>(`${MINA_API_BASE_URL}/admin/v2/device_list?master=1`)
    if (!result || result.code !== 0 || !result.data) return []
    return result.data.map((device: DeviceInfoRaw) => ({
      deviceID: device.deviceID,
      name: device.name,
      miotDID: device.miotDID,
      model: device.model,
      hardware: device.hardware,
      alias: device.alias,
      presence: device.presence,
    }))
  }

  async playByUrl(
    deviceId: string,
    url: string,
    hardware = '',
    keepLight = false,
    current?: () => boolean,
  ): Promise<MiotPlayCommandResult> {
    const useMusicAPI = hardware ? needUsePlayMusicAPI(hardware) : false
    miotLog.info(`[MIoT] play device=${deviceId} hardware=${hardware} musicAPI=${useMusicAPI} keepLight=${keepLight} url=${url.slice(0, 160)}`)
    if (useMusicAPI) return this.playByMusicURL(deviceId, url, keepLight, current)
    return this.playURL(deviceId, url, keepLight, current)
  }

  async playURL(deviceId: string, url: string, keepLight = false, current?: () => boolean): Promise<MiotPlayCommandResult> {
    const message = { url, type: keepLight ? 1 : 2, media: 'app_ios' }
    const result = await this.ubusRequest(deviceId, 'player_play_url', 'mediaplayer', message, 'play-url', current, true)
    return this.evaluatePlayResult(result, 'player_play_url')
  }

  async playByMusicURL(
    deviceId: string,
    audioUrl: string,
    keepLight = false,
    current?: () => boolean,
    audioId = DEFAULT_MUSIC_AUDIO_ID,
  ): Promise<MiotPlayCommandResult> {
    const music = {
      payload: {
        audio_type: keepLight ? 'MUSIC' : '',
        audio_items: [{
          item_id: {
            audio_id: audioId,
            cp: {
              album_id: '-1',
              episode_index: 0,
              id: MUSIC_CP_ID,
              name: 'xiaowei',
            },
          },
          stream: { url: audioUrl },
        }],
        list_params: {
          listId: '-1',
          loadmore_offset: 0,
          origin: 'xiaowei',
          type: 'MUSIC',
        },
      },
      play_behavior: 'REPLACE_ALL',
    }
    const message = {
      startaudioid: audioId,
      music: JSON.stringify(music),
    }
    const result = await this.ubusRequest(deviceId, 'player_play_music', 'mediaplayer', message, 'play-music', current, true)
    return this.evaluatePlayResult(result, 'player_play_music')
  }

  private async playerOperation(deviceId: string, action: 'play' | 'pause' | 'stop', current?: () => boolean): Promise<boolean> {
    const result = await this.ubusRequest(deviceId, 'player_play_operation', 'mediaplayer', { action, media: 'app_ios' }, `play-op:${action}`, current)
    if (current?.() === false) return false
    return this.isDeviceResultOK(result, `player_play_operation:${action}`)
  }

  async playerPlay(deviceId: string, current?: () => boolean): Promise<boolean> {
    return this.playerOperation(deviceId, 'play', current)
  }

  async playerPause(deviceId: string, current?: () => boolean): Promise<boolean> {
    return this.playerOperation(deviceId, 'pause', current)
  }

  /**
   * 部分型号在流播放时接受 pause 但音频继续，连续两次回读仍为 playing 时升级为 stop。
   */
  async playerPauseVerified(deviceId: string, current?: () => boolean): Promise<'paused' | 'stopped' | 'failed'> {
    const pauseOK = await this.playerPause(deviceId, current)
    for (let i = 0; i < PAUSE_VERIFY_ATTEMPTS; i++) {
      await new Promise(resolve => setTimeout(resolve, PAUSE_VERIFY_DELAY_MS))
      if (current?.() === false) return 'failed'
      if (await this.readPlayStatus(deviceId) !== PLAY_STATUS_PLAYING) return 'paused'
    }
    miotLog.warn(`[MIoT] pause ignored by device=${deviceId}, escalating to stop`)
    if (await this.playerOperation(deviceId, 'stop', current)) return 'stopped'
    return pauseOK ? 'paused' : 'failed'
  }

  async playerResume(deviceId: string, current?: () => boolean): Promise<boolean> {
    return this.playerPlay(deviceId, current)
  }

  /** 部分型号必须 pause → stop 才能真正停止 */
  async playerStop(deviceId: string, current?: () => boolean): Promise<boolean> {
    await this.playerPause(deviceId, current)
    return this.playerOperation(deviceId, 'stop', current)
  }

  async readPlayStatus(deviceId: string): Promise<number> {
    const raw = await this.getPlayerStatus(deviceId, { verify: true })
    const info = (raw?.data as { info?: unknown } | undefined)?.info
    if (typeof info !== 'string') return -1
    try {
      const parsed = JSON.parse(info) as { status?: unknown }
      return typeof parsed.status === 'number' ? parsed.status : -1
    } catch {
      return -1
    }
  }

  async setVolume(deviceId: string, volume: number): Promise<boolean> {
    const value = Math.max(0, Math.min(100, Math.floor(volume)))
    return (await this.ubusRequest(deviceId, 'player_set_volume', 'mediaplayer', { volume: value })) !== null
  }

  async getVolume(deviceId: string): Promise<number> {
    const result = await this.getPlayerStatus(deviceId, { verify: true })
    const data = result?.data
    if (data && typeof data === 'object') {
      const info = (data as Record<string, unknown>).info
      if (typeof info === 'string') {
        try {
          const parsed = JSON.parse(info) as { volume?: unknown }
          if (typeof parsed.volume === 'number') return parsed.volume
        } catch { /* ignore */ }
      }
    }
    return -1
  }

  /**
   * mibrain/text_to_speech 优先，失败回退 mediaplayer/player_play_tts。
   * 返回 null 表示回执超时（3012），设备可能已播出，调用方不得重发。
   */
  async textToSpeech(deviceId: string, text: string, current?: () => boolean): Promise<boolean | null> {
    if (current?.() === false) return false
    const message = { text }

    const primary = await this.ubusRequest(deviceId, 'text_to_speech', 'mibrain', message, 'tts:mibrain', current, true)
    const primaryResult = this.ttsAcceptance(primary)
    if (primaryResult === null) return null
    if (primaryResult) return true

    const fallback = await this.ubusRequest(deviceId, 'player_play_tts', 'mediaplayer', message, 'tts:mediaplayer', current, true)
    const fallbackResult = this.ttsAcceptance(fallback)
    if (fallbackResult === null) return null
    if (fallbackResult) return true

    miotLog.warn(`[MIoT] TTS failed on all endpoints device=${deviceId} textLength=${text.length}`)
    return false
  }

  private ttsAcceptance(result: UbusResponse | null): boolean | null {
    if (!result) return false
    let deviceData: unknown = result.data && typeof result.data === 'object'
      ? (result.data as Record<string, unknown>).device_data
      : undefined
    if (typeof deviceData === 'string') {
      try { deviceData = JSON.parse(deviceData) } catch { deviceData = undefined }
    }
    const deviceCode = deviceData && typeof deviceData === 'object'
      ? Number((deviceData as Record<string, unknown>).code)
      : NaN
    if ((result.code === 0 || result.code === 101) && deviceCode === 3012) return null
    return result.code === 0 && this.isDeviceResultOK(result, 'tts') && (Number.isNaN(deviceCode) || deviceCode === 0)
  }

  async getLatestAskFromXiaoai(deviceId: string, hardware: string, limit = 2): Promise<AskMessage[] | null> {
    if (shouldUseMinaForAsk(hardware)) return this.getLatestAskByUbus(deviceId)

    const timestamp = Date.now()
    const apiUrl = formatLatestAskUrl(hardware, timestamp, limit)
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const messages = await this.doGetLatestAskFromXiaoai(deviceId, apiUrl)
      if (messages !== null) return messages
    }
    return null
  }

  async getPlayerStatus(deviceId: string, options: StatusQueryOptions = {}): Promise<UbusResponse | null> {
    const query = this.getStatusQuery(deviceId)
    if (query.inflight?.revision === query.revision) return query.inflight.promise
    const fastTail = options.tail === true && !options.verify && query.tailFastQueries < STATUS_TAIL_FAST_QUERIES
    const maxAgeMs = fastTail ? STATUS_TAIL_INTERVAL_MS : Number.isFinite(options.maxAgeMs)
      ? Math.max(STATUS_MIN_INTERVAL_MS, Math.min(STATUS_INTERVAL_MS, options.maxAgeMs as number))
      : STATUS_INTERVAL_MS
    const nextAt = () => query.failures === 0 && query.sample?.revision === query.revision
      ? Math.min(query.nextAt, query.sample.at + maxAgeMs)
      : query.nextAt
    if (!options.verify && Date.now() < nextAt()) {
      return query.sample?.revision === query.revision && Date.now() - query.sample.at < maxAgeMs
        ? query.sample.result
        : null
    }

    const revision = query.revision
    const promise = this.enqueueUbus(deviceId, true, async () => {
      if (revision !== query.revision || (!options.verify && Date.now() < nextAt())) return null
      if (fastTail && Date.now() < query.nextAt) query.tailFastQueries++
      let result: UbusResponse | null = null
      try {
        result = await this.doUbusRequest(deviceId, 'player_get_play_status', 'mediaplayer', {})
        const info = JSON.parse(((result?.data as { info?: string } | undefined)?.info) || '{}') as { status?: unknown }
        if (typeof info.status !== 'number' || !Number.isFinite(info.status) || info.status < 0) result = null
      } catch {
        result = null
      }
      if (revision !== query.revision) return null
      if (result) {
        result = { ...result, sampledAt: Date.now() }
        query.sample = { revision, result, at: Date.now() }
      } else {
        query.sample = undefined
      }
      query.failures = result ? 0 : query.failures + 1
      const delay = result ? STATUS_INTERVAL_MS
        : STATUS_FAILURE_DELAYS_MS[Math.min(query.failures - 1, STATUS_FAILURE_DELAYS_MS.length - 1)]
      query.nextAt = Date.now() + delay
      if (!result) miotLog.warn(`[MIoT] status unavailable device=${deviceId} failures=${query.failures} retryInMs=${delay}`)
      return result
    }).finally(() => {
      if (query.inflight?.promise === promise) query.inflight = undefined
    })
    query.inflight = { revision, promise }
    return promise
  }

  private getStatusQuery(deviceId: string): StatusQuery {
    let query = this.statusQueries.get(deviceId)
    if (!query) {
      query = { revision: 0, failures: 0, nextAt: 0, tailFastQueries: 0 }
      this.statusQueries.set(deviceId, query)
    }
    return query
  }

  async validateToken(): Promise<boolean> {
    try {
      const result = await this.doGetRequest<DeviceListResponse>(`${MINA_API_BASE_URL}/admin/v2/device_list?master=1`)
      return result !== null && result.code === 0
    } catch {
      return false
    }
  }

  private buildApiCookies(): string {
    const service = this.tokenInfo.services[MINA_SID]
    if (!service) return ''
    return [
      `userId=${this.tokenInfo.user_id}`,
      `serviceToken=${service.service_token}`,
      'channel=MI_APP_STORE',
    ].join('; ')
  }

  async ubusRequest(
    deviceId: string,
    method: string,
    path: string,
    message: Record<string, unknown>,
    logLabel = '',
    current?: () => boolean,
    preserveErrors = false,
  ): Promise<UbusResponse | null> {
    if (method === 'player_get_play_status') return this.getPlayerStatus(deviceId)
    const query = this.getStatusQuery(deviceId)
    query.revision++
    query.tailFastQueries = 0
    return this.enqueueUbus(deviceId, false, () => current?.() === false
      ? Promise.resolve(null)
      : this.doUbusRequest(deviceId, method, path, message, logLabel, current, preserveErrors))
  }

  private enqueueUbus(deviceId: string, status: boolean, run: UbusTask['run']): Promise<UbusResponse | null> {
    let queue = this.ubusQueues.get(deviceId)
    if (!queue) {
      queue = { running: false, tasks: [] }
      this.ubusQueues.set(deviceId, queue)
    }
    const pending = new Promise<UbusResponse | null>((resolve, reject) => {
      queue!.tasks.push({ status, run, resolve, reject })
    })
    void this.drainUbus(deviceId, queue)
    return pending
  }

  private async drainUbus(deviceId: string, queue: UbusQueue): Promise<void> {
    if (queue.running) return
    queue.running = true
    try {
      while (queue.tasks.length) {
        const controlIndex = queue.tasks.findIndex(task => !task.status)
        const [task] = queue.tasks.splice(controlIndex < 0 ? 0 : controlIndex, 1)
        try {
          task.resolve(await task.run())
        } catch (error) {
          task.reject(error)
        }
      }
    } finally {
      queue.running = false
      if (this.ubusQueues.get(deviceId) === queue) this.ubusQueues.delete(deviceId)
    }
  }

  private async doUbusRequest(
    deviceId: string,
    method: string,
    path: string,
    message: Record<string, unknown>,
    logLabel = '',
    current?: () => boolean,
    preserveErrors = false,
  ): Promise<UbusResponse | null> {
    const formParams: Record<string, string> = {
      deviceId,
      method,
      path,
      message: JSON.stringify(message),
      requestId: generateRequestId(),
    }
    const body = Object.entries(formParams)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&')

    const result = await this.doPostRequest<UbusResponse>(`${MINA_API_BASE_URL}/remote/ubus`, body, logLabel, undefined, UBUS_TIMEOUT_MS, current)
    if (result === null) {
      if (logLabel) miotLog.warn(`[MIoT] ${logLabel} ubus request failed device=${deviceId} method=${method}`)
      return null
    }
    if (result.code !== 0) {
      if (logLabel) miotLog.warn(`[MIoT] ${logLabel} ubus code=${result.code} message=${result.message ?? ''} data=${summarize(result.data)}`)
      return preserveErrors ? result : null
    }
    if (logLabel) miotLog.info(`[MIoT] ${logLabel} ubus ok device=${deviceId} data=${summarize(result.data)}`)
    return result
  }

  private deviceResultCode(result: UbusResponse | null): number {
    const data = result?.data
    if (!data || typeof data !== 'object') return 0
    let value: unknown = (data as Record<string, unknown>).device_data ?? data
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        return 0
      }
    }
    if (!value || typeof value !== 'object') return 0
    const code = Number((value as Record<string, unknown>).code)
    return Number.isFinite(code) ? code : 0
  }

  /**
   * 播放指令有三种结果：ok 明确成功；failed 明确失败；timeout 云端没拿到设备回执（3012 等）。
   * timeout 时设备可能已经开始播放，必须交给播放器回读/重发，不能当作音源不可用。
   */
  private evaluatePlayResult(result: UbusResponse | null, action: string): MiotPlayCommandResult {
    if (!result) {
      miotLog.warn(`[MIoT] ${action} 未收到云端回执，按控制通道超时处理`)
      return 'timeout'
    }
    const deviceCode = this.deviceResultCode(result)
    if (result.code !== 0) {
      const detail = `${result.message ?? ''} ${summarize(result.data, 200)}`
      if (deviceCode === CONTROL_TIMEOUT_CODE || /远程控制超时|3012/.test(detail)) {
        miotLog.warn(`[MIoT] ${action} 控制回执超时（${deviceCode || CONTROL_TIMEOUT_CODE}），设备可能已执行`)
        return 'timeout'
      }
      // 101 表示 ubus 无法确认设备执行结果，同样不能据此判定音源失败
      if (result.code === 101) {
        miotLog.warn(`[MIoT] ${action} 云端无法确认设备回执（code=101），按控制通道超时处理`)
        return 'timeout'
      }
      miotLog.warn(`[MIoT] ${action} 播放控制失败 code=${result.code}`)
      return 'failed'
    }
    if (deviceCode !== 0) {
      if (deviceCode === CONTROL_TIMEOUT_CODE) {
        miotLog.warn(`[MIoT] ${action} 设备回执超时（3012），设备可能已执行`)
        return 'timeout'
      }
      miotLog.warn(`[MIoT] ${action} 设备拒绝播放 code=${deviceCode}`)
      return 'failed'
    }
    return 'ok'
  }

  private isDeviceResultOK(result: UbusResponse | null, action: string): boolean {
    if (result === null) {
      miotLog.warn(`[MIoT] ${action} returned null`)
      return false
    }
    const data = result.data
    if (data && typeof data === 'object' && 'code' in data) {
      const code = Number((data as Record<string, unknown>).code)
      if (!Number.isNaN(code) && code !== 0) {
        miotLog.warn(`[MIoT] ${action} device code=${code} data=${summarize(data)}`)
        return false
      }
    }
    return true
  }

  private async doGetRequest<T>(url: string): Promise<T | null> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Cookie': this.buildApiCookies(),
    }
    let result: Awaited<ReturnType<typeof fetchWithRedirects>>
    try {
      result = await fetchWithRedirects(url, { method: 'GET', headers }, new CookieJar(), 0)
    } catch {
      return null
    }

    if (result.status === 401) {
      if (!this.onTokenExpired || !(await this.onTokenExpired())) return null
      headers.Cookie = this.buildApiCookies()
      try {
        result = await fetchWithRedirects(url, { method: 'GET', headers }, new CookieJar(), 0)
      } catch {
        return null
      }
      if (result.status === 401) return null
    }

    try {
      return JSON.parse(result.text) as T
    } catch {
      return null
    }
  }

  private async doPostRequest<T>(
    url: string,
    body: string,
    logLabel = '',
    transformResponseText?: (text: string) => string,
    timeoutMs?: number,
    current?: () => boolean,
  ): Promise<T | null> {
    if (current?.() === false) return null
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': this.buildApiCookies(),
    }

    let result: Awaited<ReturnType<typeof fetchWithRedirects>>
    try {
      result = await fetchWithRedirects(url, { method: 'POST', headers, body, timeoutMs }, new CookieJar(), 0)
    } catch (err: any) {
      if (logLabel) miotLog.warn(`[MIoT] ${logLabel} request failed: ${err?.message || err}`)
      return null
    }

    if (result.status === 401) {
      if (logLabel) miotLog.warn(`[MIoT] ${logLabel} got 401, refreshing token`)
      if (!this.onTokenExpired || !(await this.onTokenExpired())) return null
      if (current?.() === false) return null
      headers.Cookie = this.buildApiCookies()
      try {
        result = await fetchWithRedirects(url, { method: 'POST', headers, body, timeoutMs }, new CookieJar(), 0)
      } catch (err: any) {
        if (logLabel) miotLog.warn(`[MIoT] ${logLabel} retry failed: ${err?.message || err}`)
        return null
      }
      if (result.status === 401) return null
    }

    if (result.status < 200 || result.status >= 300) return null

    try {
      return JSON.parse(transformResponseText ? transformResponseText(result.text) : result.text) as T
    } catch (err: any) {
      if (logLabel) miotLog.warn(`[MIoT] ${logLabel} parse failed: ${err?.message || err}`)
      return null
    }
  }

  private async doGetLatestAskFromXiaoai(deviceId: string, apiUrl: string): Promise<AskMessage[] | null> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Cookie': `${this.buildApiCookies()}; deviceId=${deviceId}`,
    }
    let result: Awaited<ReturnType<typeof fetchWithRedirects>>
    try {
      result = await fetchWithRedirects(apiUrl, { method: 'GET', headers }, new CookieJar(), 0)
    } catch (err: any) {
      miotLog.warn(`[MIoT] conversation fetch error: ${err?.message || err}`)
      return null
    }

    if (result.status === 401) {
      if (this.onTokenExpired) await this.onTokenExpired()
      return null
    }
    if (result.status !== 200) {
      miotLog.warn(`[MIoT] conversation unexpected status=${result.status}`)
      return null
    }

    try {
      const dataStr = (JSON.parse(result.text) as { data?: string }).data
      if (!dataStr) return []
      const data = JSON.parse(dataStr) as ConversationData
      if (!data.records || data.records.length === 0) return []
      return data.records.map(record => {
        const answers = record.answers || []
        // 大模型回答在 LLM 里，TTS 通常为空；优先保留 LLM 文本供分类/日志使用
        const llm = answers.find(answer => answer.type === 'LLM' && answer.llm?.text)
        const tts = answers.find(answer => answer.type === 'TTS' && answer.tts?.text)
        return {
          timestamp_ms: record.time,
          response: {
            answer: [{
              question: record.query,
              content: llm?.llm?.text || tts?.tts?.text || '',
            }],
          },
        }
      })
    } catch (err: any) {
      miotLog.warn(`[MIoT] conversation parse error: ${err?.message || err}`)
      return null
    }
  }

  private async getLatestAskByUbus(deviceId: string): Promise<AskMessage[] | null> {
    const result = await this.ubusRequest(deviceId, 'nlp_result_get', 'mibrain', {})
    if (!result || !result.data) return null

    try {
      const data = result.data as NlpResultData
      if (data.code !== 0) return null
      if (!data.info) return []
      const info = JSON.parse(data.info) as NlpInfoData
      if (!info.result) return []

      const messages: AskMessage[] = []
      for (const item of info.result) {
        if (!item.nlp) continue
        try {
          const nlp = JSON.parse(item.nlp) as NlpDetail
          const timestamp = parseInt(nlp.meta?.timestamp ?? '', 10)
          if (!Number.isFinite(timestamp) || timestamp <= 0) {
            miotLog.warn(`[MIoT] skip nlp record with invalid timestamp device=${deviceId} raw=${String(nlp.meta?.timestamp)}`)
            continue
          }
          messages.push({
            request_id: nlp.meta.request_id,
            timestamp_ms: timestamp,
            response: {
              answer: nlp.response.answer.map(answer => ({
                domain: answer.domain,
                action: answer.action,
                content: answer.content.to_speak,
                question: answer.intention.query,
              })),
            },
          })
        } catch { /* skip malformed record */ }
      }
      return messages
    } catch {
      return null
    }
  }
}
