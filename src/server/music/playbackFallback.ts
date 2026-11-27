import fs from 'node:fs'
import path from 'node:path'
import { File } from '@/constants'
import { getUserSpace } from '@/user'
import { DEFAULT_PLAYBACK_FALLBACK, parsePlaybackFallbackConfig, type PlaybackFallbackConfig } from './playbackFallbackConfig'

export type { PlaybackFallbackConfig }
export { DEFAULT_PLAYBACK_FALLBACK, parsePlaybackFallbackConfig }

export const openLibraryUser = (username: string): string => {
  const name = String(username || '').trim()
  return !name || name === 'default' || name === 'open' ? '_open' : name
}

/** 小爱与落雪网页共用同一份用户设置：换源/降品开关与优先级。 */
export const readUserPlaybackFallback = (username: string): PlaybackFallbackConfig => {
  try {
    const userSpace = getUserSpace(openLibraryUser(username))
    const settingsPath = path.join(userSpace.dataManage.userDir, File.userSettingsJSON)
    if (!fs.existsSync(settingsPath)) return { ...DEFAULT_PLAYBACK_FALLBACK }
    return parsePlaybackFallbackConfig(JSON.parse(fs.readFileSync(settingsPath, 'utf8')))
  } catch {
    return { ...DEFAULT_PLAYBACK_FALLBACK }
  }
}

export const parseSongIntervalSeconds = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  const text = String(value ?? '').trim()
  if (!text) return 0
  if (/^\d+$/.test(text)) return Number(text)
  const parts = text.split(':').map(Number)
  if (parts.length >= 2 && parts.every(Number.isFinite)) return parts.reduce((total, part) => total * 60 + part, 0)
  const numeric = Number(text)
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0
}
