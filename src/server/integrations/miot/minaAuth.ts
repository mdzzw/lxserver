import { CookieJar, fetchBinary, fetchWithRedirects } from './http'
import { computeClientSign, generateDeviceId, md5 } from './crypto'
import {
  ACCOUNT_BASE_URL,
  LoginState,
  MAX_REDIRECTS,
  MINA_SID,
  SERVICE_TOKEN_VALID_HOURS,
  formatUserAgent,
} from './constants'
import { miotLog } from './log'
import type { AuthLoginResult, CaptchaResult } from './models'
import type { MiotTokenInfo } from './types'

const stripJsonPrefix = (body: string): string => body.replace('&&&START&&&', '').trim()

/**
 * 从原始 JSON 字符串中用正则提取大整数字段（nonce/userId），
 * 避免 JSON.parse 对大整数四舍五入导致 clientSign 计算错误。
 */
const extractBigIntField = (jsonStr: string, field: string): string => {
  const match = jsonStr.match(new RegExp(`"${field}"\\s*:\\s*(\\d+)`))
  return match ? match[1] : ''
}

const getStringValue = (obj: Record<string, unknown>, key: string, defaultValue: string): string => {
  const value = obj[key]
  if (value === undefined || value === null) return defaultValue
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(Math.floor(value))
  return String(value)
}

const appendQueryParams = (url: string, params: Record<string, string>): string => {
  const sep = url.includes('?') ? '&' : '?'
  const body = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  return `${url}${sep}${body}`
}

const encodeFormData = (params: Record<string, string>): string =>
  Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')

const getSetCookieValue = (headers: string[], name: string): string => {
  for (const header of headers) {
    const firstPart = header.split(';', 1)[0] ?? ''
    const eq = firstPart.indexOf('=')
    if (eq <= 0) continue
    if (firstPart.slice(0, eq).trim() === name) return firstPart.slice(eq + 1).trim()
  }
  return ''
}

/**
 * 小米账号认证：serviceLogin → serviceLoginAuth2 → location 重定向换取 serviceToken。
 * 支持密码登录、图形验证码、短信/邮箱验证码和 passToken 刷新。
 */
export class MinaAuth {
  private cookieJar = new CookieJar()
  private deviceId: string
  private userAgent: string

  private captchaIck = ''
  private verifyUrl = ''
  private loginData: Record<string, unknown> | null = null
  private username = ''
  private password = ''

  private tokenInfo: MiotTokenInfo

  constructor(deviceId?: string) {
    this.deviceId = deviceId || generateDeviceId()
    this.userAgent = formatUserAgent(this.deviceId)
    const now = new Date()
    this.tokenInfo = {
      user_id: '',
      device_id: this.deviceId,
      services: {},
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + SERVICE_TOKEN_VALID_HOURS * 3600 * 1000).toISOString(),
    }
  }

  getTokenInfo(): MiotTokenInfo {
    return this.tokenInfo
  }

  getPassToken(): string {
    return this.cookieJar.getValue('passToken')
  }

  /** 注入外部获取的 Cookie（扫码登录换 serviceToken 时需要 cUserId） */
  setCookie(name: string, value: string, domain = 'xiaomi.com'): void {
    if (!name || !value) return
    this.cookieJar.add([{ name, value, domain, path: '/' }])
  }

  async login(username: string, password: string): Promise<AuthLoginResult> {
    this.username = username
    this.password = password
    return this.loginService(MINA_SID)
  }

  async loginService(sid: string): Promise<AuthLoginResult> {
    const step1 = await this.loginStep1(sid)
    if (!step1) return { state: LoginState.FAILED, error: 'step1 failed: no response' }
    this.loginData = step1
    return this.loginStep2WithPassword(step1, '', sid)
  }

  async loginWithCaptcha(captcha: string, sid = MINA_SID): Promise<AuthLoginResult> {
    if (!this.loginData) return { state: LoginState.FAILED, error: 'please call login first' }
    return this.loginStep2WithPassword(this.loginData, captcha, sid)
  }

  async loginWithVerifyCode(verifyCode: string, sid = MINA_SID): Promise<AuthLoginResult> {
    if (!this.verifyUrl) return { state: LoginState.FAILED, error: 'no verify url, please call login first' }

    const location = await this.verifyTicket(verifyCode)
    if (!location) return { state: LoginState.FAILED, error: 'verify failed: no location returned' }

    await this.followRedirectsForCookies(location)

    const passToken = this.cookieJar.getValue('passToken')
    const userId = this.cookieJar.getValue('userId')
    if (!passToken) return { state: LoginState.FAILED, error: 'no passToken after verify' }

    return this.exchangeServiceToken(passToken, userId, sid)
  }

  async getCaptchaImage(captchaUrl: string): Promise<CaptchaResult> {
    const headers: Record<string, string> = { 'User-Agent': this.userAgent }
    const cookieHeader = this.cookieJar.getCookieHeader(captchaUrl)
    if (cookieHeader) headers.Cookie = cookieHeader

    const result = await fetchBinary(captchaUrl, headers, this.cookieJar)
    miotLog.info(`[MIoT] captcha fetch status=${result.status} content-type=${result.contentType} bytes=${result.data.length}`)

    if (result.data.length === 0) miotLog.warn('[MIoT] captcha image is empty')

    const ick = this.cookieJar.getValue('ick')
    this.captchaIck = ick
    return { imageBase64: result.data.toString('base64'), ick }
  }

  async submitSMSCode(notificationUrl: string, code: string): Promise<string> {
    this.verifyUrl = notificationUrl
    return (await this.verifyTicket(code)) || ''
  }

  async refreshByPassToken(passToken: string, userId: string, sid = MINA_SID): Promise<AuthLoginResult> {
    return this.exchangeServiceToken(passToken, userId, sid)
  }

  private async loginStep1(sid: string): Promise<Record<string, unknown> | null> {
    const loginUrl = `${ACCOUNT_BASE_URL}/pass/serviceLogin?sid=${sid}&_json=true`
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Cookie': `sdkVersion=3.8.6; deviceId=${this.deviceId}`,
    }
    const result = await fetchWithRedirects(loginUrl, { method: 'GET', headers }, this.cookieJar, 0)
    try {
      return JSON.parse(stripJsonPrefix(result.text)) as Record<string, unknown>
    } catch {
      return null
    }
  }

  private async loginStep2WithPassword(
    auth: Record<string, unknown>,
    captcha: string,
    sid: string,
  ): Promise<AuthLoginResult> {
    const loginUrl = `${ACCOUNT_BASE_URL}/pass/serviceLoginAuth2?_json=true`
    const formParams: Record<string, string> = {
      user: this.username,
      hash: md5(this.password).toUpperCase(),
      callback: getStringValue(auth, 'callback', ''),
      sid: getStringValue(auth, 'sid', sid),
      qs: getStringValue(auth, 'qs', ''),
      _sign: getStringValue(auth, '_sign', ''),
    }
    if (captcha) formParams.captCode = captcha

    let cookieStr = this.cookieJar.getCookieHeader(loginUrl)
    if (captcha && this.captchaIck) {
      cookieStr = cookieStr ? `${cookieStr}; ick=${this.captchaIck}` : `ick=${this.captchaIck}`
    }

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    if (cookieStr) headers.Cookie = cookieStr

    let result: MiotFetchText
    try {
      result = await fetchWithRedirects(loginUrl, {
        method: 'POST',
        headers,
        body: encodeFormData(formParams),
      }, this.cookieJar, 0)
    } catch (err: any) {
      return { state: LoginState.FAILED, error: `step2 request failed: ${err?.message || err}` }
    }

    const jsonStr = stripJsonPrefix(result.text)
    let data: Record<string, unknown>
    try {
      data = JSON.parse(jsonStr) as Record<string, unknown>
    } catch {
      return { state: LoginState.FAILED, error: `parse response failed: ${jsonStr.slice(0, 200)}` }
    }

    miotLog.info(`[MIoT] login step2 code=${data.code} desc=${String(data.description ?? '')} hasLocation=${!!data.location} hasCaptcha=${!!data.captchaUrl} hasNotification=${!!data.notificationUrl}`)

    if (data.notificationUrl) {
      let notificationUrl = data.notificationUrl as string
      if (!notificationUrl.startsWith('http')) notificationUrl = ACCOUNT_BASE_URL + notificationUrl
      this.verifyUrl = notificationUrl
      return {
        state: LoginState.NEED_VERIFY,
        verifyUrl: notificationUrl,
        verifyType: notificationUrl.includes('email') ? 'email' : 'phone',
      }
    }

    const captchaFields = ['captchaUrl', 'captchaURL', 'captcha_url', 'captcha', 'imgUrl']
    let captchaUrlRaw = ''
    for (const field of captchaFields) {
      const value = data[field]
      if (typeof value === 'string' && value.trim()) {
        captchaUrlRaw = value.trim()
        break
      }
    }
    if (captchaUrlRaw) {
      let captchaUrl = captchaUrlRaw
      if (!captchaUrl.startsWith('http')) captchaUrl = ACCOUNT_BASE_URL + captchaUrl
      try {
        const captchaResult = await this.getCaptchaImage(captchaUrl)
        return { state: LoginState.NEED_CAPTCHA, captchaImage: captchaResult.imageBase64 }
      } catch (err: any) {
        miotLog.warn(`[MIoT] getCaptchaImage failed: ${err?.message || err}`)
        return { state: LoginState.NEED_CAPTCHA, captchaImage: '', error: `获取验证码图片失败: ${err?.message || err}` }
      }
    }

    const location = getStringValue(data, 'location', '')
    if (!location) {
      return {
        state: LoginState.FAILED,
        error: `login failed, code: ${String(data.code)}, desc: ${String(data.description)}, sid: ${sid}`,
      }
    }

    const ssecurity = getStringValue(data, 'ssecurity', '')
    // nonce 可能是超过 2^53 的大整数，必须从原始文本提取
    const nonce = extractBigIntField(jsonStr, 'nonce') || getStringValue(data, 'nonce', '')
    const userId = getStringValue(data, 'userId', '')
    const clientSign = computeClientSign(nonce, ssecurity)
    const locationWithSign = appendQueryParams(location, { _userIdNeedEncrypt: 'true', clientSign })

    const step3Error = await this.loginStep3(locationWithSign, sid, ssecurity)
    if (step3Error) return { state: LoginState.FAILED, error: `step3 failed: ${step3Error}` }

    if (!this.tokenInfo.user_id && userId) this.tokenInfo.user_id = userId
    this.tokenInfo.device_id = this.deviceId
    return { state: LoginState.SUCCESS, tokenInfo: this.tokenInfo }
  }

  private async loginStep3(location: string, sid: string, ssecurityFromStep2 = ''): Promise<string | null> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    let final: Awaited<ReturnType<typeof fetchWithRedirects>>
    try {
      final = await fetchWithRedirects(location, { method: 'GET', headers }, this.cookieJar, MAX_REDIRECTS)
    } catch (err: any) {
      return `request failed: ${err?.message || err}`
    }

    const serviceToken = getSetCookieValue(final.setCookies, 'serviceToken') ||
      this.cookieJar.getValue('serviceToken')
    const userId = this.cookieJar.getValue('userId')
    // 本次 serviceLogin 返回的 ssecurity 与即将签发的 token 配套，Cookie 里可能是上一次会话的旧值
    const ssecurity = ssecurityFromStep2 || this.cookieJar.getValue('ssecurity')

    if (!serviceToken) {
      return `failed to get serviceToken, status: ${final.status}, body: ${final.text.slice(0, 200)}`
    }

    if (!this.tokenInfo.user_id && userId) this.tokenInfo.user_id = userId
    this.tokenInfo.services[sid] = {
      service_token: serviceToken,
      ssecurity,
      expires_at: Date.now() + SERVICE_TOKEN_VALID_HOURS * 3600 * 1000,
    }
    return null
  }

  private async exchangeServiceToken(passToken: string, userId: string, sid: string): Promise<AuthLoginResult> {
    const serviceLoginUrl = `${ACCOUNT_BASE_URL}/pass/serviceLogin?sid=${sid}&_json=true`
    const cookieParts = [
      `passToken=${passToken}`,
      `userId=${userId}`,
      `deviceId=${this.deviceId}`,
      'sdkVersion=3.8.6',
    ]
    const cUserId = this.cookieJar.getValue('cUserId')
    if (cUserId) cookieParts.push(`cUserId=${cUserId}`)

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Cookie': cookieParts.join('; '),
    }

    let result: MiotFetchText
    try {
      result = await fetchWithRedirects(serviceLoginUrl, { method: 'GET', headers }, this.cookieJar, 0)
    } catch (err: any) {
      return { state: LoginState.FAILED, error: `serviceLogin request failed: ${err?.message || err}` }
    }

    const jsonStr = stripJsonPrefix(result.text)
    let data: Record<string, unknown>
    try {
      data = JSON.parse(jsonStr) as Record<string, unknown>
    } catch {
      return { state: LoginState.FAILED, error: `parse serviceLogin response failed: ${jsonStr.slice(0, 200)}` }
    }

    const code = Number(data.code || 0)
    if (code !== 0) {
      return { state: LoginState.FAILED, error: `serviceLogin for ${sid} failed: code=${code}, desc=${getStringValue(data, 'desc', 'unknown')}` }
    }

    const location = getStringValue(data, 'location', '')
    const ssecurity = getStringValue(data, 'ssecurity', '')
    if (!location) return { state: LoginState.FAILED, error: `serviceLogin for ${sid} returned no location URL` }

    const newUserId = getStringValue(data, 'userId', '')
    if (newUserId) this.tokenInfo.user_id = newUserId

    const nonce = extractBigIntField(jsonStr, 'nonce') || getStringValue(data, 'nonce', '')
    const locationWithSign = appendQueryParams(location, {
      _userIdNeedEncrypt: 'true',
      clientSign: computeClientSign(nonce, ssecurity),
    })

    const step3Error = await this.loginStep3(locationWithSign, sid, ssecurity)
    if (step3Error) return { state: LoginState.FAILED, error: `step3 failed: ${step3Error}` }

    if (!this.tokenInfo.user_id && userId) this.tokenInfo.user_id = userId
    return { state: LoginState.SUCCESS, tokenInfo: this.tokenInfo }
  }

  private async verifyTicket(ticket: string): Promise<string | null> {
    if (this.verifyUrl.includes('/fe/service/identity/authStart')) await this.checkIdentityList()

    let verifyAPI = '/identity/auth/verifyPhone'
    let flag = '4'
    if (this.verifyUrl.includes('email')) {
      verifyAPI = '/identity/auth/verifyEmail'
      flag = '8'
    }

    const apiUrl = `${ACCOUNT_BASE_URL}${verifyAPI}?_dc=${Date.now()}`
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    const cookieStr = this.cookieJar.getCookieHeader(apiUrl)
    if (cookieStr) headers.Cookie = cookieStr

    let result: MiotFetchText
    try {
      result = await fetchWithRedirects(apiUrl, {
        method: 'POST',
        headers,
        body: encodeFormData({ ticket, trust: 'true', _json: 'true', _flag: flag }),
      }, this.cookieJar, 0)
    } catch {
      return null
    }

    try {
      const data = JSON.parse(stripJsonPrefix(result.text)) as Record<string, unknown>
      if (Number(data.code) !== 0) return null
      return getStringValue(data, 'location', '') || null
    } catch {
      return null
    }
  }

  private async checkIdentityList(): Promise<void> {
    const listUrl = this.verifyUrl.replace('/fe/service/identity/authStart', '/identity/list')
    const headers: Record<string, string> = { 'User-Agent': this.userAgent }
    const cookieStr = this.cookieJar.getCookieHeader(listUrl)
    if (cookieStr) headers.Cookie = cookieStr
    try {
      await fetchWithRedirects(listUrl, { method: 'GET', headers }, this.cookieJar, 0)
    } catch { /* non-fatal */ }
  }

  private async followRedirectsForCookies(location: string): Promise<void> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    try {
      await fetchWithRedirects(location, { method: 'GET', headers }, this.cookieJar, MAX_REDIRECTS)
    } catch { /* non-fatal, passToken might already be obtained */ }
  }
}

type MiotFetchText = Awaited<ReturnType<typeof fetchWithRedirects>>
