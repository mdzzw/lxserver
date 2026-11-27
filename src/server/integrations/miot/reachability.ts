import { AUDIO_PREFIX_BYTES, looksLikeTextResponse, parseAudioMeta } from './audioProbe'

const PROBE_TIMEOUT_MS = 2000
const DEEP_PROBE_TIMEOUT_MS = 3000
const PROBE_HEADERS = {
  'User-Agent': 'LX-Music-MIoT/2.2',
  'Accept': '*/*',
  'Range': 'bytes=0-1',
}

/**
 * 体积只用来判断“是否值得进一步核对时长”：明显小于 48kbps 估算值时才读音频头，
 * 不再仅凭体积拒绝，避免把确实很短的儿歌/纯音乐误判为试听。
 */
const MIN_BYTES_PER_SECOND = 6000
const MIN_DURATION_FOR_SIZE_CHECK = 30
/**
 * 标注时长缺失/不可信时，小于该体积的链接一律核对音频头：
 * 4 秒试听常见的 20KB~600KB 文件会被识别并按真实时长拒绝。
 */
const MIN_ABSOLUTE_PROBE_BYTES = 1024 * 1024

/** 已确认时长的音频低于该值才视为试听/截断；短儿歌只要真实时长达到该值就照常播放。 */
export const MIN_PLAYABLE_SECONDS = 10

export type RemoteUrlVerdict = 'ok' | 'unreachable' | 'trial' | 'invalid'

export interface RemoteUrlInspection {
  verdict: RemoteUrlVerdict
  totalBytes: number
  durationSeconds: number | null
  contentType: string
}

interface ProbeResponse {
  ok: boolean
  totalBytes: number
  contentType: string
  playlist: boolean
}

const parseTotalBytes = (res: Response): number => {
  const contentRange = res.headers.get('content-range') ?? ''
  const rangeMatch = /\/\s*(\d+)\s*$/.exec(contentRange)
  if (rangeMatch) return Number(rangeMatch[1]) || 0
  if (res.status === 200) {
    const length = Number(res.headers.get('content-length') ?? 0)
    return Number.isFinite(length) && length > 0 ? length : 0
  }
  return 0
}

const isPlaylistLocation = (url: string, contentType: string): boolean => {
  if (contentType.includes('mpegurl') || contentType.includes('scpls')) return true
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    return pathname.endsWith('.m3u8') || pathname.endsWith('.pls')
  } catch {
    return false
  }
}

/**
 * 音箱最终通过本机代理拉流：服务器拿不到首包就提前降品/换源，避免把 522/死链下发给音箱。
 * 用 GET Range 而非 HEAD，部分源不支持 HEAD 但对真实播放请求可用。
 */
const probeRemoteUrl = async (url: string, timeoutMs: number): Promise<ProbeResponse> => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, totalBytes: 0, contentType: '', playlist: false }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, totalBytes: 0, contentType: '', playlist: false }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: PROBE_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, totalBytes: 0, contentType: '', playlist: false }
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    const totalBytes = parseTotalBytes(res)
    const playlist = isPlaylistLocation(url, contentType)
    if (res.body) {
      try {
        await res.body.cancel()
      } catch {
        // 释放探测连接失败不影响可达性结论
      }
    }
    return { ok: true, totalBytes, contentType, playlist }
  } catch {
    return { ok: false, totalBytes: 0, contentType: '', playlist: false }
  } finally {
    clearTimeout(timer)
  }
}

const readBodyPrefix = async (res: Response, limit: number): Promise<Buffer> => {
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (size < limit) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.length) continue
      const remaining = limit - size
      const slice = value.length > remaining ? value.subarray(0, remaining) : value
      chunks.push(Buffer.from(slice))
      size += slice.length
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // 已经读完或无流可取消
    }
  }
  return Buffer.concat(chunks, size)
}

/** 只为体积可疑的链接读取音频头；读取失败时保持“可达”结论，避免二次探测失败误杀。 */
const probeAudioPrefix = async (url: string, timeoutMs = DEEP_PROBE_TIMEOUT_MS): Promise<Buffer | null> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...PROBE_HEADERS, Range: `bytes=0-${AUDIO_PREFIX_BYTES - 1}` },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!res.ok) return null
    return await readBodyPrefix(res, AUDIO_PREFIX_BYTES)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export const inspectRemoteUrl = async (
  url: string,
  expectedSeconds = 0,
  timeoutMs = PROBE_TIMEOUT_MS,
  deepTimeoutMs = DEEP_PROBE_TIMEOUT_MS,
): Promise<RemoteUrlInspection> => {
  const probed = await probeRemoteUrl(url, timeoutMs)
  const base = { totalBytes: probed.totalBytes, durationSeconds: null, contentType: probed.contentType }
  if (!probed.ok) return { verdict: 'unreachable', ...base }
  if (probed.playlist) return { verdict: 'ok', ...base }

  const sizeSuspicious = probed.totalBytes > 0 && (
    probed.totalBytes < MIN_ABSOLUTE_PROBE_BYTES ||
    (expectedSeconds >= MIN_DURATION_FOR_SIZE_CHECK && probed.totalBytes < expectedSeconds * MIN_BYTES_PER_SECOND)
  )
  if (!sizeSuspicious) return { verdict: 'ok', ...base }

  const prefix = await probeAudioPrefix(url, deepTimeoutMs)
  if (!prefix || prefix.length === 0) return { verdict: 'ok', ...base }
  if (prefix.subarray(0, 7).toString('ascii') === '#EXTM3U') return { verdict: 'ok', ...base }

  const meta = parseAudioMeta(prefix, probed.totalBytes)
  if (!meta.isAudio) {
    return { verdict: 'invalid', ...base }
  }
  if (meta.format === 'unknown' && looksLikeTextResponse(prefix, probed.contentType)) {
    return { verdict: 'invalid', ...base }
  }
  if (meta.durationSeconds != null && meta.durationSeconds < MIN_PLAYABLE_SECONDS) {
    return { verdict: 'trial', ...base, durationSeconds: meta.durationSeconds }
  }
  return { verdict: 'ok', ...base, durationSeconds: meta.durationSeconds }
}

export const isRemoteUrlPlayable = async (url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> => {
  const probed = await probeRemoteUrl(url, timeoutMs)
  return probed.ok
}

export const isRemoteUrlPlayableForSong = async (
  url: string,
  expectedSeconds: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> => (await inspectRemoteUrl(url, expectedSeconds, timeoutMs)).verdict === 'ok'
