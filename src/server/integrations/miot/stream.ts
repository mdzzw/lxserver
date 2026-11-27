import os from 'node:os'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { serveCacheFile } from '@/server/music/fileCache'
import { serveLocalTrack } from '@/server/music/subsonicLocal'
import { randomToken } from './crypto'
import { miotLog } from './log'
import { resolveSongSource, warmSongCache, warmVipDownload, type ResolvedSongSource } from './resolver'
import { isStreamFetchLoop } from './streamGuard'
import type { MiotSong, MiotStreamTicket } from './types'

const TICKET_TTL_MS = 3 * 3600 * 1000
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000
const STREAM_PREFIX = '/api/miot/stream/'
/** 每个 ticket 的拉流时间只用来识别循环重拉，保留两分钟即可 */
const FETCH_HISTORY_TTL_MS = 2 * 60 * 1000

const tickets = new Map<string, MiotStreamTicket>()
/** 设备端对同一播放地址的 GET 时间戳（升序），用于识别试听/截断流循环 */
const fetchHistory = new Map<string, number[]>()
let lastExternalHost = ''

setInterval(() => {
  const now = Date.now()
  for (const [token, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(token)
  }
  for (const [token, fetches] of fetchHistory) {
    const latest = fetches[fetches.length - 1] ?? 0
    if (now - latest > FETCH_HISTORY_TTL_MS) fetchHistory.delete(token)
  }
}, CLEANUP_INTERVAL_MS).unref()

const recordStreamFetch = (token: string, now: number): void => {
  const fetches = fetchHistory.get(token)
  if (!fetches) {
    fetchHistory.set(token, [now])
    return
  }
  const cutoff = now - FETCH_HISTORY_TTL_MS
  let stale = 0
  while (stale < fetches.length && fetches[stale] < cutoff) stale++
  if (stale > 0) fetches.splice(0, stale)
  fetches.push(now)
}

/**
 * 试听/截断流播完后音箱会立即重拉同一地址并提示“没有版权”，
 * 设备状态却一直是 playing，不触发停止事件，只能靠拉流频率识别。
 */
export const isStreamUrlLooping = (url: string, now = Date.now()): boolean => {
  if (!url) return false
  const marker = '/api/miot/stream/'
  const at = url.indexOf(marker)
  if (at < 0) return false
  const token = url.slice(at + marker.length).split(/[.?/]/)[0]
  const fetches = fetchHistory.get(token)
  return !!fetches && isStreamFetchLoop(fetches, now)
}

const isLocalHost = (host: string): boolean => {
  const hostname = host.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0'
}

export const recordExternalHost = (host: string | undefined): void => {
  if (host && !isLocalHost(host)) lastExternalHost = host
}

const lanAddress = (): string => {
  const interfaces = os.networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

export const getStreamBaseUrl = (configuredBaseUrl: string): string => {
  const configured = configuredBaseUrl.trim()
  if (configured) return configured.replace(/\/+$/, '')
  if (lastExternalHost) return `http://${lastExternalHost}`
  const port = Number((global.lx.config as any).port) || 9527
  return `http://${lanAddress()}:${port}`
}

const streamExtension = (resolved: ResolvedSongSource): string => {
  let ext = ''
  if (resolved.kind === 'local') ext = resolved.localTrack?.suffix ?? ''
  else if (resolved.kind === 'cache') ext = (resolved.filename ?? '').split('.').pop() ?? ''
  else if (resolved.remoteUrl) {
    try {
      ext = new URL(resolved.remoteUrl).pathname.split('.').pop() ?? ''
    } catch { /* default below */ }
  }
  ext = ext.toLowerCase()
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'mp3'
}

export interface CreatedStream {
  url: string
  /** 探测到的真实音频时长（秒），用于校准标注时长不准时的结束定时 */
  durationSeconds: number | null
}

export const createStreamUrl = async (
  accountId: string,
  deviceId: string,
  song: MiotSong,
  username: string,
  quality: string,
  options: { publicBaseUrl: string; cacheOnPlay: boolean; vipAutoDownload: boolean },
): Promise<CreatedStream | null> => {
  const resolved = await resolveSongSource(song, username, quality)
  if (!resolved) return null

  if (resolved.kind === 'remote') {
    // 歌单同步数据可能不带 vip 字段：无法确认是免费歌曲时按 VIP 处理，避免漏下载。
    if (options.vipAutoDownload && song.vip !== false) {
      warmVipDownload(song, username, resolved)
    } else if (options.cacheOnPlay) {
      warmSongCache(song, username, resolved)
    }
  }

  const token = randomToken(18)
  const now = Date.now()
  tickets.set(token, {
    token,
    accountId,
    deviceId,
    song,
    username,
    quality: resolved.quality,
    kind: resolved.kind,
    localTrack: resolved.localTrack,
    filename: resolved.filename,
    folder: resolved.folder,
    remoteUrl: resolved.remoteUrl,
    createdAt: now,
    expiresAt: now + TICKET_TTL_MS,
    lastAccessAt: now,
  })
  miotLog.info(`[MIoT] stream ticket ${resolved.kind} "${song.name}" device=${deviceId} quality=${resolved.quality}`)
  return {
    url: `${getStreamBaseUrl(options.publicBaseUrl)}${STREAM_PREFIX}${token}.${streamExtension(resolved)}`,
    durationSeconds: resolved.durationSeconds ?? null,
  }
}

const PROXY_HEADERS_TIMEOUT_MS = 20000
const PROXY_IDLE_TIMEOUT_MS = 60000

const proxyRemote = async (req: http.IncomingMessage, res: http.ServerResponse, remoteUrl: string): Promise<void> => {
  const headers: Record<string, string> = {
    'User-Agent': 'LX-Music-MIoT/2.2',
    'Accept': '*/*',
  }
  if (req.headers.range) headers.Range = req.headers.range

  const controller = new AbortController()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null } }
  // 上游长时间不响应或中途卡死时主动断开，避免失败拉流一直挂着拖慢整体请求
  const armIdle = () => {
    clearIdle()
    idleTimer = setTimeout(() => controller.abort(), PROXY_IDLE_TIMEOUT_MS)
  }
  const headerTimer = setTimeout(() => controller.abort(), PROXY_HEADERS_TIMEOUT_MS)
  res.once('close', () => { clearTimeout(headerTimer); clearIdle(); controller.abort() })

  let upstream: Response
  try {
    upstream = await fetch(remoteUrl, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, redirect: 'follow', signal: controller.signal })
  } catch (err: any) {
    clearTimeout(headerTimer)
    miotLog.warn(`[MIoT] stream upstream fetch failed: ${err?.message || err}`)
    if (!res.headersSent) res.writeHead(502)
    res.end()
    return
  }
  clearTimeout(headerTimer)

  res.statusCode = upstream.status
  const contentType = upstream.headers.get('content-type')
  if (contentType) res.setHeader('Content-Type', contentType)
  const contentLength = upstream.headers.get('content-length')
  if (contentLength) res.setHeader('Content-Length', contentLength)
  const contentRange = upstream.headers.get('content-range')
  if (contentRange) res.setHeader('Content-Range', contentRange)
  res.setHeader('Accept-Ranges', 'bytes')

  if (req.method === 'HEAD' || !upstream.body) {
    res.end()
    return
  }

  const stream = Readable.fromWeb(upstream.body as any)
  armIdle()
  stream.on('data', armIdle)
  stream.on('end', clearIdle)
  stream.on('close', clearIdle)
  stream.on('error', () => { clearIdle(); res.destroy() })
  res.once('close', () => { clearIdle(); stream.destroy() })
  stream.pipe(res)
}

export const handleMiotStream = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
  const pathname = (req.url ?? '').split('?')[0]
  if (!pathname.startsWith(STREAM_PREFIX)) return false

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Cache-Control', 'no-store')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return true
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return true
  }

  const token = pathname.slice(STREAM_PREFIX.length).split('.')[0]
  const ticket = tickets.get(token)
  if (!ticket) {
    res.writeHead(404)
    res.end('stream ticket not found')
    return true
  }
  if (ticket.expiresAt <= Date.now()) {
    tickets.delete(token)
    res.writeHead(410)
    res.end('stream ticket expired')
    return true
  }
  ticket.lastAccessAt = Date.now()
  if (req.method === 'GET') recordStreamFetch(token, ticket.lastAccessAt)

  try {
    if (ticket.kind === 'local' && ticket.localTrack) {
      serveLocalTrack(req, res, ticket.localTrack, false)
      return true
    }
    if (ticket.kind === 'cache' && ticket.filename) {
      serveCacheFile(req, res, ticket.filename, ticket.username || undefined, ticket.folder)
      return true
    }
    if (ticket.kind === 'remote' && ticket.remoteUrl) {
      await proxyRemote(req, res, ticket.remoteUrl)
      return true
    }
    res.writeHead(500)
    res.end('invalid stream ticket')
  } catch (err: any) {
    miotLog.warn(`[MIoT] stream error: ${err?.message || err}`)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }
  return true
}
