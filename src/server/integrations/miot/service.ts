import { MINA_SID, TOKEN_REFRESH_THRESHOLD_HOURS, XIAOMI_IO_SID } from './constants'
import {
  AI_CLASSIFY_MARKER,
  AI_CLASSIFY_POLL_MS,
  AI_CLASSIFY_TIMEOUT_MS,
  AI_INTENT_MARKER,
  AI_INTENT_POLL_MS,
  AI_INTENT_TIMEOUT_MS,
  isAiInternalQuery,
  normalizeAiFailureThreshold,
  normalizeAiFailureWindow,
} from './aiConstants'
import {
  buildClassifyPrompt,
  collectRecommendations,
  DEFAULT_CLASSIFY_PROMPT_TEMPLATE,
  guessSongType,
  parseSongType,
  songTypeCacheKey,
} from './aiRecommend'
import {
  buildIntentPrompt,
  DEFAULT_INTENT_PROMPT_TEMPLATE,
  formatIntent,
  parseIntentAnswer,
  shouldAnalyzeIntent,
} from './aiIntent'
import type { MiotVoiceIntentResult } from './aiIntent'
import { hashAccountKey, randomToken } from './crypto'
import { miotLog } from './log'
import { MinaAuth } from './minaAuth'
import { MinaHTTPClient } from './minaClient'
import { MiotCloudClient } from './miotCloud'
import type { MiotCloudRefreshResult } from './miotCloud'
import { MiotPlayer } from './player'
import { MiotQRLogin } from './qrcode'
import { MiotStore, getDeviceKey } from './store'
import { MiotVoiceMonitor, handleVoiceQuery } from './voice'
import type {
  MiotAccount,
  MiotAiState,
  MiotDeviceConfig,
  MiotDeviceController,
  MiotDeviceInfo,
  MiotDevicePlayState,
  MiotLoginResult,
  MiotPlaybackView,
  MiotServiceToken,
  MiotSettings,
  MiotSong,
  MiotVoiceMessage,
  MiotVoiceTestResult,
} from './types'

interface AuthSession {
  auth: MinaAuth
  username: string
  createdAt: number
}

interface QRSession {
  login: MiotQRLogin
  createdAt: number
  polling: boolean
}

export interface MiotQRCodeStartResult {
  success: boolean
  loginId?: string
  qrcodeUrl?: string
  loginUrl?: string
  message?: string
}

export interface MiotQRCodePollResult {
  success: boolean
  state: 'waiting' | 'success' | 'expired' | 'failed'
  message?: string
  accountId?: string
}

const AUTH_SESSION_TTL_MS = 10 * 60 * 1000
const QR_SESSION_TTL_MS = 10 * 60 * 1000
const VOICE_LOG_LIMIT = 100

class MiotService implements MiotDeviceController {
  readonly store = new MiotStore()
  private clients = new Map<string, MinaHTTPClient>()
  private players = new Map<string, MiotPlayer>()
  private monitors = new Map<string, MiotVoiceMonitor>()
  private authSessions = new Map<string, AuthSession>()
  private qrSessions = new Map<string, QRSession>()
  private refreshing = new Map<string, Promise<boolean>>()
  private ioTokenTasks = new Map<string, Promise<MiotCloudRefreshResult>>()
  private aiLocks = new Map<string, Promise<void>>()
  private aiFailureStreaks = new Map<string, { count: number; lastAt: number }>()
  private voiceLog: MiotVoiceMessage[] = []
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    this.store.load()
    if (!this.store.getSettings().enabled) {
      miotLog.info('[MIoT] 功能未启用')
      return
    }
    this.restartMonitors()
    for (const account of this.store.getAccounts()) {
      void this.syncDevices(account.id).catch((err: any) => {
        miotLog.warn(`[MIoT] 启动同步设备失败 account=${account.username}: ${err?.message || err}`)
      })
    }
    miotLog.info(`[MIoT] 服务已启动，账号 ${this.store.getAccounts().length} 个，设备 ${this.store.getDevices().length} 台`)
  }

  shutdown(): void {
    for (const monitor of this.monitors.values()) monitor.stop()
    this.monitors.clear()
    for (const player of this.players.values()) player.shutdown()
    this.players.clear()
    for (const session of this.qrSessions.values()) session.login.reset()
    this.qrSessions.clear()
    this.store.flush()
    this.started = false
  }

  getSettings(): MiotSettings {
    return this.store.getSettings()
  }

  getPromptDefaults(): { intent: string; classify: string } {
    return {
      intent: DEFAULT_INTENT_PROMPT_TEMPLATE,
      classify: DEFAULT_CLASSIFY_PROMPT_TEMPLATE,
    }
  }

  updateSettings(patch: Partial<MiotSettings>): MiotSettings {
    if (patch.ai_recommend_enabled === true && this.store.getAiError()) {
      throw new Error('存在未清除的 AI 错误，请先清除错误记录后再开启')
    }
    const wasEnabled = this.store.getSettings().enabled
    const settings = this.store.updateSettings(patch)
    if (patch.ai_recommend_enabled === true || patch.ai_failure_threshold !== undefined || patch.ai_failure_window_min !== undefined) {
      this.aiFailureStreaks.clear()
    }
    if (patch.enabled === false) {
      for (const monitor of this.monitors.values()) monitor.stop()
      this.monitors.clear()
    } else if (patch.enabled === true || patch.voice_enabled !== undefined || patch.poll_interval_sec !== undefined) {
      this.restartMonitors()
      if (patch.enabled === true && !wasEnabled && this.started) {
        for (const account of this.store.getAccounts()) {
          void this.syncDevices(account.id).catch((err: any) => {
            miotLog.warn(`[MIoT] 启用后同步设备失败 account=${account.username}: ${err?.message || err}`)
          })
        }
      }
    }
    return settings
  }

  // ===== 账号登录 =====

  async login(username: string, password: string): Promise<MiotLoginResult> {
    if (!username || !password) return { state: 'failed', error: '请输入小米账号和密码' }
    this.cleanupAuthSessions()
    const auth = new MinaAuth()
    let result: Awaited<ReturnType<MinaAuth['login']>>
    try {
      result = await auth.login(username, password)
    } catch (err: any) {
      return { state: 'failed', error: `登录请求失败: ${err?.message || err}` }
    }
    return this.handleAuthResult(auth, username, result)
  }

  async loginWithCaptcha(loginId: string, captcha: string): Promise<MiotLoginResult> {
    this.cleanupAuthSessions()
    const session = this.authSessions.get(loginId)
    if (!session) return { state: 'failed', error: '登录会话已过期，请重新登录' }
    let result: Awaited<ReturnType<MinaAuth['loginWithCaptcha']>>
    try {
      result = await session.auth.loginWithCaptcha(captcha)
    } catch (err: any) {
      return { state: 'failed', error: `验证码提交失败: ${err?.message || err}` }
    }
    return this.handleAuthResult(session.auth, session.username, result, loginId)
  }

  async loginWithVerifyCode(loginId: string, code: string): Promise<MiotLoginResult> {
    this.cleanupAuthSessions()
    const session = this.authSessions.get(loginId)
    if (!session) return { state: 'failed', error: '登录会话已过期，请重新登录' }
    let result: Awaited<ReturnType<MinaAuth['loginWithVerifyCode']>>
    try {
      result = await session.auth.loginWithVerifyCode(code)
    } catch (err: any) {
      return { state: 'failed', error: `验证码提交失败: ${err?.message || err}` }
    }
    return this.handleAuthResult(session.auth, session.username, result, loginId)
  }

  async loginWithToken(username: string, userId: string, serviceToken: string, ssecurity = ''): Promise<MiotLoginResult> {
    if (!serviceToken) return { state: 'failed', error: 'serviceToken 不能为空' }
    const client = MinaHTTPClient.fromManualToken(userId, serviceToken, ssecurity)
    let valid = false
    try {
      valid = await client.validateToken()
    } catch { /* treated below */ }
    if (!valid) return { state: 'failed', error: 'Token 校验失败，请重新抓取 serviceToken' }
    const account = this.makeAccount(username || '手动Token', client.getTokenInfo(), '')
    this.persistAccount(account)
    await this.syncDevices(account.id).catch((err: any) => miotLog.warn(`[MIoT] 同步设备失败: ${err?.message || err}`))
    return { state: 'success', accountId: account.id }
  }

  // ===== 扫码登录 =====

  async startQRCodeLogin(): Promise<MiotQRCodeStartResult> {
    this.cleanupQRSessions()
    const loginId = randomToken(8)
    const login = new MiotQRLogin()
    try {
      const info = await login.getQRCode()
      if (!info) return { success: false, message: '获取二维码失败，请稍后重试' }
      this.qrSessions.set(loginId, { login, createdAt: Date.now(), polling: false })
      return { success: true, loginId, qrcodeUrl: info.qrcodeUrl, loginUrl: info.loginUrl }
    } catch (err: any) {
      login.reset()
      return { success: false, message: `获取二维码失败: ${err?.message || err}` }
    }
  }

  async pollQRCode(loginId: string): Promise<MiotQRCodePollResult> {
    this.cleanupQRSessions()
    const session = this.qrSessions.get(loginId)
    if (!session) return { success: false, state: 'expired', message: '二维码会话已过期，请刷新' }
    if (session.polling) return { success: false, state: 'waiting', message: '正在等待扫码结果' }

    session.polling = true
    try {
      const result = await session.login.poll()
      if (result.state === 'confirmed' && result.tokenInfo) {
        const userId = result.tokenInfo.user_id || ''
        const username = `小米账号${userId ? ` ${userId}` : ''}`
        const account = this.makeAccount(username, result.tokenInfo, result.passToken || '')
        this.persistAccount(account)
        this.qrSessions.delete(loginId)
        try {
          await this.syncDevices(account.id)
        } catch (err: any) {
          miotLog.warn(`[MIoT] 扫码登录后同步设备失败: ${err?.message || err}`)
        }
        miotLog.info(`[MIoT] 扫码登录成功 account=${account.id}`)
        return { success: true, state: 'success', accountId: account.id, message: '登录成功' }
      }

      if (result.state === 'expired' || result.state === 'failed') {
        this.qrSessions.delete(loginId)
        session.login.reset()
      }
      return {
        success: false,
        state: result.state === 'confirmed' ? 'failed' : result.state,
        message: result.message,
      }
    } catch (err: any) {
      this.qrSessions.delete(loginId)
      session.login.reset()
      return { success: false, state: 'failed', message: err?.message || String(err) }
    } finally {
      session.polling = false
    }
  }

  private cleanupQRSessions(): void {
    const now = Date.now()
    for (const [id, session] of this.qrSessions) {
      if (now - session.createdAt > QR_SESSION_TTL_MS) {
        session.login.reset()
        this.qrSessions.delete(id)
      }
    }
  }

  private handleAuthResult(
    auth: MinaAuth,
    username: string,
    result: Awaited<ReturnType<MinaAuth['login']>>,
    loginId?: string,
  ): MiotLoginResult {
    if (result.state === 'success' && result.tokenInfo) {
      const account = this.makeAccount(username, result.tokenInfo, auth.getPassToken())
      this.persistAccount(account)
      if (loginId) this.authSessions.delete(loginId)
      void this.syncDevices(account.id).catch((err: any) => miotLog.warn(`[MIoT] 同步设备失败: ${err?.message || err}`))
      return { state: 'success', accountId: account.id }
    }

    const id = loginId ?? hashAccountKey(`${username}:${Date.now()}:${Math.random()}`)
    this.authSessions.set(id, { auth, username, createdAt: Date.now() })
    return {
      state: result.state,
      loginId: id,
      captchaImage: result.captchaImage,
      verifyUrl: result.verifyUrl,
      verifyType: result.verifyType,
      error: result.error,
    }
  }

  private makeAccount(username: string, tokenInfo: MiotAccount['token_info'], passToken: string): MiotAccount {
    const userId = tokenInfo.user_id || ''
    const id = hashAccountKey(`${username}:${userId || tokenInfo.device_id}`)
    const now = Date.now()
    return {
      id,
      username,
      user_id: userId,
      device_id: tokenInfo.device_id,
      pass_token: passToken,
      token_info: tokenInfo,
      created_at: now,
      last_login_at: now,
    }
  }

  private persistAccount(account: MiotAccount): void {
    for (const existing of this.store.getAccounts()) {
      if (existing.username === account.username && existing.id !== account.id) this.store.removeAccount(existing.id)
    }
    const previous = this.store.getAccount(account.id)
    if (previous) account.created_at = previous.created_at
    this.store.upsertAccount(account)
    this.clients.delete(account.id)
  }

  private cleanupAuthSessions(): void {
    const now = Date.now()
    for (const [id, session] of this.authSessions) {
      if (now - session.createdAt > AUTH_SESSION_TTL_MS) this.authSessions.delete(id)
    }
  }

  logout(accountId: string): void {
    this.stopAccountRuntime(accountId)
    this.store.removeAccount(accountId)
    this.clients.delete(accountId)
  }

  private stopAccountRuntime(accountId: string): void {
    for (const [key, monitor] of this.monitors) {
      if (key.startsWith(`${accountId}:`)) {
        monitor.stop()
        this.monitors.delete(key)
      }
    }
    for (const [key, player] of this.players) {
      if (key.startsWith(`${accountId}:`)) {
        player.shutdown()
        this.players.delete(key)
      }
    }
  }

  // ===== 设备 =====

  async syncDevices(accountId: string): Promise<MiotDeviceConfig[]> {
    const client = await this.getClient(accountId)
    if (!client) throw new Error('账号不存在或登录已失效')
    const devices = await client.getDeviceList()
    if (devices.length === 0 && !(await client.validateToken())) {
      throw new Error('登录已失效，请重新登录小米账号')
    }

    const existing = new Map(this.store.getDevices(accountId).map(item => [item.device_id, item]))
    const seen = new Set<string>()
    const defaults = this.store.getSettings()

    for (const device of devices) {
      seen.add(device.deviceID)
      const old = existing.get(device.deviceID)
      this.store.upsertDevice({
        account_id: accountId,
        device_id: device.deviceID,
        name: device.alias || device.name || device.deviceID,
        alias: device.alias ?? '',
        model: device.model ?? '',
        hardware: device.hardware ?? '',
        miot_did: device.miotDID ?? '',
        presence: device.presence ?? '',
        managed: old?.managed ?? true,
        voice_enabled: old?.voice_enabled ?? defaults.voice_enabled,
        volume: old?.volume ?? 0,
        play_mode: old?.play_mode ?? 'order',
        last_selected_at: old?.last_selected_at ?? 0,
      })
    }
    for (const old of existing.values()) {
      if (!seen.has(old.device_id)) this.store.removeDevice(accountId, old.device_id)
    }
    this.restartMonitors()
    miotLog.info(`[MIoT] 账号 ${accountId} 同步设备 ${devices.length} 台`)
    return this.store.getDevices(accountId)
  }

  updateDevice(accountId: string, deviceId: string, patch: Partial<MiotDeviceConfig>): MiotDeviceConfig | undefined {
    const allowed: Partial<MiotDeviceConfig> = {}
    if (patch.managed !== undefined) allowed.managed = !!patch.managed
    if (patch.voice_enabled !== undefined) allowed.voice_enabled = !!patch.voice_enabled
    if (patch.play_mode !== undefined) allowed.play_mode = patch.play_mode
    if (patch.volume !== undefined) allowed.volume = Math.max(0, Math.min(100, Math.floor(Number(patch.volume) || 0)))
    if (patch.last_selected_at !== undefined) allowed.last_selected_at = Number(patch.last_selected_at) || 0
    const device = this.store.updateDevice(accountId, deviceId, allowed)
    if (device && (patch.managed !== undefined || patch.voice_enabled !== undefined)) this.restartMonitors()
    return device
  }

  listDevices(): MiotDeviceInfo[] {
    return this.store.getDevices().map(device => {
      const account = this.store.getAccount(device.account_id)
      return {
        accountId: device.account_id,
        accountName: account?.username ?? '',
        deviceId: device.device_id,
        name: device.name,
        alias: device.alias,
        model: device.model,
        hardware: device.hardware,
        miotDID: device.miot_did,
        presence: device.presence,
        managed: device.managed,
        voiceEnabled: device.voice_enabled,
        volume: device.volume,
        playMode: device.play_mode,
        lastSelectedAt: device.last_selected_at,
      }
    })
  }

  getAccountsSafe(): Array<{ id: string; username: string; user_id: string; last_login_at: number; token_expires_at: number }> {
    return this.store.getAccounts().map(account => ({
      id: account.id,
      username: account.username,
      user_id: account.user_id,
      last_login_at: account.last_login_at,
      token_expires_at: account.token_info?.services?.[MINA_SID]?.expires_at ?? 0,
    }))
  }

  getPlayer(accountId: string, deviceId: string): MiotPlayer | null {
    if (!this.store.getAccount(accountId) || !this.store.getDevice(accountId, deviceId)) return null
    const key = getDeviceKey(accountId, deviceId)
    let player = this.players.get(key)
    if (!player) {
      player = new MiotPlayer(accountId, deviceId, {
        store: this.store,
        controller: this,
        getSettings: () => this.store.getSettings(),
        recommend: (seed, exclude, limit) => this.recommendSameType(accountId, deviceId, seed, exclude, limit),
      })
      this.players.set(key, player)
    }
    return player
  }

  async getPlayback(accountId: string, deviceId: string): Promise<MiotPlaybackView | null> {
    const player = this.getPlayer(accountId, deviceId)
    return player ? player.getView() : null
  }

  // ===== AI 分类与同类推荐 =====

  getAiState(): MiotAiState {
    const settings = this.store.getSettings()
    const daily = this.store.getAiDailyCount()
    return {
      enabled: settings.ai_recommend_enabled,
      error: this.store.getAiError(),
      cachedTypes: this.store.getAiTypeCount(),
      dailyCount: daily.count,
      dailyLimit: settings.ai_daily_limit,
    }
  }

  clearAiError(): MiotAiState {
    this.store.clearAiError()
    this.aiFailureStreaks.clear()
    return this.getAiState()
  }

  private resetAiFailure(key: string): void {
    this.aiFailureStreaks.delete(key)
  }

  private recordAiFailure(key: string): { count: number; threshold: number; disabled: boolean } {
    const settings = this.store.getSettings()
    const threshold = normalizeAiFailureThreshold(settings.ai_failure_threshold)
    const windowMs = normalizeAiFailureWindow(settings.ai_failure_window_min) * 60000
    const now = Date.now()
    const previous = this.aiFailureStreaks.get(key)
    const count = previous && now - previous.lastAt <= windowMs ? previous.count + 1 : 1
    this.aiFailureStreaks.set(key, { count, lastAt: now })
    return { count, threshold, disabled: count >= threshold }
  }

  private async acquireAiLock(key: string, waitMs: number): Promise<(() => void) | null> {
    const startedAt = Date.now()
    while (this.aiLocks.has(key)) {
      if (Date.now() - startedAt >= waitMs) return null
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    this.aiLocks.set(key, gate)
    return () => {
      if (this.aiLocks.get(key) === gate) this.aiLocks.delete(key)
      release()
    }
  }

  private async askSpeaker(
    accountId: string,
    deviceId: string,
    prompt: string,
    marker: string,
    timeoutMs: number,
    pollMs: number,
    silent: boolean,
    lockWaitMs: number,
    timeoutMessage: string,
  ): Promise<string> {
    const key = getDeviceKey(accountId, deviceId)
    const release = await this.acquireAiLock(key, lockWaitMs)
    if (!release) throw new Error('AI 正在处理其他请求，请稍后再试')
    try {
      const device = this.store.getDevice(accountId, deviceId)
      if (!device) throw new Error('设备不存在，请重新同步设备')
      if (!device.miot_did) throw new Error('设备缺少 miotDID，请重新同步设备后再试')
      if (!device.hardware) throw new Error('设备缺少硬件型号，无法读取小爱回答')

      const cloud = await this.getCloudClient(accountId)
      const client = await this.getClient(accountId)
      if (!client) throw new Error('小爱客户端未初始化，请重新登录')

      const startedAt = Date.now()
      await cloud.executeTextDirective(device.miot_did, prompt, silent)

      while (Date.now() - startedAt < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, pollMs))
        let messages: Awaited<ReturnType<MinaHTTPClient['getLatestAskFromXiaoai']>> = null
        try {
          messages = await client.getLatestAskFromXiaoai(deviceId, device.hardware, 5)
        } catch (err: any) {
          miotLog.warn(`[MIoT] AI 读取对话失败: ${err?.message || err}`)
        }
        if (!messages || messages.length === 0) continue
        const hit = messages
          .filter(message => message.timestamp_ms >= startedAt - 5000 &&
            String(message.response?.answer?.[0]?.question || '').includes(marker))
          .sort((a, b) => a.timestamp_ms - b.timestamp_ms)
          .pop()
        const answer = String(hit?.response?.answer?.[0]?.content || '').trim()
        if (answer) return answer
      }
      throw new Error(timeoutMessage)
    } finally {
      release()
    }
  }

  private async classifySongType(
    accountId: string,
    deviceId: string,
    song: MiotSong,
  ): Promise<{ type: string; cached: boolean }> {
    const cacheKey = songTypeCacheKey(song)
    const cached = this.store.getSongType(cacheKey)
    if (cached) return { type: cached, cached: true }

    const device = this.store.getDevice(accountId, deviceId)
    if (!device) throw new Error('设备不存在，请重新同步设备')
    if (!device.miot_did) throw new Error('设备缺少 miotDID，请重新同步设备后再试')
    if (!device.hardware) throw new Error('设备缺少硬件型号，无法读取小爱回答')

    const settings = this.store.getSettings()
    const limit = settings.ai_daily_limit
    const quota = this.store.bumpAiDaily(limit)
    if (!quota.allowed) throw new Error(`AI 分析达到每日上限（${limit} 次）`)

    const prompt = buildClassifyPrompt(song, settings.ai_classify_prompt)
    miotLog.info(`[MIoT] AI 分类请求 device=${device.name} song="${song.name}"`)
    this.recordAiLog(accountId, deviceId, {
      question: prompt,
      command: 'ai_classify_request',
      note: `AI 分类请求：${song.name}${song.singer ? ` - ${song.singer}` : ''}`,
    })

    const answer = await this.askSpeaker(
      accountId,
      deviceId,
      prompt,
      AI_CLASSIFY_MARKER,
      AI_CLASSIFY_TIMEOUT_MS,
      AI_CLASSIFY_POLL_MS,
      false,
      15000,
      'AI 分类超时，小爱没有返回类型',
    )
    this.resetAiFailure(getDeviceKey(accountId, deviceId))

    const type = parseSongType(answer)
    if (!type) {
      miotLog.warn(`[MIoT] AI 分类回答无法识别: ${answer.slice(0, 120)}`)
      this.recordAiLog(accountId, deviceId, {
        question: `AI 分类返回：${song.name}`,
        answer,
        command: 'ai_classify_result',
        note: '回答无法识别，按“其他”处理并缓存',
        executed: false,
      })
      this.store.setSongType(cacheKey, '其他')
      return { type: '其他', cached: false }
    }
    this.store.setSongType(cacheKey, type)
    miotLog.info(`[MIoT] AI 分类 "${song.name}" → ${type}`)
    this.recordAiLog(accountId, deviceId, {
      question: `AI 分类返回：${song.name}`,
      answer,
      command: 'ai_classify_result',
      note: `类型 → ${type}（已缓存）`,
    })
    return { type, cached: false }
  }

  async resolveVoiceIntent(
    accountId: string,
    deviceId: string,
    query: string,
  ): Promise<MiotVoiceIntentResult> {
    const settings = this.store.getSettings()
    if (!settings.ai_recommend_enabled) return { intent: null }
    const commands = this.store.getVoiceCommands()
    if (!shouldAnalyzeIntent(query, commands)) return { intent: null }
    const device = this.store.getDevice(accountId, deviceId)
    if (!device) return { intent: null }

    const lockKey = getDeviceKey(accountId, deviceId)
    if (this.aiLocks.has(lockKey)) {
      miotLog.info(`[MIoT] AI 正忙，跳过意图解析 device=${device.name} query="${query}"`)
      return { intent: null }
    }

    const limit = settings.ai_daily_limit
    const quota = this.store.bumpAiDaily(limit)
    if (!quota.allowed) {
      miotLog.warn(`[MIoT] AI 意图解析达到每日上限（${limit} 次），跳过`)
      return { intent: null }
    }

    const prompt = buildIntentPrompt(query, settings.ai_intent_prompt, commands)
    const player = this.getPlayer(accountId, deviceId)
    this.recordAiLog(accountId, deviceId, {
      question: `AI 指令解析请求：${query}`,
      answer: prompt,
      answer_label: '发送文本',
      command: 'ai_intent_request',
      note: 'AI 指令解析请求',
    })

    try {
      const answer = await this.askSpeaker(
        accountId,
        deviceId,
        prompt,
        AI_INTENT_MARKER,
        AI_INTENT_TIMEOUT_MS,
        AI_INTENT_POLL_MS,
        false,
        0,
        'AI 指令解析超时，小爱没有返回内容',
      )
      this.resetAiFailure(lockKey)
      const parsed = parseIntentAnswer(answer, commands)
      if (parsed.noIntent) {
        this.recordAiLog(accountId, deviceId, {
          question: `AI 指令解析返回：${query}`,
          answer,
          command: 'ai_intent_result',
          note: '未识别到可执行口令，本次跳过',
          executed: false,
        })
        return { intent: null }
      }
      if (!parsed.intent) {
        miotLog.warn(`[MIoT] AI 意图回答无法识别: ${answer.slice(0, 120)}`)
        this.recordAiLog(accountId, deviceId, {
          question: `AI 指令解析返回：${query}`,
          answer,
          command: 'ai_intent_result',
          note: '回答无法识别，本次跳过（不影响 AI 开关）',
          executed: false,
        })
        return { intent: null }
      }
      miotLog.info(`[MIoT] AI 指令解析 "${query}" → ${formatIntent(parsed.intent)}`)
      this.recordAiLog(accountId, deviceId, {
        question: `AI 指令解析返回：${query}`,
        answer,
        command: 'ai_intent_result',
        note: `口令 → ${formatIntent(parsed.intent)}`,
      })
      return { intent: parsed.intent }
    } catch (err: any) {
      const outcome = await this.handleAiFailure(accountId, deviceId, err, player, 'intent')
      return { intent: null, failed: true, disabled: outcome.disabled, note: outcome.note }
    }
  }

  private async handleAiFailure(
    accountId: string,
    deviceId: string,
    error: any,
    player: MiotPlayer | null,
    source: 'recommend' | 'intent' = 'recommend',
  ): Promise<{ disabled: boolean; note: string }> {
    const device = this.store.getDevice(accountId, deviceId)
    const key = getDeviceKey(accountId, deviceId)
    const message = String(error?.message || error || '未知错误')
    const sourceLabel = source === 'intent' ? '意图解析' : '自动推歌'

    if (/每日上限|正在处理其他请求/.test(message)) {
      miotLog.warn(`[MIoT] AI ${sourceLabel}跳过: ${message}`)
      return { disabled: false, note: 'AI 正忙或达到每日额度，本次跳过' }
    }

    const authFailure = /登录|token|认证|授权|passToken|ssecurity|未初始化|账号不存在|401|403|unauthorized|forbidden/i.test(message)
    const configFailure = /设备不存在|miotDID|硬件型号|重新同步设备/i.test(message)
    const immediate = authFailure || configFailure

    if (!immediate) {
      const failure = this.recordAiFailure(key)
      if (!failure.disabled) {
        miotLog.warn(`[MIoT] AI ${sourceLabel}暂时未响应（${failure.count}/${failure.threshold}），保持开启: ${message}`)
        this.recordAiLog(accountId, deviceId, {
          question: source === 'intent' ? 'AI 意图解析暂时未响应' : 'AI 推荐暂时未响应',
          answer: message,
          answer_label: '错误信息',
          command: 'ai_retry',
          note: `连续失败 ${failure.count}/${failure.threshold}，保持 AI 开启，等待下次重试`,
          executed: false,
        })
        return { disabled: false, note: `AI 暂时未响应（${failure.count}/${failure.threshold}），保持开启` }
      }
      return this.disableAi(accountId, deviceId, message, player, source, device?.name || '',
        `连续 ${failure.count} 次未响应，已自动关闭 AI 分析`)
    }

    this.aiFailureStreaks.delete(key)
    return this.disableAi(accountId, deviceId, message, player, source, device?.name || '',
      authFailure ? '登录或 Token 异常，已自动关闭 AI 分析' : '设备配置异常，已自动关闭 AI 分析')
  }

  private async disableAi(
    accountId: string,
    deviceId: string,
    message: string,
    player: MiotPlayer | null,
    source: 'recommend' | 'intent',
    deviceName: string,
    note: string,
  ): Promise<{ disabled: boolean; note: string }> {
    const sourceLabel = source === 'intent' ? '意图解析' : '自动推歌'
    this.store.setAiError({
      message,
      at: Date.now(),
      account_id: accountId,
      device_id: deviceId,
      device_name: deviceName,
    })
    this.store.updateSettings({ ai_recommend_enabled: false })
    miotLog.warn(`[MIoT] AI ${sourceLabel}异常，已自动关闭: ${message}`)
    this.recordAiLog(accountId, deviceId, {
      question: source === 'intent' ? 'AI 意图解析异常' : 'AI 推荐异常',
      answer: message,
      answer_label: '错误信息',
      command: 'ai_error',
      note,
      executed: false,
    })
    if (player) {
      const short = message.length > 48 ? `${message.slice(0, 48)}…` : message
      await player.announce(`AI分析出错：${short}。已关闭AI分析，请在小爱页面清除错误记录后重新开启。`)
    }
    return { disabled: true, note: 'AI 分析异常，已关闭 AI 开关' }
  }

  /**
   * 自动推歌核心：开启 AI 时先分类（有缓存不重复询问），连续未响应达到阈值才关闭 AI 并继续兜底；
   * 返回的歌曲已排除种子同名翻唱与队列中已存在的曲目。
   */
  async recommendSameType(
    accountId: string,
    deviceId: string,
    seed: MiotSong,
    exclude: string[],
    limit = 20,
  ): Promise<{ songs: MiotSong[]; type: string }> {
    const settings = this.store.getSettings()
    const player = this.getPlayer(accountId, deviceId)
    let type: string = guessSongType(seed)

    if (settings.ai_recommend_enabled) {
      try {
        const result = await this.classifySongType(accountId, deviceId, seed)
        if (result.type) type = result.type
        if (!result.cached) miotLog.info(`[MIoT] AI 分类结果已缓存: "${seed.name}" → ${result.type}`)
      } catch (err: any) {
        await this.handleAiFailure(accountId, deviceId, err, player)
      } finally {
        // 分类提问会打断音箱当前播放，回答问题后恢复；歌曲已自然结束时不要重播
        if (player) await player.ensureDevicePlaying(false)
      }
    }

    try {
      const result = await collectRecommendations(seed, {
        username: settings.username,
        type,
        exclude,
        limit,
      })
      miotLog.info(`[MIoT] 同类推荐 seed="${seed.name}" type=${result.type || '未知'} 数量=${result.songs.length}`)
      const fallback = !this.store.getSettings().ai_recommend_enabled
      this.recordAiLog(accountId, deviceId, {
        question: `AI 同类推荐：${seed.name}${seed.singer ? ` - ${seed.singer}` : ''}`,
        answer: result.songs.slice(0, 3).map(song => `${song.name}${song.singer ? ` - ${song.singer}` : ''}`).join('；'),
        answer_label: '推荐歌曲',
        command: 'ai_recommend',
        note: `类型 ${result.type || '未知'} · ${result.songs.length} 首${fallback ? '（兜底推荐）' : ''}`,
        executed: result.songs.length > 0,
      })
      return { songs: result.songs, type: result.type || type }
    } catch (err: any) {
      miotLog.warn(`[MIoT] 同类推荐失败 seed="${seed.name}": ${err?.message || err}`)
      this.recordAiLog(accountId, deviceId, {
        question: `AI 同类推荐失败：${seed.name}`,
        answer: String(err?.message || err),
        answer_label: '错误信息',
        command: 'ai_error',
        note: '同类推荐获取失败，本次不续播',
        executed: false,
      })
      return { songs: [], type }
    }
  }

  // ===== 客户端与 token 刷新 =====

  async getClient(accountId: string): Promise<MinaHTTPClient | null> {
    const account = this.store.getAccount(accountId)
    if (!account) return null
    this.maybeRefresh(account)
    let client = this.clients.get(accountId)
    if (!client) {
      client = new MinaHTTPClient(account.token_info, () => this.refreshAccount(accountId))
      this.clients.set(accountId, client)
    }
    return client
  }

  private maybeRefresh(account: MiotAccount): void {
    if (!account.pass_token) return
    const service = account.token_info?.services?.[MINA_SID]
    if (!service?.expires_at) return
    if (service.expires_at - Date.now() > TOKEN_REFRESH_THRESHOLD_HOURS * 3600 * 1000) return
    void this.refreshAccount(account.id)
  }

  /**
   * MIoT 云端接口（文本指令）需要 xiaomiio 的 serviceToken，扫码登录只拿到 micoapi。
   * 这里用保存的 passToken 懒换取并缓存，过期前 3 小时自动续期。
   * 云端若仍返回 401（本地 expires_at 不可信），refreshToken 会强制重换一次再重试。
   */
  async getCloudClient(accountId: string): Promise<MiotCloudClient> {
    const account = this.store.getAccount(accountId)
    if (!account) throw new Error('小米账号不存在，请重新登录')
    const token = this.getCachedCloudToken(accountId) ?? await this.ensureXiaomiIoToken(accountId)

    return new MiotCloudClient({
      userId: token.userId || account.user_id,
      deviceId: account.device_id,
      serviceToken: token.serviceToken,
      refreshToken: () => {
        miotLog.warn(`[MIoT] 小米云 token 被拒绝，强制刷新授权: ${account.username}`)
        return this.ensureXiaomiIoToken(accountId, true)
      },
    })
  }

  private isCloudTokenFresh(service?: MiotServiceToken): boolean {
    if (!service?.service_token || !service.ssecurity) return false
    const expiresAt = Number(service.expires_at)
    if (!Number.isFinite(expiresAt)) return false
    return expiresAt - Date.now() > TOKEN_REFRESH_THRESHOLD_HOURS * 3600 * 1000
  }

  private getCachedCloudToken(accountId: string): MiotCloudRefreshResult | null {
    const account = this.store.getAccount(accountId)
    const service = account?.token_info?.services?.[XIAOMI_IO_SID]
    if (!account || !this.isCloudTokenFresh(service)) return null
    return { serviceToken: service!, userId: account.user_id }
  }

  private ensureXiaomiIoToken(accountId: string, force = false): Promise<MiotCloudRefreshResult> {
    const existing = this.ioTokenTasks.get(accountId)
    if (existing) return existing

    if (!force) {
      const cached = this.getCachedCloudToken(accountId)
      if (cached) return Promise.resolve(cached)
    }

    const account = this.store.getAccount(accountId)
    if (!account) return Promise.reject(new Error('小米账号不存在，请重新登录'))

    const task = this.refreshXiaomiIoToken(account).finally(() => {
      this.ioTokenTasks.delete(accountId)
    })
    this.ioTokenTasks.set(accountId, task)
    return task
  }

  private async refreshXiaomiIoToken(account: MiotAccount): Promise<MiotCloudRefreshResult> {
    if (!account.pass_token) {
      throw new Error('账号缺少 passToken，无法调用小米云；请改用扫码或密码重新登录')
    }
    miotLog.info(`[MIoT] 获取小米云授权: ${account.username}`)
    let result: Awaited<ReturnType<MinaAuth['refreshByPassToken']>>
    try {
      const auth = new MinaAuth(account.device_id)
      result = await auth.refreshByPassToken(account.pass_token, account.user_id, XIAOMI_IO_SID)
    } catch (err: any) {
      throw new Error(`获取小米云授权失败: ${err?.message || err}`)
    }
    const service = result.tokenInfo?.services?.[XIAOMI_IO_SID]
    if (result.state !== 'success' || !service?.service_token || !service.ssecurity) {
      throw new Error(result.error || '获取小米云授权失败，请重新登录小米账号')
    }
    const userId = result.tokenInfo?.user_id || account.user_id
    const current = this.store.getAccount(account.id)
    if (current) {
      current.token_info.services = { ...current.token_info.services, [XIAOMI_IO_SID]: service }
      if (userId) current.user_id = userId
      this.store.upsertAccount(current)
    }
    miotLog.info(`[MIoT] 小米云授权已更新: ${account.username}`)
    return { serviceToken: service, userId }
  }

  private refreshAccount(accountId: string): Promise<boolean> {
    const existing = this.refreshing.get(accountId)
    if (existing) return existing
    const task = this.doRefresh(accountId).finally(() => this.refreshing.delete(accountId))
    this.refreshing.set(accountId, task)
    return task
  }

  private async doRefresh(accountId: string): Promise<boolean> {
    const account = this.store.getAccount(accountId)
    if (!account || !account.pass_token) return false
    miotLog.info(`[MIoT] 刷新账号 token: ${account.username}`)
    try {
      const auth = new MinaAuth(account.device_id)
      const result = await auth.refreshByPassToken(account.pass_token, account.user_id)
      if (result.state !== 'success' || !result.tokenInfo) {
        miotLog.warn(`[MIoT] token 刷新失败 ${account.username}: ${result.error || result.state}`)
        return false
      }
      // 只更新 micoapi，保留已缓存的 xiaomiio 云端授权
      account.token_info = {
        ...result.tokenInfo,
        services: { ...account.token_info.services, ...result.tokenInfo.services },
      }
      account.user_id = result.tokenInfo.user_id || account.user_id
      account.last_login_at = Date.now()
      account.pass_token = auth.getPassToken() || account.pass_token
      this.store.upsertAccount(account)
      this.clients.get(accountId)?.updateTokenInfo(result.tokenInfo)
      return true
    } catch (err: any) {
      miotLog.warn(`[MIoT] token 刷新异常 ${account.username}: ${err?.message || err}`)
      return false
    }
  }

  // ===== 设备控制器（供播放器使用） =====

  async playUrl(accountId: string, deviceId: string, url: string, meta: { title: string; artist?: string }): Promise<boolean> {
    const client = await this.getClient(accountId)
    if (!client) return false
    const device = this.store.getDevice(accountId, deviceId)
    return client.playByUrl(deviceId, url, device?.hardware ?? '', this.store.getSettings().keep_light)
  }

  async pause(accountId: string, deviceId: string): Promise<'paused' | 'stopped' | 'failed'> {
    const client = await this.getClient(accountId)
    return client ? client.playerPauseVerified(deviceId) : 'failed'
  }

  async resume(accountId: string, deviceId: string): Promise<boolean> {
    const client = await this.getClient(accountId)
    return client ? client.playerResume(deviceId) : false
  }

  async stop(accountId: string, deviceId: string): Promise<boolean> {
    const client = await this.getClient(accountId)
    return client ? client.playerStop(deviceId) : false
  }

  async getPlayState(accountId: string, deviceId: string): Promise<MiotDevicePlayState | null> {
    const client = await this.getClient(accountId)
    if (!client) return null
    const result = await client.getPlayerStatus(deviceId, { verify: true })
    const info = (result?.data as { info?: unknown } | undefined)?.info
    if (typeof info !== 'string') return null
    try {
      const parsed = JSON.parse(info) as {
        status?: unknown
        play_song_detail?: { position?: unknown; duration?: unknown }
      }
      if (typeof parsed.status !== 'number' || !Number.isFinite(parsed.status) || parsed.status < 0) return null
      const rawPosition = parsed.play_song_detail?.position
      const rawDuration = parsed.play_song_detail?.duration
      const hasPosition = typeof rawPosition === 'number' && Number.isFinite(rawPosition) && rawPosition >= 0
      const position = hasPosition ? (rawPosition as number) / 1000 : 0
      const duration = typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0
        ? (rawDuration as number) / 1000
        : 0
      return { status: parsed.status, position, duration, hasPosition }
    } catch {
      return null
    }
  }

  async readVolume(accountId: string, deviceId: string): Promise<number> {
    const client = await this.getClient(accountId)
    return client ? client.getVolume(deviceId) : -1
  }

  async setVolume(accountId: string, deviceId: string, volume: number): Promise<boolean> {
    const client = await this.getClient(accountId)
    return client ? client.setVolume(deviceId, volume) : false
  }

  async textToSpeech(accountId: string, deviceId: string, text: string): Promise<boolean | null> {
    const client = await this.getClient(accountId)
    return client ? client.textToSpeech(deviceId, text) : false
  }

  // ===== 语音监听 =====

  private voiceMonitorContext() {
    return {
      getPlayer: (accountId: string, deviceId: string) => this.getPlayer(accountId, deviceId),
      getSettings: () => this.store.getSettings(),
      getCommands: () => this.store.getVoiceCommands(),
      getHardware: (accountId: string, deviceId: string) => this.store.getDevice(accountId, deviceId)?.hardware ?? null,
      getLatestAsk: async (accountId: string, deviceId: string, hardware: string, limit: number) => {
        const client = await this.getClient(accountId)
        if (!client) return null
        const messages = await client.getLatestAskFromXiaoai(deviceId, hardware, limit)
        if (messages === null) return null
        return messages.map(message => ({
          timestamp_ms: message.timestamp_ms,
          query: message.response?.answer?.[0]?.question ?? '',
          answer: message.response?.answer?.[0]?.content ?? '',
        }))
      },
      isInternalQuery: (question: string) => isAiInternalQuery(question),
      resolveIntent: (accountId: string, deviceId: string, query: string) =>
        this.resolveVoiceIntent(accountId, deviceId, query),
      onMessage: (message: MiotVoiceMessage) => this.recordVoice(message),
    }
  }

  restartMonitors(): void {
    for (const monitor of this.monitors.values()) monitor.stop()
    this.monitors.clear()
    const settings = this.store.getSettings()
    if (!settings.enabled || !settings.voice_enabled) return
    for (const device of this.store.getDevices()) {
      if (!device.managed || !device.voice_enabled) continue
      const monitor = new MiotVoiceMonitor(device.account_id, device.device_id, device.name, this.voiceMonitorContext())
      this.monitors.set(getDeviceKey(device.account_id, device.device_id), monitor)
      monitor.start()
    }
  }

  private recordVoice(message: MiotVoiceMessage): void {
    this.voiceLog.unshift(message)
    if (this.voiceLog.length > VOICE_LOG_LIMIT) this.voiceLog.length = VOICE_LOG_LIMIT
  }

  /** AI 推荐事件写入设备对话记录，便于在页面上核对调用与返回 */
  private recordAiLog(accountId: string, deviceId: string, entry: {
    question: string
    answer?: string
    answer_label?: string
    command: string
    note?: string
    executed?: boolean
  }): void {
    const device = this.store.getDevice(accountId, deviceId)
    this.recordVoice({
      account_id: accountId,
      device_id: deviceId,
      device_name: device?.name || '',
      timestamp_ms: Date.now(),
      question: entry.question,
      answer: entry.answer || '',
      answer_label: entry.answer_label,
      received_at: Date.now(),
      executed: entry.executed ?? true,
      command: entry.command,
      note: entry.note,
    })
  }

  getVoiceLog(accountId?: string, deviceId?: string): MiotVoiceMessage[] {
    return this.voiceLog.filter(item =>
      (!accountId || item.account_id === accountId) &&
      (!deviceId || item.device_id === deviceId))
  }

  async testVoice(query: string, accountId?: string, deviceId?: string, execute = false): Promise<MiotVoiceTestResult> {
    const player = execute && accountId && deviceId ? this.getPlayer(accountId, deviceId) : null
    const device = accountId && deviceId ? this.store.getDevice(accountId, deviceId) : undefined
    return handleVoiceQuery(query, this.store.getVoiceCommands(), {
      player,
      settings: this.store.getSettings(),
      deviceName: device?.name ?? '测试',
      resolveIntent: accountId && deviceId
        ? (text: string) => this.resolveVoiceIntent(accountId, deviceId, text)
        : undefined,
    })
  }

  async shutdownPlayer(accountId: string, deviceId: string): Promise<void> {
    const player = this.players.get(getDeviceKey(accountId, deviceId))
    if (player) {
      player.shutdown()
      this.players.delete(getDeviceKey(accountId, deviceId))
    }
  }
}

let instance: MiotService | null = null

export const getMiotService = (): MiotService => {
  if (!instance) instance = new MiotService()
  return instance
}

export type { MiotService }
