import { CookieJar, fetchWithRedirects } from './http'
import { generateDeviceId } from './crypto'
import { ACCOUNT_BASE_URL, MINA_SID, formatUserAgent } from './constants'
import { MinaAuth } from './minaAuth'
import { miotLog } from './log'
import type { MiotTokenInfo } from './types'

/** 二维码登录使用 mijia SID 获取二维码（与 xiaomusic / songloft 插件一致） */
const QR_LOGIN_SID = 'mijia'
const LONG_POLLING_URL = `${ACCOUNT_BASE_URL}/longPolling/loginUrl`
/** lp 长轮询在服务端会阻塞到状态变化，限制在 25s 内返回，避免占满 HTTP 请求 */
const POLL_TIMEOUT_MS = 25000
const MAX_POLL_COUNT = 20

export type QRLoginState = 'waiting' | 'confirmed' | 'expired' | 'failed'

export interface QRLoginInfo {
  qrcodeUrl: string
  loginUrl: string
}

export interface QRPollResult {
  state: QRLoginState
  message: string
  tokenInfo?: MiotTokenInfo
  passToken?: string
}

const stripJsonPrefix = (body: string): string => body.replace('&&&START&&&', '').trim()

const getStringValue = (obj: Record<string, unknown>, key: string, defaultValue: string): string => {
  const value = obj[key]
  if (value === undefined || value === null) return defaultValue
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(Math.floor(value))
  return String(value)
}

const isTimeoutError = (err: any): boolean => {
  const name = String(err?.name || '').toLowerCase()
  const message = String(err?.message || err || '').toLowerCase()
  return name.includes('timeout') || name.includes('abort') ||
    message.includes('timeout') || message.includes('deadline') ||
    message.includes('aborted') || message.includes('canceled')
}

/**
 * 小米账号扫码登录：
 * serviceLogin(mijia) → longPolling/loginUrl 获取二维码 → lp 长轮询拿到 passToken
 * → refreshByPassToken 换取 micoapi serviceToken。
 */
export class MiotQRLogin {
  private cookieJar = new CookieJar()
  private deviceId: string
  private userAgent: string
  private pollUrl = ''
  private pollCount = 0
  private nonZeroStreak = 0

  constructor() {
    this.deviceId = generateDeviceId()
    this.userAgent = formatUserAgent(this.deviceId)
  }

  getDeviceId(): string {
    return this.deviceId
  }

  async getQRCode(): Promise<QRLoginInfo | null> {
    const serviceLoginUrl = `${ACCOUNT_BASE_URL}/pass/serviceLogin?sid=${QR_LOGIN_SID}&_json=true`
    const loginHeaders: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Cookie': `sdkVersion=3.8.6; deviceId=${this.deviceId}`,
    }

    let loginResult: Awaited<ReturnType<typeof fetchWithRedirects>>
    try {
      loginResult = await fetchWithRedirects(serviceLoginUrl, { method: 'GET', headers: loginHeaders }, this.cookieJar, 0)
    } catch (err: any) {
      miotLog.warn(`[MIoT] 扫码登录获取 serviceLogin 失败: ${err?.message || err}`)
      return null
    }

    let loginData: Record<string, unknown>
    try {
      loginData = JSON.parse(stripJsonPrefix(loginResult.text)) as Record<string, unknown>
    } catch {
      miotLog.warn('[MIoT] 扫码登录解析 serviceLogin 响应失败')
      return null
    }

    const sign = getStringValue(loginData, '_sign', '')
    const qs = getStringValue(loginData, 'qs', '')
    const callback = getStringValue(loginData, 'callback', '')
    if (!sign || !qs || !callback) {
      miotLog.warn('[MIoT] 扫码登录 serviceLogin 缺少 _sign/qs/callback')
      return null
    }

    const params = [
      '_qrsize=240',
      `qs=${encodeURIComponent(qs)}`,
      `sid=${QR_LOGIN_SID}`,
      `_sign=${encodeURIComponent(sign)}`,
      `callback=${encodeURIComponent(callback)}`,
      '_json=true',
      `_dc=${Date.now()}`,
    ].join('&')
    const qrRequestUrl = `${LONG_POLLING_URL}?${params}`

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    const jarCookie = this.cookieJar.getCookieHeader(qrRequestUrl)
    if (!jarCookie.includes('deviceId=')) {
      headers['Cookie'] = `sdkVersion=3.8.6; deviceId=${this.deviceId}`
    }

    let qrResult: Awaited<ReturnType<typeof fetchWithRedirects>>
    try {
      qrResult = await fetchWithRedirects(qrRequestUrl, { method: 'GET', headers }, this.cookieJar, 0)
    } catch (err: any) {
      miotLog.warn(`[MIoT] 扫码登录获取二维码失败: ${err?.message || err}`)
      return null
    }

    let qrData: Record<string, unknown>
    try {
      qrData = JSON.parse(stripJsonPrefix(qrResult.text)) as Record<string, unknown>
    } catch {
      miotLog.warn('[MIoT] 扫码登录解析二维码响应失败')
      return null
    }

    const code = Number(qrData.code || 0)
    if (code !== 0) {
      miotLog.warn(`[MIoT] 扫码登录二维码请求失败 code=${code} desc=${getStringValue(qrData, 'desc', '')}`)
      return null
    }

    const qrcodeUrl = getStringValue(qrData, 'qr', '')
    const loginUrl = getStringValue(qrData, 'loginUrl', '')
    const pollUrl = getStringValue(qrData, 'lp', '')
    if (!pollUrl) {
      miotLog.warn('[MIoT] 扫码登录响应缺少 lp 轮询地址')
      return null
    }

    this.pollUrl = pollUrl
    this.pollCount = 0
    this.nonZeroStreak = 0

    return {
      qrcodeUrl: this.normalizeUrl(qrcodeUrl || loginUrl),
      loginUrl: this.normalizeUrl(loginUrl),
    }
  }

  async poll(): Promise<QRPollResult> {
    if (!this.pollUrl) return { state: 'failed', message: '请先获取二维码' }

    this.pollCount++
    if (this.pollCount > MAX_POLL_COUNT) {
      return { state: 'expired', message: '二维码已过期，请刷新' }
    }

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    }

    let result: Awaited<ReturnType<typeof fetchWithRedirects>>
    try {
      result = await fetchWithRedirects(this.pollUrl, {
        method: 'GET',
        headers,
        timeoutMs: POLL_TIMEOUT_MS,
      }, this.cookieJar, 0)
    } catch (err: any) {
      // 长轮询阻塞到超时 = 用户还没扫码，继续等待
      if (isTimeoutError(err)) return { state: 'waiting', message: '等待扫码' }
      return { state: 'failed', message: `轮询失败: ${err?.message || err}` }
    }

    if (result.status === 403) return { state: 'expired', message: '二维码已过期，请刷新' }
    if (result.status >= 400) return { state: 'failed', message: `轮询失败: HTTP ${result.status}` }

    let data: Record<string, unknown>
    try {
      data = JSON.parse(stripJsonPrefix(result.text)) as Record<string, unknown>
    } catch {
      // 长轮询超时后的空响应也按等待处理
      return { state: 'waiting', message: '等待扫码' }
    }

    const code = Number(data.code || 0)
    if (code !== 0) {
      this.nonZeroStreak++
      miotLog.info(`[MIoT] 扫码登录轮询非零码 code=${code} streak=${this.nonZeroStreak}`)
      if (this.nonZeroStreak >= 2) return { state: 'expired', message: '二维码已过期，请刷新' }
      return { state: 'waiting', message: '等待扫码' }
    }
    this.nonZeroStreak = 0

    const passToken = getStringValue(data, 'passToken', '')
    const userId = getStringValue(data, 'userId', '')
    const cUserId = getStringValue(data, 'cUserId', '')
    if (!passToken || !userId) return { state: 'waiting', message: '等待扫码' }

    miotLog.info(`[MIoT] 扫码登录已确认 userId=${userId}，正在换取 serviceToken`)
    const tokenInfo = await this.exchangeToken(passToken, userId, cUserId)
    if (!tokenInfo) return { state: 'failed', message: '换取 serviceToken 失败，请重试' }

    return { state: 'confirmed', message: '登录成功', tokenInfo, passToken }
  }

  reset(): void {
    this.cookieJar.clear()
    this.pollUrl = ''
    this.pollCount = 0
    this.nonZeroStreak = 0
  }

  private async exchangeToken(passToken: string, userId: string, cUserId: string): Promise<MiotTokenInfo | null> {
    try {
      const auth = new MinaAuth()
      if (cUserId) auth.setCookie('cUserId', cUserId)
      const result = await auth.refreshByPassToken(passToken, userId, MINA_SID)
      if (result.state !== 'success' || !result.tokenInfo) {
        miotLog.warn(`[MIoT] 扫码登录换取 serviceToken 失败: ${result.error || result.state}`)
        return null
      }
      return result.tokenInfo
    } catch (err: any) {
      miotLog.warn(`[MIoT] 扫码登录换取 serviceToken 异常: ${err?.message || err}`)
      return null
    }
  }

  private normalizeUrl(url: string): string {
    if (!url) return ''
    if (url.startsWith('http://') || url.startsWith('https://')) return url
    return `${ACCOUNT_BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`
  }
}
