import type http from 'node:http'
import { getMiotService } from './service'
import { getStreamBaseUrl, handleMiotStream, recordExternalHost } from './stream'
import { listPlaylists } from './library'
import { searchSongs } from './resolver'
import { getDefaultVoiceCommands } from './voiceDefaults'
import { miotLog } from './log'
import type { MiotPlayer } from './player'
import type { MiotPlaybackView } from './types'

const MAX_BODY_BYTES = 2 * 1024 * 1024

const sendJson = (res: http.ServerResponse, status: number, payload: unknown): void => {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

const readJsonBody = async (req: http.IncomingMessage): Promise<Record<string, any>> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed as Record<string, any>
}

const requireString = (value: unknown, field: string): string => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`缺少参数 ${field}`)
  return text
}

const viewForClient = (view: MiotPlaybackView | null) => {
  if (!view) return null
  const { songs, ...rest } = view
  return { ...rest, count: songs.length }
}

const playerFor = (accountId: unknown, deviceId: unknown) => {
  const service = getMiotService()
  const player = service.getPlayer(requireString(accountId, 'accountId'), requireString(deviceId, 'deviceId'))
  if (!player) throw new Error('账号或设备不存在，请先同步设备')
  return player
}

const replyPlayer = async (res: http.ServerResponse, player: MiotPlayer, ok: boolean, extra: Record<string, any> = {}) => {
  sendJson(res, 200, { success: ok, ...extra, playback: viewForClient(await player.getView()) })
}

const route = async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> => {
  const service = getMiotService()
  const method = req.method || 'GET'

  if (pathname === '/api/miot/status' && method === 'GET') {
    const settings = service.getSettings()
    sendJson(res, 200, {
      success: true,
      settings,
      promptDefaults: service.getPromptDefaults(),
      ai: service.getAiState(),
      accounts: service.getAccountsSafe(),
      devices: service.listDevices(),
      streamBaseUrl: getStreamBaseUrl(settings.public_base_url),
      voiceCount: service.store.getVoiceCommands().length,
      lxUsers: (global.lx.config.users || []).map(user => user.name),
    })
    return
  }

  if (pathname === '/api/miot/ai' && method === 'GET') {
    sendJson(res, 200, { success: true, ...service.getAiState() })
    return
  }

  if (pathname === '/api/miot/ai/clear-error' && method === 'POST') {
    sendJson(res, 200, { success: true, ...service.clearAiError() })
    return
  }

  if (pathname === '/api/miot/devices' && method === 'GET') {
    const devices = service.listDevices()
    const playback = await Promise.all(devices.map(device => service.getPlayback(device.accountId, device.deviceId)))
    sendJson(res, 200, {
      success: true,
      devices,
      playback: playback.map(viewForClient),
    })
    return
  }

  if (pathname === '/api/miot/settings' && method === 'GET') {
    sendJson(res, 200, { success: true, settings: service.getSettings(), promptDefaults: service.getPromptDefaults() })
    return
  }

  if (pathname === '/api/miot/settings' && method === 'POST') {
    const body = await readJsonBody(req)
    try {
      const settings = service.updateSettings(body)
      sendJson(res, 200, { success: true, settings, promptDefaults: service.getPromptDefaults(), ai: service.getAiState() })
    } catch (err: any) {
      sendJson(res, 400, { success: false, message: err?.message || String(err), ai: service.getAiState() })
    }
    return
  }

  if (pathname === '/api/miot/login' && method === 'POST') {
    const body = await readJsonBody(req)
    const result = await service.login(requireString(body.username, 'username'), requireString(body.password, 'password'))
    sendJson(res, 200, { success: result.state === 'success', ...result })
    return
  }

  if (pathname === '/api/miot/login/captcha' && method === 'POST') {
    const body = await readJsonBody(req)
    const result = await service.loginWithCaptcha(requireString(body.loginId, 'loginId'), requireString(body.captcha, 'captcha'))
    sendJson(res, 200, { success: result.state === 'success', ...result })
    return
  }

  if (pathname === '/api/miot/login/verify' && method === 'POST') {
    const body = await readJsonBody(req)
    const result = await service.loginWithVerifyCode(requireString(body.loginId, 'loginId'), requireString(body.code, 'code'))
    sendJson(res, 200, { success: result.state === 'success', ...result })
    return
  }

  if (pathname === '/api/miot/login/token' && method === 'POST') {
    const body = await readJsonBody(req)
    const result = await service.loginWithToken(
      String(body.username || ''),
      requireString(body.userId, 'userId'),
      requireString(body.serviceToken, 'serviceToken'),
      String(body.ssecurity || ''),
    )
    sendJson(res, 200, { success: result.state === 'success', ...result })
    return
  }

  if (pathname === '/api/miot/login/qrcode' && method === 'POST') {
    const result = await service.startQRCodeLogin()
    sendJson(res, 200, result)
    return
  }

  if (pathname === '/api/miot/login/qrcode/poll' && method === 'POST') {
    const body = await readJsonBody(req)
    const result = await service.pollQRCode(requireString(body.loginId, 'loginId'))
    sendJson(res, 200, result)
    return
  }

  if (pathname === '/api/miot/logout' && method === 'POST') {
    const body = await readJsonBody(req)
    service.logout(requireString(body.accountId, 'accountId'))
    sendJson(res, 200, { success: true })
    return
  }

  if (pathname === '/api/miot/devices/sync' && method === 'POST') {
    const body = await readJsonBody(req)
    const accountId = requireString(body.accountId, 'accountId')
    await service.syncDevices(accountId)
    sendJson(res, 200, { success: true, devices: service.listDevices().filter(device => device.accountId === accountId) })
    return
  }

  if (pathname === '/api/miot/device' && method === 'POST') {
    const body = await readJsonBody(req)
    const accountId = requireString(body.accountId, 'accountId')
    const deviceId = requireString(body.deviceId, 'deviceId')
    const device = service.updateDevice(accountId, deviceId, body)
    if (!device) {
      sendJson(res, 404, { success: false, message: '设备不存在' })
      return
    }
    const info = service.listDevices().find(item => item.accountId === accountId && item.deviceId === deviceId)
    sendJson(res, 200, { success: true, device: info })
    return
  }

  if (pathname === '/api/miot/playlists' && method === 'GET') {
    const settings = service.getSettings()
    try {
      const playlists = await listPlaylists(settings.username)
      sendJson(res, 200, { success: true, playlists, username: settings.username })
    } catch (err: any) {
      sendJson(res, 200, { success: false, message: `读取歌单失败: ${err?.message || err}`, playlists: [] })
    }
    return
  }

  if (pathname === '/api/miot/search' && method === 'GET') {
    const urlObj = new URL(req.url || '', 'http://localhost')
    const keyword = (urlObj.searchParams.get('keyword') || '').trim()
    const settings = service.getSettings()
    const songs = keyword ? await searchSongs(keyword, settings.username, 15) : []
    sendJson(res, 200, { success: true, songs })
    return
  }

  if (pathname === '/api/miot/play' && method === 'POST') {
    const body = await readJsonBody(req)
    const player = playerFor(body.accountId, body.deviceId)
    if (Array.isArray(body.songs) && body.songs.length > 0) {
      const ok = await player.playSongs(body.songs, String(body.name || '手动播放'), { announce: false })
      await replyPlayer(res, player, ok)
      return
    }
    const listId = requireString(body.listId, 'listId')
    const ok = await player.playPlaylist(listId, { announce: false })
    await replyPlayer(res, player, ok)
    return
  }

  if (pathname === '/api/miot/play/index' && method === 'POST') {
    const body = await readJsonBody(req)
    const player = playerFor(body.accountId, body.deviceId)
    const index = Math.max(0, Math.floor(Number(body.index) || 0))
    const ok = await player.playAt(index)
    await replyPlayer(res, player, ok)
    return
  }

  if (pathname === '/api/miot/player' && method === 'POST') {
    const body = await readJsonBody(req)
    const player = playerFor(body.accountId, body.deviceId)
    const action = requireString(body.action, 'action')
    let ok = false
    let extra: Record<string, any> = {}

    switch (action) {
      case 'pause':
        extra.result = await player.pause()
        ok = extra.result === 'paused'
        break
      case 'resume':
        ok = await player.resume()
        break
      case 'stop':
        ok = await player.stop()
        break
      case 'next':
        ok = await player.next()
        break
      case 'previous':
        ok = await player.previous()
        break
      case 'replay':
        ok = await player.replayCurrent()
        break
      case 'volume':
        ok = await player.setVolume(Number(body.value) || 0)
        extra.volume = (await player.getView()).volume
        break
      case 'sync-volume':
        extra.volume = await player.syncVolume()
        ok = extra.volume >= 0
        break
      case 'mode':
        extra.mode = await player.setMode(body.value)
        ok = true
        break
      case 'favorite':
        ok = await player.favoriteCurrent(body.value === 'remove' ? 'remove' : 'add')
        break
      case 'add-to-list':
        extra.result = await player.addCurrentToList(requireString(body.listId, 'listId'))
        ok = extra.result === 'added' || extra.result === 'exists'
        break
      case 'sleep':
        extra.sleep = body.mode === 'songs'
          ? player.setSleepTimer('songs', Number(body.value) || 0)
          : player.setSleepTimer('time', Number(body.value) || 0)
        ok = true
        break
      case 'cancel-sleep':
        ok = player.cancelSleepTimer()
        break
      default:
        sendJson(res, 400, { success: false, message: `未知操作 ${action}` })
        return
    }

    await replyPlayer(res, player, ok, extra)
    return
  }

  if (pathname === '/api/miot/playback' && method === 'GET') {
    const urlObj = new URL(req.url || '', 'http://localhost')
    const player = playerFor(urlObj.searchParams.get('accountId'), urlObj.searchParams.get('deviceId'))
    sendJson(res, 200, { success: true, playback: viewForClient(await player.getView()) })
    return
  }

  if (pathname === '/api/miot/voice/log' && method === 'GET') {
    const urlObj = new URL(req.url || '', 'http://localhost')
    sendJson(res, 200, {
      success: true,
      messages: service.getVoiceLog(urlObj.searchParams.get('accountId') || undefined, urlObj.searchParams.get('deviceId') || undefined),
    })
    return
  }

  if (pathname === '/api/miot/voice/test' && method === 'POST') {
    const body = await readJsonBody(req)
    const result = await service.testVoice(
      requireString(body.query, 'query'),
      body.accountId || undefined,
      body.deviceId || undefined,
      body.execute === true,
    )
    sendJson(res, 200, { success: true, ...result })
    return
  }

  if (pathname === '/api/miot/voice/commands' && method === 'GET') {
    sendJson(res, 200, { success: true, commands: service.store.getVoiceCommands() })
    return
  }

  if (pathname === '/api/miot/voice/commands' && method === 'POST') {
    const body = await readJsonBody(req)
    if (!Array.isArray(body.commands)) {
      sendJson(res, 400, { success: false, message: 'commands 必须是数组' })
      return
    }
    const commands = service.store.updateVoiceCommands(body.commands)
    service.restartMonitors()
    sendJson(res, 200, { success: true, commands })
    return
  }

  if (pathname === '/api/miot/voice/commands/reset' && method === 'POST') {
    const commands = service.store.updateVoiceCommands(getDefaultVoiceCommands())
    service.restartMonitors()
    sendJson(res, 200, { success: true, commands })
    return
  }

  sendJson(res, 404, { success: false, message: `未知接口 ${pathname}` })
}

/**
 * `/api/miot/stream/*` 需要设备直接访问，走一次性 token 鉴权；
 * 其余 `/api/miot/*` 与后台一致，要求 `x-frontend-auth`。
 */
export const handleMiotRequest = async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> => {
  if (!pathname.startsWith('/api/miot/')) return false
  recordExternalHost(req.headers.host)

  if (pathname.startsWith('/api/miot/stream/')) return handleMiotStream(req, res)

  const auth = req.headers['x-frontend-auth']
  if (auth !== global.lx.config['admin.password']) {
    sendJson(res, 401, { success: false, message: 'Unauthorized' })
    return true
  }

  try {
    await route(req, res, pathname)
  } catch (err: any) {
    miotLog.warn(`[MIoT] API ${req.method} ${pathname} 失败: ${err?.message || err}`)
    if (!res.headersSent) sendJson(res, 500, { success: false, message: err?.message || String(err) })
    else res.end()
  }
  return true
}
