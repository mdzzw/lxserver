/** 起播确认阈值：设备位置推进到这里才算真正出声 */
export const STREAM_CONFIRM_POSITION_SEC = 3
/** 部分型号不回传 position 或位置恒为 0，连续两次 playing 视为已起播 */
export const STREAM_CONFIRM_SAMPLES = 2
/** 只在这个窗口内把“未起播即停止”归为拉流失败，避免误判自然结束 */
export const STREAM_FAIL_WINDOW_MS = 90 * 1000
/** 设备报停止后二次回读的间隔 */
export const STREAM_FAIL_VERIFY_MS = 2000
/** 我方 TTS/播报会打断流播放，期间不判定拉流失败 */
export const STREAM_TTS_GRACE_MS = 20 * 1000
/** 反复重拉同一播放地址的统计窗口 */
export const STREAM_LOOP_WINDOW_MS = 30 * 1000
/** 窗口内同一播放地址被重拉达到该次数，视为试听/截断流循环 */
export const STREAM_LOOP_MIN_FETCHES = 5

export type DeviceStopVerdict = 'ended' | 'stream-failed' | 'tts-interrupted' | 'defer'

export interface DeviceStopContext {
  position: number
  duration: number
  hasPosition: boolean
  devicePosition: number
  playConfirmed: boolean
  playStartedAt: number
  lastTtsAt: number
  now: number
}

/**
 * 设备上报 status=0 时判断停止原因。
 * ended：贴近结尾，交给结束定时器；
 * stream-failed：从未确认起播且位置未推进，典型为“没有版权/无可用音源”；
 * tts-interrupted：我方播报刚打断，先等待而不是删歌；
 * defer：已起播但中途停止、或超出判定窗口，沿用原逻辑。
 */
export const classifyDeviceStop = (context: DeviceStopContext): DeviceStopVerdict => {
  if (context.duration > 0 && context.position >= context.duration - 5) return 'ended'
  if (context.playConfirmed) return 'defer'
  if (context.lastTtsAt > 0 && context.now - context.lastTtsAt < STREAM_TTS_GRACE_MS) return 'tts-interrupted'
  if (!context.playStartedAt || context.now - context.playStartedAt > STREAM_FAIL_WINDOW_MS) return 'defer'
  if (context.hasPosition && context.devicePosition >= STREAM_CONFIRM_POSITION_SEC) return 'defer'
  return 'stream-failed'
}

/**
 * 试听/截断流播完后，音箱会立刻重新拉取同一地址并提示“没有版权”，
 * 但设备状态仍上报 playing，单靠停止事件无法发现。
 */
export const isStreamFetchLoop = (fetches: readonly number[], now: number): boolean => {
  let count = 0
  for (let index = fetches.length - 1; index >= 0; index--) {
    if (now - fetches[index] > STREAM_LOOP_WINDOW_MS) break
    count++
  }
  return count >= STREAM_LOOP_MIN_FETCHES
}
