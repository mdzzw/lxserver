import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { looksLikeTextResponse, parseAudioMeta } from '../src/server/integrations/miot/audioProbe'
import { parsePlaybackFallbackConfig } from '../src/server/music/playbackFallbackConfig'
import { inspectRemoteUrl, isRemoteUrlPlayable, isRemoteUrlPlayableForSong } from '../src/server/integrations/miot/reachability'

const withServer = async (handler: http.RequestListener) => {
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

/** 首帧 128kbps/44.1kHz，带 Xing 帧数，可精确推算时长。 */
const makeMp3 = (frames: number, totalLength = 1024) => {
  const buf = Buffer.alloc(totalLength)
  buf[0] = 0xff
  buf[1] = 0xfb
  buf[2] = 0x90
  buf[3] = 0x00
  const xing = 4 + 32
  buf.write('Xing', xing, 'ascii')
  buf.writeUInt32BE(0x01, xing + 4)
  buf.writeUInt32BE(frames, xing + 8)
  return buf
}

const makeFlac = (seconds: number, sampleRate = 44100) => {
  const buf = Buffer.alloc(42)
  buf.write('fLaC', 0, 'ascii')
  buf[4] = 0x80
  buf.writeUIntBE(34, 5, 3)
  const totalSamples = BigInt(Math.round(seconds * sampleRate))
  const packed = (BigInt(sampleRate) << 44n) | totalSamples
  buf.writeBigUInt64BE(packed, 18)
  return buf
}

const makeMp4 = (seconds: number, timescale = 1000) => {
  const ftyp = Buffer.alloc(16)
  ftyp.writeUInt32BE(16, 0)
  ftyp.write('ftyp', 4, 'ascii')
  ftyp.write('M4A ', 8, 'ascii')
  const mvhd = Buffer.alloc(32)
  mvhd.writeUInt32BE(32, 0)
  mvhd.write('mvhd', 4, 'ascii')
  mvhd[8] = 0
  mvhd.writeUInt32BE(timescale, 20)
  mvhd.writeUInt32BE(Math.round(seconds * timescale), 24)
  const moov = Buffer.alloc(8 + mvhd.length)
  moov.writeUInt32BE(moov.length, 0)
  moov.write('moov', 4, 'ascii')
  mvhd.copy(moov, 8)
  return Buffer.concat([ftyp, moov])
}

const makeWav = (seconds: number, byteRate = 16000) => {
  const dataSize = Math.round(seconds * byteRate)
  const buf = Buffer.alloc(44)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(44100, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  return buf
}

const makeId3Only = () => {
  const buf = Buffer.alloc(64)
  buf.write('ID3', 0, 'ascii')
  return buf
}

/** 第一次只回 2 字节给体积探测，第二次返回音频头给时长校验。 */
const audioServer = async (audio: Buffer, totalBytes = audio.length, contentType = 'audio/mpeg') => withServer((req, res) => {
  const range = String(req.headers.range || '')
  if (range === 'bytes=0-1') {
    res.writeHead(206, { 'Content-Type': contentType, 'Content-Range': `bytes 0-1/${totalBytes}` })
    res.end(audio.subarray(0, 2))
    return
  }
  res.writeHead(206, { 'Content-Type': contentType, 'Content-Range': `bytes 0-${audio.length - 1}/${totalBytes}` })
  res.end(audio)
})

test('reachable range response passes and keeps proxy headers', async t => {
  let range = ''
  let userAgent = ''
  const server = await withServer((req, res) => {
    range = String(req.headers.range || '')
    userAgent = String(req.headers['user-agent'] || '')
    res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 0-1/100' })
    res.end('ab')
  })
  t.after(server.close)
  assert.equal(await isRemoteUrlPlayable(`${server.base}/song.mp3`), true)
  assert.equal(range, 'bytes=0-1')
  assert.equal(userAgent, 'LX-Music-MIoT/2.2')
})

test('source ignoring range but returning 200 still passes', async t => {
  const server = await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
    res.end('audio')
  })
  t.after(server.close)
  assert.equal(await isRemoteUrlPlayable(`${server.base}/song.mp3`), true)
})

test('upstream 522 is treated as unreachable', async t => {
  const server = await withServer((_req, res) => {
    res.writeHead(522)
    res.end()
  })
  t.after(server.close)
  assert.equal(await isRemoteUrlPlayable(`${server.base}/dead.mp3`), false)
})

test('hanging upstream times out', async t => {
  const server = await withServer(() => {})
  t.after(server.close)
  assert.equal(await isRemoteUrlPlayable(`${server.base}/hang.mp3`, 100), false)
})

test('invalid or non-http url is rejected without a request', async () => {
  assert.equal(await isRemoteUrlPlayable('not a url'), false)
  assert.equal(await isRemoteUrlPlayable('ftp://example.com/song.mp3'), false)
})

test('confirmed 4s clip is still rejected as trial', async t => {
  const audio = makeMp3(172)
  const server = await audioServer(audio, 300000)
  t.after(server.close)
  const inspection = await inspectRemoteUrl(`${server.base}/trial.mp3`, 158)
  assert.equal(inspection.verdict, 'trial')
  assert.ok((inspection.durationSeconds || 0) < 6)
  assert.equal(await isRemoteUrlPlayableForSong(`${server.base}/trial.mp3`, 158), false)
})

test('short children song with real audio is accepted even if smaller than catalog duration', async t => {
  const audio = makeMp3(1187) // ≈31s
  const server = await audioServer(audio, 300000)
  t.after(server.close)
  const inspection = await inspectRemoteUrl(`${server.base}/child.mp3`, 158)
  assert.equal(inspection.verdict, 'ok')
  assert.ok((inspection.durationSeconds || 0) > 30)
  assert.equal(await isRemoteUrlPlayableForSong(`${server.base}/child.mp3`, 158), true)
})

test('audio-looking response with unknown duration is not rejected by size alone', async t => {
  const audio = Buffer.alloc(4096, 0x11)
  const server = await audioServer(audio, 21755)
  t.after(server.close)
  const inspection = await inspectRemoteUrl(`${server.base}/unknown.mp3`, 158)
  assert.equal(inspection.verdict, 'ok')
  assert.equal(inspection.durationSeconds, null)
})

test('html error page served as audio is rejected as invalid', async t => {
  const html = Buffer.from('<!DOCTYPE html><html><body>copyright unavailable</body></html>')
  const server = await audioServer(html, 21755)
  t.after(server.close)
  const inspection = await inspectRemoteUrl(`${server.base}/error.mp3`, 158)
  assert.equal(inspection.verdict, 'invalid')
})

test('mp3 with only an ID3 tag contains no playable frames', async t => {
  const audio = makeId3Only()
  const server = await audioServer(audio, audio.length)
  t.after(server.close)
  assert.equal((await inspectRemoteUrl(`${server.base}/empty.mp3`, 158)).verdict, 'invalid')
})

test('full-size response skips the deep duration probe and passes', async t => {
  let requests = 0
  const server = await withServer((req, res) => {
    requests++
    const range = String(req.headers.range || '')
    res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Range': `bytes 0-1/${(158 * 6000) + 1}` })
    res.end(range === 'bytes=0-1' ? 'ab' : 'unexpected')
  })
  t.after(server.close)
  const inspection = await inspectRemoteUrl(`${server.base}/song.mp3`, 158)
  assert.equal(inspection.verdict, 'ok')
  assert.equal(requests, 1)
})

test('unknown total size is not rejected', async t => {
  const server = await withServer((_req, res) => {
    res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 0-1/*' })
    res.end('ab')
  })
  t.after(server.close)
  assert.equal(await isRemoteUrlPlayableForSong(`${server.base}/song.mp3`, 158), true)
})

test('playlist responses and short songs skip the size check', async t => {
  const playlistServer = await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
    res.end('#EXTM3U')
  })
  t.after(playlistServer.close)
  assert.equal(await isRemoteUrlPlayableForSong(`${playlistServer.base}/song.m3u8`, 158), true)

  const tinyServer = await withServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '20000' })
    res.end('x')
  })
  t.after(tinyServer.close)
  assert.equal(await isRemoteUrlPlayableForSong(`${tinyServer.base}/short.mp3`, 10), true)
})

test('audio meta parser reads duration from common containers', () => {
  const flac = parseAudioMeta(makeFlac(158), makeFlac(158).length)
  assert.equal(flac.format, 'flac')
  assert.ok(Math.abs((flac.durationSeconds || 0) - 158) < 0.01)

  const flacTrial = parseAudioMeta(makeFlac(4), makeFlac(4).length)
  assert.ok((flacTrial.durationSeconds || 0) < 5)

  const mp4 = parseAudioMeta(makeMp4(200), makeMp4(200).length)
  assert.equal(mp4.format, 'mp4')
  assert.ok(Math.abs((mp4.durationSeconds || 0) - 200) < 0.01)

  const wav = parseAudioMeta(makeWav(4), makeWav(4).length)
  assert.equal(wav.format, 'wav')
  assert.ok(Math.abs((wav.durationSeconds || 0) - 4) < 0.01)

  const mp3 = parseAudioMeta(makeMp3(6000), 5000000)
  assert.equal(mp3.format, 'mp3')
  assert.ok(Math.abs((mp3.durationSeconds || 0) - (6000 * 1152) / 44100) < 0.01)

  const binary = parseAudioMeta(Buffer.alloc(2048, 0x7f), 2048)
  assert.equal(binary.isAudio, true)
  assert.equal(binary.durationSeconds, null)
})

test('text response sniffing recognizes html and json bodies', () => {
  assert.equal(looksLikeTextResponse(Buffer.from('<!DOCTYPE html>'), 'audio/mpeg'), true)
  assert.equal(looksLikeTextResponse(Buffer.from('  {"code":403}'), ''), true)
  assert.equal(looksLikeTextResponse(Buffer.from('  [1,2,3]'), ''), true)
  assert.equal(looksLikeTextResponse(makeMp3(172), 'audio/mpeg'), false)
})

test('fallback config mirrors web settings and defaults to platform-first', () => {
  assert.deepEqual(parsePlaybackFallbackConfig({}), {
    switchPlatform: true,
    degradeQuality: true,
    platformFirst: true,
  })
  assert.deepEqual(parsePlaybackFallbackConfig({ playbackErrorPriority: 'quality,platform,next' }), {
    switchPlatform: true,
    degradeQuality: true,
    platformFirst: false,
  })
  assert.deepEqual(parsePlaybackFallbackConfig({ playbackErrorPriority: 'platform,quality,next' }), {
    switchPlatform: true,
    degradeQuality: true,
    platformFirst: true,
  })
  assert.deepEqual(parsePlaybackFallbackConfig({
    playbackErrorPriority: 'platform,quality,next',
    enableAutoSwitchSource: false,
    enableAutoDegradeQuality: false,
  }), {
    switchPlatform: false,
    degradeQuality: false,
    platformFirst: true,
  })
  assert.equal(parsePlaybackFallbackConfig({ playbackErrorPriority: 'unknown' }).platformFirst, true)
})
