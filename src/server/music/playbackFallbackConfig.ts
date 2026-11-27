export interface PlaybackFallbackConfig {
  switchPlatform: boolean
  degradeQuality: boolean
  platformFirst: boolean
}

export const DEFAULT_PLAYBACK_FALLBACK: PlaybackFallbackConfig = {
  switchPlatform: true,
  degradeQuality: true,
  platformFirst: true,
}

/**
 * 与落雪网页端 settings 对齐：
 * - enableAutoSwitchSource / enableAutoDegradeQuality 控制换源、降品是否允许；
 * - playbackErrorPriority 的逗号顺序决定先换源还是先降品（next 由 MIoT 删除+下一首兜底）。
 */
export const parsePlaybackFallbackConfig = (saved: any): PlaybackFallbackConfig => {
  const order = String(saved?.playbackErrorPriority || 'platform,quality,next').split(',').map(item => item.trim())
  const platformIndex = order.indexOf('platform')
  const qualityIndex = order.indexOf('quality')
  return {
    switchPlatform: saved?.enableAutoSwitchSource !== false,
    degradeQuality: saved?.enableAutoDegradeQuality !== false,
    platformFirst: qualityIndex < 0 || (platformIndex >= 0 && platformIndex < qualityIndex),
  }
}
