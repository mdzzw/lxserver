export interface AudioMeta {
  isAudio: boolean
  format: 'flac' | 'mp3' | 'mp4' | 'wav' | 'adts' | 'ogg' | 'unknown'
  durationSeconds: number | null
}

const unknownMeta = (format: AudioMeta['format'] = 'unknown'): AudioMeta => ({
  isAudio: true,
  format,
  durationSeconds: null,
})

const notAudio = (format: AudioMeta['format'] = 'unknown'): AudioMeta => ({
  isAudio: false,
  format,
  durationSeconds: null,
})

const PREVIEW_BYTES = 64 * 1024

export const AUDIO_PREFIX_BYTES = PREVIEW_BYTES

const MP3_BITRATES_MPEG1 = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
} as const

const MP3_BITRATES_MPEG2 = {
  1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const

const MP3_SAMPLE_RATES = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  25: [11025, 12000, 8000],
} as const

const ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

interface Mp3Header {
  version: 1 | 2 | 25
  layer: 1 | 2 | 3
  bitrateKbps: number
  sampleRate: number
  channelMode: number
  samplesPerFrame: number
}

const parseMp3Header = (buf: Buffer, offset: number): Mp3Header | null => {
  if (offset + 4 > buf.length) return null
  const b0 = buf[offset]
  const b1 = buf[offset + 1]
  const b2 = buf[offset + 2]
  const b3 = buf[offset + 3]
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null

  const versionBits = (b1 >> 3) & 0x03
  const layerBits = (b1 >> 1) & 0x03
  if (versionBits === 1 || layerBits === 0) return null

  const bitrateIndex = (b2 >> 4) & 0x0f
  const sampleRateIndex = (b2 >> 2) & 0x03
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null

  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25
  const layer = (4 - layerBits) as 1 | 2 | 3
  const bitrateTable = version === 1 ? MP3_BITRATES_MPEG1 : MP3_BITRATES_MPEG2
  const bitrateKbps = bitrateTable[layer][bitrateIndex]
  const sampleRate = MP3_SAMPLE_RATES[version][sampleRateIndex]
  if (!bitrateKbps || !sampleRate) return null

  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576
  return {
    version,
    layer,
    bitrateKbps,
    sampleRate,
    channelMode: (b3 >> 6) & 0x03,
    samplesPerFrame,
  }
}

const findMpegSync = (buf: Buffer, start: number, end: number): number => {
  const limit = Math.min(end, buf.length - 1)
  for (let i = Math.max(0, start); i < limit; i++) {
    if (buf[i] !== 0xff) continue
    if ((buf[i + 1] & 0xe0) !== 0xe0) continue
    if (((buf[i + 1] >> 1) & 0x03) === 0) continue
    return i
  }
  return -1
}

const mp3SideInfoSize = (header: Mp3Header): number => {
  const mono = header.channelMode === 3
  if (header.version === 1) return mono ? 17 : 32
  return mono ? 9 : 17
}

const parseMp3 = (buf: Buffer, totalBytes: number): AudioMeta => {
  let audioStart = 0
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
    audioStart = 10 + tagSize
  }

  // ID3 封面把首帧推出探测窗口：整段文件已读完仍无帧才算非音频，否则按未知处理避免误杀。
  if (audioStart >= buf.length) {
    return buf.length >= totalBytes && totalBytes > 0 ? notAudio('mp3') : unknownMeta('mp3')
  }

  const frameStart = findMpegSync(buf, audioStart, buf.length)
  if (frameStart < 0) {
    return buf.length >= totalBytes && totalBytes > 0 ? notAudio('mp3') : unknownMeta('mp3')
  }
  const header = parseMp3Header(buf, frameStart)
  if (!header) return unknownMeta('mp3')

  const xingOffset = frameStart + 4 + mp3SideInfoSize(header)
  if (xingOffset + 12 <= buf.length) {
    const tag = buf.toString('ascii', xingOffset, xingOffset + 4)
    if (tag === 'Xing' || tag === 'Info') {
      const flags = buf.readUInt32BE(xingOffset + 4)
      if (flags & 0x01) {
        const frames = buf.readUInt32BE(xingOffset + 8)
        if (frames > 0) {
          return { isAudio: true, format: 'mp3', durationSeconds: (frames * header.samplesPerFrame) / header.sampleRate }
        }
      }
    }
  }

  const vbriOffset = frameStart + 4 + 32
  if (vbriOffset + 18 <= buf.length && buf.toString('ascii', vbriOffset, vbriOffset + 4) === 'VBRI') {
    const frames = buf.readUInt32BE(vbriOffset + 14)
    if (frames > 0) {
      return { isAudio: true, format: 'mp3', durationSeconds: (frames * header.samplesPerFrame) / header.sampleRate }
    }
  }

  // 无 Xing/VBRI 时按首帧码率与文件体积估算，足以区分 4 秒试听与整曲。
  if (totalBytes > audioStart) {
    const audioBytes = totalBytes - audioStart
    return {
      isAudio: true,
      format: 'mp3',
      durationSeconds: (audioBytes * 8) / (header.bitrateKbps * 1000),
    }
  }
  return unknownMeta('mp3')
}

const parseFlac = (buf: Buffer): AudioMeta => {
  if (buf.length < 8) return unknownMeta('flac')
  let offset = 4
  while (offset + 4 <= buf.length) {
    const header = buf[offset]
    const blockType = header & 0x7f
    const last = (header & 0x80) !== 0
    const length = (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]
    const dataStart = offset + 4
    if (blockType === 0) {
      if (dataStart + 34 > buf.length) return unknownMeta('flac')
      const base = dataStart + 10
      const packed = buf.readBigUInt64BE(base)
      const sampleRate = Number(packed >> 44n)
      const totalSamples = Number(packed & 0x0fffffffffn)
      if (sampleRate > 0 && totalSamples > 0) {
        return { isAudio: true, format: 'flac', durationSeconds: totalSamples / sampleRate }
      }
      return unknownMeta('flac')
    }
    if (last) break
    offset = dataStart + length
  }
  return unknownMeta('flac')
}

const parseWav = (buf: Buffer): AudioMeta => {
  if (buf.length < 12) return unknownMeta('wav')
  let offset = 12
  let byteRate = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const dataStart = offset + 8
    if (id === 'fmt ' && dataStart + 12 <= buf.length) {
      byteRate = buf.readUInt32LE(dataStart + 8)
    } else if (id === 'data') {
      if (byteRate > 0) return { isAudio: true, format: 'wav', durationSeconds: size / byteRate }
      return unknownMeta('wav')
    }
    offset = dataStart + size + (size & 1)
  }
  return unknownMeta('wav')
}

const findMp4Box = (buf: Buffer, start: number, end: number, type: string): { start: number, end: number } | null => {
  let offset = start
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset)
    const boxType = buf.toString('ascii', offset + 4, offset + 8)
    let headerSize = 8
    if (size === 1) {
      if (offset + 16 > end) return null
      const large = buf.readBigUInt64BE(offset + 8)
      size = large > BigInt(end - offset) ? end - offset : Number(large)
      headerSize = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < headerSize) return null
    const boxEnd = Math.min(end, offset + size)
    if (boxType === type) return { start: offset + headerSize, end: boxEnd }
    offset = boxEnd
  }
  return null
}

const parseMp4 = (buf: Buffer): AudioMeta => {
  if (buf.length < 16) return unknownMeta('mp4')
  const moov = findMp4Box(buf, 0, buf.length, 'moov')
  if (!moov) return unknownMeta('mp4')
  const mvhd = findMp4Box(buf, moov.start, Math.min(moov.end, buf.length), 'mvhd')
  if (!mvhd) return unknownMeta('mp4')
  const p = mvhd.start
  if (p + 4 > buf.length) return unknownMeta('mp4')
  const version = buf[p]
  try {
    if (version === 1) {
      if (p + 32 > buf.length) return unknownMeta('mp4')
      const timescale = buf.readUInt32BE(p + 20)
      const duration = Number(buf.readBigUInt64BE(p + 24))
      if (timescale > 0 && duration > 0) return { isAudio: true, format: 'mp4', durationSeconds: duration / timescale }
    } else {
      if (p + 20 > buf.length) return unknownMeta('mp4')
      const timescale = buf.readUInt32BE(p + 12)
      const duration = buf.readUInt32BE(p + 16)
      if (timescale > 0 && duration > 0) return { isAudio: true, format: 'mp4', durationSeconds: duration / timescale }
    }
  } catch {
    return unknownMeta('mp4')
  }
  return unknownMeta('mp4')
}

const parseAdts = (buf: Buffer, totalBytes: number): AudioMeta => {
  let offset = 0
  while (offset + 7 <= buf.length && offset < 4096) {
    if (buf[offset] === 0xff && (buf[offset + 1] & 0xf0) === 0xf0) break
    offset++
  }
  if (offset + 7 > buf.length) return unknownMeta('adts')
  const sampleRateIndex = (buf[offset + 2] >> 2) & 0x0f
  const sampleRate = ADTS_SAMPLE_RATES[sampleRateIndex]
  const frameLength = ((buf[offset + 3] & 0x03) << 11) | (buf[offset + 4] << 3) | (buf[offset + 5] >> 5)
  if (!sampleRate || frameLength <= 0 || totalBytes <= 0) return unknownMeta('adts')
  const bitrate = (frameLength * 8 * sampleRate) / 1024
  return { isAudio: true, format: 'adts', durationSeconds: (totalBytes * 8) / bitrate }
}

/**
 * 从响应前缀解析真实音频时长：FLAC/WAV/MP4 读容器头，MP3 优先 Xing/VBRI 帧数，否则按首帧码率估算。
 * 解析不出来时返回 null（调用方应继续尝试播放，而不是仅凭体积拒绝）。
 */
export const parseAudioMeta = (buf: Buffer, totalBytes: number): AudioMeta => {
  if (buf.length < 4) return notAudio()

  if (buf.toString('ascii', 0, 4) === 'fLaC') return parseFlac(buf)
  if (buf.length >= 8 && buf.toString('ascii', 4, 8) === 'ftyp') return parseMp4(buf)
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return parseWav(buf)
  if (buf.toString('ascii', 0, 4) === 'OggS') return unknownMeta('ogg')
  if (buf.toString('ascii', 0, 3) === 'ID3') return parseMp3(buf, totalBytes)
  if (buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0) {
    if (((buf[1] >> 1) & 0x03) === 0) return parseAdts(buf, totalBytes)
    return parseMp3(buf, totalBytes)
  }

  const sync = findMpegSync(buf, 0, Math.min(buf.length, 4096))
  if (sync >= 0) return parseMp3(buf.subarray(sync), totalBytes - sync)

  return unknownMeta()
}

const TEXT_CONTENT_TYPE = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|javascript|problem\+json))/i

/** 错误页/接口报错常见 text/html、JSON 或直接以 < { [ 开头；音频二进制不会命中。 */
export const looksLikeTextResponse = (buf: Buffer, contentType: string): boolean => {
  if (TEXT_CONTENT_TYPE.test(contentType)) return true
  let start = 0
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3
  while (start < Math.min(buf.length, 64)) {
    const code = buf[start]
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      start++
      continue
    }
    return code === 0x3c || code === 0x7b || code === 0x5b
  }
  return false
}
