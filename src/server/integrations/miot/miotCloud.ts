import { createHash, createHmac, randomBytes } from 'node:crypto'
import { formatUserAgent } from './constants'
import { miotLog } from './log'
import type { MiotServiceToken } from './types'

const CLOUD_BASE_URL = 'https://api.io.mi.com/app'
const REQUEST_TIMEOUT_MS = 15000
const INTELLIGENT_SPEAKER_SIID = 7
const EXECUTE_TEXT_DIRECTIVE_AIID = 4

const sha256Base64 = (key: Buffer, content: Buffer): string => {
  const hash = createHash('sha256')
  hash.update(key)
  hash.update(content)
  return hash.digest('base64')
}

/** nonce = base64(8 字节随机数 + 当前分钟数)，与小米云签名算法一致 */
const buildNonce = (): string => {
  const buffer = Buffer.alloc(12)
  randomBytes(8).copy(buffer, 0)
  buffer.writeUInt32BE(Math.floor(Date.now() / 60000) >>> 0, 8)
  return buffer.toString('base64')
}

interface CloudPayload {
  code?: number
  message?: string
  result?: unknown
}

interface CloudCallResult {
  status: number
  ok: boolean
  text: string
  payload: CloudPayload | null
}

export interface MiotCloudRefreshResult {
  serviceToken: MiotServiceToken
  userId?: string
}

export interface MiotCloudClientOptions {
  userId: string
  deviceId: string
  serviceToken: MiotServiceToken
  /** 云端返回鉴权失败时调用一次，换取新 token 后重试 */
  refreshToken?: () => Promise<MiotCloudRefreshResult>
}

/**
 * 小米云 MIoT 接口客户端（签名算法同 xiaomiio / Home Assistant xiaomi_miot）。
 * 目前只用于向音箱下发文本指令，让内置大模型做歌曲类型判断。
 */
export class MiotCloudClient {
  private userId: string
  private deviceId: string
  private serviceToken: MiotServiceToken
  private refreshToken?: () => Promise<MiotCloudRefreshResult>

  constructor(options: MiotCloudClientOptions) {
    this.userId = options.userId
    this.deviceId = options.deviceId
    this.serviceToken = options.serviceToken
    this.refreshToken = options.refreshToken
  }

  async executeTextDirective(did: string, text: string, silent = false): Promise<void> {
    await this.request('/miotspec/action', {
      params: {
        did,
        siid: INTELLIGENT_SPEAKER_SIID,
        aiid: EXECUTE_TEXT_DIRECTIVE_AIID,
        in: [text, silent ? 1 : 0],
      },
    })
  }

  private async request(path: string, data: Record<string, unknown>): Promise<unknown> {
    let result = await this.send(path, data)
    if (this.isAuthFailure(result) && this.refreshToken) {
      miotLog.warn(`[MIoT] 小米云鉴权失败（HTTP ${result.status}），重新获取授权后重试`)
      const refreshed = await this.refreshToken()
      this.serviceToken = refreshed.serviceToken
      if (refreshed.userId) this.userId = refreshed.userId
      result = await this.send(path, data)
      miotLog.info(`[MIoT] 小米云 token 已刷新，重试状态=${result.status}`)
    }

    if (!result.ok) {
      const detail = this.describeError(result)
      throw new Error(`小米云请求失败 HTTP ${result.status}${detail ? `：${detail}` : ''}`)
    }
    if (!result.payload) throw new Error('小米云返回内容无法解析')
    if (result.payload.code !== 0) {
      throw new Error(result.payload.message || `小米云返回错误码 ${result.payload.code ?? '未知'}`)
    }
    return result.payload.result
  }

  private async send(path: string, data: Record<string, unknown>): Promise<CloudCallResult> {
    if (!this.serviceToken.ssecurity) throw new Error('缺少小米云 ssecurity，请重新登录小米账号')
    const dataJson = JSON.stringify(data)
    const nonce = buildNonce()
    const signedNonce = sha256Base64(
      Buffer.from(this.serviceToken.ssecurity, 'base64'),
      Buffer.from(nonce, 'base64'),
    )
    const signature = createHmac('sha256', Buffer.from(signedNonce, 'base64'))
      .update(`${path}&${signedNonce}&${nonce}&data=${dataJson}`, 'utf8')
      .digest('base64')
    const body = new URLSearchParams({ data: dataJson, _nonce: nonce, signature }).toString()
    const token = this.serviceToken.service_token
    const headers: Record<string, string> = {
      'User-Agent': formatUserAgent(this.deviceId),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': '*/*',
      // 与实测成功的请求保持一致：PROTOCAL-HTTP2（miservice/插件同款），CLIENT-ONLY 可能导致 401
      'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
      'Cookie': [
        `userId=${this.userId}`,
        `yetAnotherServiceToken=${token}`,
        `serviceToken=${token}`,
        'locale=zh_CN',
        'timezone=Asia/Shanghai',
        'is_daylight=0',
        'dst_offset=0',
        'channel=MI_APP_STORE',
      ].join('; '),
    }

    let response: Response
    try {
      response = await fetch(`${CLOUD_BASE_URL}${path}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err: any) {
      throw new Error(`小米云连接失败: ${err?.message || err}`)
    }

    const text = await response.text()
    let payload: CloudPayload | null = null
    try {
      payload = JSON.parse(text) as CloudPayload
    } catch { /* 非 JSON 响应保持 null，由上层按状态码处理 */ }
    return { status: response.status, ok: response.ok, text, payload }
  }

  private isAuthFailure(result: CloudCallResult): boolean {
    if (result.status === 401 || result.status === 403) return true
    const code = Number(result.payload?.code)
    if (!Number.isFinite(code) || code === 0) return false
    return /auth|token|登录|授权|expired/i.test(String(result.payload?.message || ''))
  }

  private describeError(result: CloudCallResult): string {
    const message = String(result.payload?.message || '').trim()
    if (message) {
      const code = Number(result.payload?.code)
      return Number.isFinite(code) && code !== 0 ? `${message}（code ${code}）` : message
    }
    return result.text.replace(/\s+/g, ' ').trim().slice(0, 120)
  }
}
