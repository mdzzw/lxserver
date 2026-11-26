import { LIST_IDS } from '@/constants'
import { songKey } from './aiRecommend'
import { addSongToList, addSongToLoved, isSongLoved, loadPlaylist, removeSongFromList, removeSongFromLoved, type LoadedPlaylist } from './library'
import { miotLog } from './log'
import { normalizePlayMode, type MiotStore } from './store'
import { createStreamUrl } from './stream'
import {
  classifyDeviceStop,
  MAX_STREAM_FAIL_STREAK,
  STREAM_CONFIRM_POSITION_SEC,
  STREAM_CONFIRM_SAMPLES,
  STREAM_FAIL_VERIFY_MS,
} from './streamGuard'
import type {
  MiotDeviceController,
  MiotDevicePlayState,
  MiotPlaybackView,
  MiotPlayerStatus,
  MiotPlayMode,
  MiotSettings,
  MiotSong,
  PersistedPlayback,
} from './types'

const TEMP_LIST_ID = 'miot_search'
const STATUS_POLL_MS = 15000
const END_TIMER_GRACE_MS = 3000
const MAX_CONSECUTIVE_SKIP = 3
const MAX_SCAN_SKIP = 20
const RECOMMEND_BATCH = 20
const MAX_RECOMMEND_ATTEMPTS = 3

export interface MiotPlayerContext {
  store: MiotStore
  controller: MiotDeviceController
  getSettings: () => MiotSettings
  recommend?: (seed: MiotSong, exclude: string[], limit: number) => Promise<{ songs: MiotSong[]; type: string } | null>
}

export interface PlayOptions {
  announce?: boolean
  consumeSleepSong?: boolean
  haltOnFailure?: boolean
  autoRecommend?: boolean
}

interface SleepTimerState {
  mode: 'time' | 'songs'
  total: number
  expiresAt: number
  remainingSongs: number
  timer: ReturnType<typeof setTimeout> | null
}

const parseDuration = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  const text = String(value ?? '').trim()
  if (!text) return 0
  if (/^\d+$/.test(text)) return Number(text)
  const parts = text.split(':').map(Number)
  if (parts.length >= 2 && parts.every(Number.isFinite)) return parts.reduce((total, part) => total * 60 + part, 0)
  const numeric = Number(text)
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0
}

const formatDuration = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds))
  const min = Math.floor(total / 60)
  const sec = total % 60
  return `${min}:${String(sec).padStart(2, '0')}`
}

/**
 * 单台小爱音箱的播放队列与状态机。
 * 队列只保存列表 ID + 索引；临时搜索结果才随播放记录持久化整份歌曲。
 */
export class MiotPlayer {
  readonly accountId: string
  readonly deviceId: string
  private context: MiotPlayerContext

  private loaded = false
  private status: MiotPlayerStatus = 'idle'
  private listId: string = LIST_IDS.DEFAULT
  private listName = '试听列表'
  private songs: MiotSong[] = []
  private index = -1
  private mode: MiotPlayMode = 'order'
  private positionBase = 0
  private startedAt = 0
  private duration = 0
  private volume = 0
  private error = ''
  private updatedAt = 0
  private generation = 0
  private endTimer: ReturnType<typeof setTimeout> | null = null
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  private sleep: SleepTimerState | null = null
  private lastFailureRemoved = false
  private playStartedAt = 0
  private playConfirmed = false
  private playingSamples = 0
  private lastTtsAt = 0
  private streamFailureHandling = false
  private streamFailureStreak = 0
  private autoRecommend = false
  private recommendSeed: MiotSong | null = null
  private recommendType = ''
  private recommendPool: MiotSong[] = []
  private recommendPending: Promise<MiotSong[]> | null = null
  private recommendPlayed = new Set<string>()
  private recommendAttempts = 0

  constructor(accountId: string, deviceId: string, context: MiotPlayerContext) {
    this.accountId = accountId
    this.deviceId = deviceId
    this.context = context
  }

  private get settings(): MiotSettings {
    return this.context.getSettings()
  }

  private get controller(): MiotDeviceController {
    return this.context.controller
  }

  private get store(): MiotStore {
    return this.context.store
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const device = this.store.getDevice(this.accountId, this.deviceId)
    this.volume = device?.volume ?? 0
    this.mode = normalizePlayMode(device?.play_mode)
    const persisted = this.store.getPlayback(this.accountId, this.deviceId)
    if (!persisted) return
    try {
      await this.restorePlayback(persisted)
    } catch (err: any) {
      miotLog.warn(`[MIoT] 恢复播放记录失败: ${err?.message || err}`)
    }
  }

  private async restorePlayback(persisted: PersistedPlayback): Promise<void> {
    this.mode = normalizePlayMode(persisted.mode)
    let playlist: LoadedPlaylist | null
    if (persisted.list_id === TEMP_LIST_ID && Array.isArray(persisted.songs) && persisted.songs.length > 0) {
      playlist = { id: TEMP_LIST_ID, name: persisted.list_name || '语音搜索', songs: persisted.songs as MiotSong[] }
    } else {
      playlist = await loadPlaylist(this.settings.username, persisted.list_id)
    }
    if (!playlist || playlist.songs.length === 0) return
    this.listId = playlist.id
    this.listName = playlist.name
    this.songs = playlist.songs
    this.index = Math.max(0, Math.min(this.songs.length - 1, Number(persisted.index) || 0))
    this.status = 'stopped'
    this.positionBase = 0
    this.startedAt = 0
    this.duration = parseDuration(this.songs[this.index]?.interval)
    this.updatedAt = Date.now()
  }

  private currentSong(): MiotSong | null {
    return this.songs[this.index] ?? null
  }

  private position(): number {
    if (this.status !== 'playing' || !this.startedAt) return Math.max(0, this.positionBase)
    const elapsed = (Date.now() - this.startedAt) / 1000
    const value = this.positionBase + elapsed
    return this.duration > 0 ? Math.min(this.duration, value) : value
  }

  private clearTimers(): void {
    if (this.endTimer) clearTimeout(this.endTimer)
    if (this.statusTimer) clearTimeout(this.statusTimer)
    this.endTimer = null
    this.statusTimer = null
  }

  /**
   * 单曲播放失败时必须让音箱停下：设备侧只有一个单曲循环列表，
   * 否则会继续播放上一个成功下发的 URL，表现为“上一首一直重复”。
   */
  private async haltDevice(generation: number): Promise<void> {
    if (generation !== this.generation) return
    try {
      await this.controller.stop(this.accountId, this.deviceId)
    } catch (err: any) {
      miotLog.warn(`[MIoT] 播放失败后停止设备异常: ${err?.message || err}`)
    }
  }

  /**
   * 所有播放策略（本地/缓存/原平台降音质/多 API 源/跨平台换源）都失败后才删除歌曲；
   * 临时搜索队列（miot_search）不在落雪歌单里，跳过。
   */
  private async dropUnplayableSong(song: MiotSong, reason = '所有音源均无法播放'): Promise<boolean> {
    if (this.listId === TEMP_LIST_ID) return false
    try {
      await removeSongFromList(this.settings.username, this.listId, song)
      miotLog.info(`[MIoT] ${reason}，已从歌单 "${this.listName}" 删除 "${song.name}"`)
      return true
    } catch (err: any) {
      miotLog.warn(`[MIoT] 从歌单删除 "${song.name}" 失败: ${err?.message || err}`)
      return false
    }
  }

  private persist(): void {
    if (this.index < 0 || this.songs.length === 0) return
    this.store.setPlayback(this.accountId, this.deviceId, {
      account_id: this.accountId,
      device_id: this.deviceId,
      list_id: this.listId,
      list_name: this.listName,
      songs: this.listId === TEMP_LIST_ID ? this.songs.slice(0, 200) : [],
      index: this.index,
      mode: this.mode,
      updated_at: Date.now(),
    })
  }

  private async say(text: string): Promise<void> {
    this.lastTtsAt = Date.now()
    try {
      await this.controller.textToSpeech(this.accountId, this.deviceId, text)
    } catch (err: any) {
      miotLog.warn(`[MIoT] TTS failed: ${err?.message || err}`)
    }
    this.lastTtsAt = Date.now()
  }

  private resetRecommendState(autoRecommend: boolean, seed?: MiotSong): void {
    this.autoRecommend = autoRecommend && !!seed
    this.recommendSeed = this.autoRecommend ? seed! : null
    this.recommendType = ''
    this.recommendPool = []
    this.recommendPending = null
    this.recommendPlayed = new Set(seed ? [songKey(seed)] : [])
    this.recommendAttempts = 0
  }

  /** 队列只剩 1 首时后台预取下一批同类推荐，尽量在播完前准备好 */
  private maybePrepareRecommendations(): void {
    if (!this.autoRecommend || !this.recommendSeed || !this.context.recommend) return
    if (this.recommendPending || this.recommendPool.length > 0) return
    if (this.recommendAttempts >= MAX_RECOMMEND_ATTEMPTS) return
    if (this.songs.length - 1 - this.index > 1) return
    void this.prepareRecommendations().catch(() => {})
  }

  private prepareRecommendations(): Promise<MiotSong[]> {
    if (this.recommendPending) return this.recommendPending
    const seed = this.recommendSeed
    const recommend = this.context.recommend
    if (!seed || !recommend || !this.autoRecommend) return Promise.resolve([])

    const exclude = new Set<string>([...this.recommendPlayed, ...this.songs.map(song => songKey(song))])
    const task = recommend(seed, [...exclude], RECOMMEND_BATCH)
      .then(result => {
        if (this.recommendSeed !== seed || !this.autoRecommend) return []
        const songs = (result?.songs || []).filter(song => song?.name && !exclude.has(songKey(song)))
        if (result?.type && !this.recommendType) this.recommendType = result.type
        this.recommendPool = songs
        this.recommendAttempts = songs.length > 0 ? 0 : this.recommendAttempts + 1
        this.updatedAt = Date.now()
        if (songs.length > 0) {
          miotLog.info(`[MIoT] 已准备同类推荐 ${songs.length} 首（${this.recommendType || '未知类型'}）`)
        } else {
          miotLog.warn(`[MIoT] 同类推荐为空 seed="${seed.name}" 第 ${this.recommendAttempts} 次`)
        }
        return songs
      })
      .catch((err: any) => {
        this.recommendAttempts += 1
        miotLog.warn(`[MIoT] 获取同类推荐失败: ${err?.message || err}`)
        return []
      })
      .finally(() => {
        if (this.recommendPending === task) this.recommendPending = null
      })
    this.recommendPending = task
    return task
  }

  private appendRecommendations(pool: MiotSong[]): void {
    const existing = new Set(this.songs.map(song => songKey(song)))
    const fresh = pool.filter(song => song?.name && !existing.has(songKey(song)) && !this.recommendPlayed.has(songKey(song)))
    if (fresh.length === 0) return

    // 保留最近 20 首作为“上一首”历史，避免队列无限增长
    const keepFrom = Math.max(0, this.index - 20)
    this.songs = this.songs.slice(keepFrom).concat(fresh)
    this.index -= keepFrom
    this.listId = TEMP_LIST_ID
    this.listName = this.recommendType ? `AI 同类推荐 · ${this.recommendType}` : 'AI 同类推荐'
    this.recommendPool = []
    this.persist()
  }

  async playPlaylist(listId: string, options: PlayOptions = {}): Promise<boolean> {
    await this.ensureLoaded()
    this.resetRecommendState(false)
    const playlist = await loadPlaylist(this.settings.username, listId)
    if (!playlist) {
      if (options.announce) await this.say('没有找到这个歌单')
      return false
    }
    if (playlist.songs.length === 0) {
      if (options.announce) await this.say('这个歌单是空的')
      return false
    }
    this.listId = playlist.id
    this.listName = playlist.name
    this.songs = playlist.songs
    const start = this.mode === 'shuffle' ? Math.floor(Math.random() * this.songs.length) : 0
    return this.playWithSkip(start, MAX_CONSECUTIVE_SKIP, { announce: options.announce })
  }

  async playSongs(songs: MiotSong[], name: string, options: PlayOptions = {}): Promise<boolean> {
    await this.ensureLoaded()
    if (songs.length === 0) return false
    this.listId = TEMP_LIST_ID
    this.listName = name
    this.songs = songs
    this.resetRecommendState(!!options.autoRecommend, songs[0])
    return this.playWithSkip(0, MAX_CONSECUTIVE_SKIP, { announce: options.announce })
  }

  /** 跳到指定序号播放，遇到无法播放的歌曲继续向后跳过。 */
  async playAt(index: number, options: PlayOptions = {}): Promise<boolean> {
    await this.ensureLoaded()
    return this.playWithSkip(index, MAX_CONSECUTIVE_SKIP, options)
  }

  async playIndex(index: number, options: PlayOptions = {}): Promise<boolean> {
    await this.ensureLoaded()
    if (this.songs.length === 0) return false
    if (options.consumeSleepSong && !this.consumeSleepSong()) return false

    if (index < 0 || index >= this.songs.length) {
      this.status = 'stopped'
      this.positionBase = 0
      this.clearTimers()
      this.persist()
      return false
    }

    const generation = ++this.generation
    this.lastFailureRemoved = false
    this.clearTimers()
    this.index = index
    const song = this.songs[index]
    this.status = 'loading'
    this.error = ''
    this.positionBase = 0
    this.startedAt = 0
    this.duration = parseDuration(song.interval)
    this.updatedAt = Date.now()

    const settings = this.settings
    let url: string | null = null
    try {
      url = await createStreamUrl(this.accountId, this.deviceId, song, settings.username, settings.quality, {
        publicBaseUrl: settings.public_base_url,
        cacheOnPlay: settings.cache_on_play,
        vipAutoDownload: settings.vip_auto_download,
      })
    } catch (err: any) {
      miotLog.warn(`[MIoT] 解析歌曲失败 "${song.name}": ${err?.message || err}`)
    }
    if (generation !== this.generation) return false
    if (!url) {
      const removed = await this.dropUnplayableSong(song)
      if (generation !== this.generation) return false
      this.lastFailureRemoved = removed
      if (removed) {
        // loadPlaylist 返回的是落雪列表的同一数组引用，listMusicRemove 可能已经原地删除
        const pos = this.songs.findIndex(item => item.id === song.id)
        if (pos >= 0) this.songs.splice(pos, 1)
        // 下一首已补到原下标：错误状态下 resume/next 应继续播它，而不是重播上一首
        this.index = this.songs.length === 0 ? -1 : Math.min(index, this.songs.length - 1)
      }
      this.status = 'error'
      this.error = '所有音源及换源均无法播放'
      this.updatedAt = Date.now()
      this.persist()
      miotLog.warn(`[MIoT] 无法播放 "${song.name}" (${song.source}): 本地/缓存/降音质/换源均失败，${removed ? '已从歌单删除' : '停止设备避免循环上一首'}`)
      if (options.haltOnFailure !== false) await this.haltDevice(generation)
      if (options.announce) await this.say('这首歌暂时无法播放，已尝试所有音源')
      return false
    }

    let ok = false
    try {
      ok = await this.controller.playUrl(this.accountId, this.deviceId, url, { title: song.name, artist: song.singer })
    } catch (err: any) {
      miotLog.warn(`[MIoT] 下发播放失败: ${err?.message || err}`)
    }
    if (generation !== this.generation) return false
    if (!ok) {
      this.status = 'error'
      this.error = '音箱没有接受播放指令'
      this.updatedAt = Date.now()
      this.persist()
      miotLog.warn(`[MIoT] 下发播放失败，停止设备避免继续播放上一首 device=${this.deviceId}`)
      if (options.haltOnFailure !== false) await this.haltDevice(generation)
      if (options.announce) await this.say('音箱播放失败，请稍后再试')
      return false
    }

    this.status = 'playing'
    this.startedAt = Date.now()
    this.playStartedAt = this.startedAt
    this.playConfirmed = false
    this.playingSamples = 0
    this.streamFailureHandling = false
    this.updatedAt = Date.now()
    if (this.autoRecommend) this.recommendPlayed.add(songKey(song))
    miotLog.info(`[MIoT] 播放 ${this.listName} 第 ${index + 1}/${this.songs.length} 首: ${song.name} - ${song.singer}`)
    this.scheduleEndTimer()
    this.scheduleStatusPoll()
    this.persist()
    this.maybePrepareRecommendations()

    if (options.announce && this.settings.announce_song) await this.say(`正在播放 ${song.name}`)
    return true
  }

  private scheduleEndTimer(): void {
    if (this.endTimer) clearTimeout(this.endTimer)
    this.endTimer = null
    if (this.duration <= 0) return
    const remainingMs = Math.max(0, (this.duration - this.position()) * 1000) + END_TIMER_GRACE_MS
    this.endTimer = setTimeout(() => {
      this.endTimer = null
      void this.handleSongEnd()
    }, remainingMs)
  }

  private async handleSongEnd(): Promise<void> {
    if (this.status !== 'playing') return
    if (this.sleep?.mode === 'songs') {
      if (!this.consumeSleepSong()) return
    }
    if (!this.settings.auto_next || this.mode === 'singlePlay') {
      await this.stopInternal()
      return
    }
    if (this.mode === 'single') {
      await this.playWithSkip(this.index, MAX_CONSECUTIVE_SKIP)
      return
    }
    let nextIndex = this.nextIndex()
    // 队列播到末尾（含循环/随机模式下的单曲队列）时优先续播同类推荐，而不是回头重播
    const atQueueEnd = this.index >= this.songs.length - 1
    const shouldRecommend = this.autoRecommend && !!this.recommendSeed && (
      nextIndex === null ||
      (atQueueEnd && (this.mode === 'loop' || this.mode === 'order')) ||
      (atQueueEnd && this.songs.length === 1 && nextIndex === this.index)
    )
    if (shouldRecommend) {
      const pool = this.recommendPool.length > 0 ? this.recommendPool : await this.prepareRecommendations()
      if (pool.length > 0) {
        this.appendRecommendations(pool)
        nextIndex = this.nextIndex()
      }
    }
    if (nextIndex === null) {
      await this.stopInternal()
      return
    }
    await this.playWithSkip(nextIndex, MAX_CONSECUTIVE_SKIP)
  }

  private nextIndexFrom(index: number): number | null {
    if (this.songs.length === 0) return null
    if (this.mode === 'shuffle') {
      if (this.songs.length === 1) return 0
      let next = index
      while (next === index) next = Math.floor(Math.random() * this.songs.length)
      return next
    }
    const next = index + 1
    if (next < this.songs.length) return next
    if (this.mode === 'loop') return 0
    return null
  }

  private nextIndex(): number | null {
    return this.nextIndexFrom(this.index)
  }

  /**
   * 连续跳过无法解析/下发的歌曲，避免单曲失败后队列卡死。
   * 删除只发生在取流策略（本地/缓存/降音质/多 API 源/跨平台换源）全部失败之后，
   * 被删除的歌曲不消耗 maxAttempts；仍受 MAX_SCAN_SKIP 限制，防止一次清空歌单。
   */
  private async playWithSkip(startIndex: number, maxAttempts: number, options: PlayOptions = {}): Promise<boolean> {
    await this.ensureLoaded()
    const limit = Math.max(1, Math.min(maxAttempts, this.songs.length))
    let index = startIndex
    let attempts = 0
    let scanned = 0
    while (attempts < limit && scanned < MAX_SCAN_SKIP) {
      scanned++
      const failed = this.songs[index]
      const ok = await this.playIndex(index, attempts === 0
        ? { ...options, haltOnFailure: false }
        : { ...options, announce: false, consumeSleepSong: false, haltOnFailure: false })
      if (ok) return true
      if (this.status !== 'error') return false
      if (!this.lastFailureRemoved) attempts++
      if (this.lastFailureRemoved && this.songs.length === 0) {
        this.index = -1
        this.status = 'stopped'
        this.positionBase = 0
        this.error = ''
        this.clearTimers()
        this.updatedAt = Date.now()
        await this.haltDevice(this.generation)
        miotLog.info(`[MIoT] 歌单 "${this.listName}" 已没有可播放的歌曲`)
        return false
      }
      // 歌曲被移出歌单后，下一首已经补到原下标，不能按原索引 +1 跳过
      const next = this.lastFailureRemoved ? this.indexAfterRemoval(index) : this.nextIndexFrom(index)
      if (next === null) break
      if (!this.lastFailureRemoved) {
        miotLog.info(`[MIoT] 所有音源均无法播放 "${failed?.name ?? ''}" (${failed?.source ?? ''})，尝试下一首`)
      }
      index = next
    }
    if (this.status === 'error') await this.haltDevice(this.generation)
    return false
  }

  private indexAfterRemoval(index: number): number | null {
    if (this.songs.length === 0) return null
    if (this.mode === 'shuffle') return Math.floor(Math.random() * this.songs.length)
    if (index < this.songs.length) return index
    if (this.mode === 'loop') return 0
    return null
  }

  private markPlaybackConfirmed(): void {
    this.playConfirmed = true
    this.streamFailureStreak = 0
  }

  private async confirmStreamFailure(generation: number): Promise<boolean> {
    await new Promise(resolve => setTimeout(resolve, STREAM_FAIL_VERIFY_MS))
    if (generation !== this.generation || this.status !== 'playing' || this.playConfirmed) return false
    let state: MiotDevicePlayState | null = null
    try {
      state = await this.controller.getPlayState(this.accountId, this.deviceId)
    } catch {
      return false
    }
    if (generation !== this.generation || this.status !== 'playing' || this.playConfirmed) return false
    return state?.status === 0
  }

  /**
   * 设备已接受播放指令但从未真正起播（典型为提示“没有版权/无可用音源”后停止）：
   * 从歌单删除该曲并切到下一首；连续失败过多则停止，避免一次断网清空歌单。
   */
  private async handleStreamFailure(): Promise<void> {
    if (this.status !== 'playing' || this.playConfirmed || this.streamFailureHandling) return
    const song = this.currentSong()
    if (!song) return
    this.streamFailureHandling = true
    this.clearTimers()
    const generation = ++this.generation
    const failedIndex = this.index
    this.status = 'loading'
    this.updatedAt = Date.now()

    if (this.streamFailureStreak >= MAX_STREAM_FAIL_STREAK) {
      this.status = 'error'
      this.error = '连续多首歌曲拉流失败'
      this.updatedAt = Date.now()
      this.persist()
      miotLog.warn(`[MIoT] 连续 ${MAX_STREAM_FAIL_STREAK} 首拉流失败，停止自动切歌 device=${this.deviceId}`)
      await this.haltDevice(generation)
      return
    }
    this.streamFailureStreak++
    miotLog.warn(`[MIoT] 音箱拉流失败（未确认起播即停止）"${song.name}" - ${song.singer} source=${song.source || '未知'}，连续第 ${this.streamFailureStreak} 首（上限 ${MAX_STREAM_FAIL_STREAK}）`)

    const removed = await this.dropUnplayableSong(song, '音箱拉流失败（未起播）')
    if (generation !== this.generation) return
    this.lastFailureRemoved = removed
    if (removed) {
      // 与取流失败分支一致：loadPlaylist 返回的是落雪列表的同一数组引用
      const pos = this.songs.findIndex(item => item.id === song.id)
      if (pos >= 0) this.songs.splice(pos, 1)
    }
    if (this.songs.length === 0) {
      this.index = -1
      this.status = 'stopped'
      this.positionBase = 0
      this.error = ''
      this.updatedAt = Date.now()
      miotLog.info(`[MIoT] 歌单 "${this.listName}" 已没有可播放的歌曲`)
      return
    }

    const nextIndex = removed ? this.indexAfterRemoval(failedIndex) : this.nextIndexFrom(failedIndex)
    if (nextIndex === null || nextIndex < 0) {
      this.status = 'error'
      this.error = '没有可播放的下一首'
      this.updatedAt = Date.now()
      this.persist()
      return
    }
    this.index = nextIndex
    this.updatedAt = Date.now()
    this.persist()
    await this.playWithSkip(nextIndex, MAX_CONSECUTIVE_SKIP)
  }

  private scheduleStatusPoll(): void {
    if (this.statusTimer) clearTimeout(this.statusTimer)
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      void this.pollDeviceStatus()
    }, STATUS_POLL_MS)
  }

  private async pollDeviceStatus(): Promise<void> {
    if (this.status !== 'playing') return
    const generation = this.generation
    let state: MiotDevicePlayState | null = null
    try {
      state = await this.controller.getPlayState(this.accountId, this.deviceId)
    } catch { /* ignore */ }
    if (generation !== this.generation || this.status !== 'playing') return
    if (!state) {
      this.scheduleStatusPoll()
      return
    }
    if (state.status === 1) {
      // 有位置时以真实进度确认；部分型号位置恒为 0，连续两次 playing 也算起播
      this.playingSamples++
      if ((state.hasPosition && state.position >= STREAM_CONFIRM_POSITION_SEC) || this.playingSamples >= STREAM_CONFIRM_SAMPLES) {
        this.markPlaybackConfirmed()
      }
      if (state.hasPosition && Math.abs(state.position - this.position()) > 10) {
        this.positionBase = state.position
        this.startedAt = Date.now()
        // TTS/播报打断会让实际进度落后于墙钟，位置校正后需要重排结束定时
        this.scheduleEndTimer()
      }
      this.scheduleStatusPoll()
      return
    }
    if (state.status === 2) {
      this.positionBase = state.hasPosition ? state.position : this.position()
      this.startedAt = 0
      this.status = 'paused'
      this.updatedAt = Date.now()
      this.clearTimers()
      this.persist()
      return
    }
    if (state.status === 0) {
      const verdict = classifyDeviceStop({
        position: this.position(),
        duration: this.duration,
        hasPosition: state.hasPosition,
        devicePosition: state.position,
        playConfirmed: this.playConfirmed,
        playStartedAt: this.playStartedAt,
        lastTtsAt: this.lastTtsAt,
        now: Date.now(),
      })
      if (verdict === 'ended') {
        if (this.endTimer) return
        await this.handleSongEnd()
        return
      }
      if (verdict === 'tts-interrupted') {
        // 我方播报会打断流播放：先尝试恢复/重推当前曲，避免把自家播报误判成拉流失败
        this.scheduleStatusPoll()
        void this.ensureDevicePlaying()
        return
      }
      if (verdict === 'stream-failed') {
        if (await this.confirmStreamFailure(generation)) {
          await this.handleStreamFailure()
        } else if (generation === this.generation && this.status === 'playing') {
          this.scheduleStatusPoll()
        }
        return
      }
      // 已确认起播的中途停止沿用原逻辑：有结束定时器就等它，避免和用户手动停止冲突
      if (this.endTimer) return
      await this.handleSongEnd()
    }
  }

  async pause(): Promise<'paused' | 'stopped' | 'failed'> {
    await this.ensureLoaded()
    if (this.status !== 'playing') return this.status === 'stopped' ? 'stopped' : 'failed'
    const position = this.position()
    this.clearTimers()
    const result = await this.controller.pause(this.accountId, this.deviceId)
    this.positionBase = position
    this.startedAt = 0
    if (result === 'stopped') {
      this.status = 'stopped'
      this.positionBase = 0
    } else if (result === 'paused') {
      this.status = 'paused'
    } else {
      this.status = 'error'
      this.error = '暂停失败'
    }
    this.updatedAt = Date.now()
    this.persist()
    return result
  }

  async resume(): Promise<boolean> {
    await this.ensureLoaded()
    if (this.status === 'playing') return true
    if (this.status === 'paused') {
      if (await this.controller.resume(this.accountId, this.deviceId)) {
        this.status = 'playing'
        this.startedAt = Date.now()
        this.updatedAt = Date.now()
        this.scheduleEndTimer()
        this.scheduleStatusPoll()
        this.persist()
        return true
      }
    }
    if (this.status === 'stopped' || this.status === 'error' || this.status === 'idle') {
      if (this.songs.length === 0) return false
      return this.playWithSkip(Math.max(0, this.index), MAX_CONSECUTIVE_SKIP)
    }
    return false
  }

  async stopInternal(): Promise<void> {
    this.clearTimers()
    this.generation++
    try {
      await this.controller.stop(this.accountId, this.deviceId)
    } catch { /* ignore */ }
    this.status = 'stopped'
    this.positionBase = 0
    this.startedAt = 0
    this.updatedAt = Date.now()
    this.persist()
  }

  async stop(): Promise<boolean> {
    await this.ensureLoaded()
    this.cancelSleepTimer()
    await this.stopInternal()
    return true
  }

  async next(): Promise<boolean> {
    await this.ensureLoaded()
    // 上一首因删除歌曲而失败时，index 已指向补位歌曲，直接播它
    const nextIndex = this.status === 'error' && this.lastFailureRemoved && this.index < this.songs.length
      ? this.index
      : this.nextIndex()
    if (nextIndex === null || nextIndex < 0) return false
    return this.playWithSkip(nextIndex, MAX_CONSECUTIVE_SKIP, { consumeSleepSong: true })
  }

  async previous(): Promise<boolean> {
    await this.ensureLoaded()
    if (this.songs.length === 0) return false
    if (this.position() > 5) return this.playAt(this.index)
    const prev = this.index > 0 ? this.index - 1 : (this.mode === 'loop' ? this.songs.length - 1 : -1)
    if (prev < 0) return false
    return this.playIndex(prev, { consumeSleepSong: true })
  }

  async replayCurrent(announce = false): Promise<boolean> {
    await this.ensureLoaded()
    if (this.index < 0 || this.songs.length === 0) return false
    return this.playAt(this.index, { announce })
  }

  async setMode(mode: MiotPlayMode): Promise<MiotPlayMode> {
    await this.ensureLoaded()
    this.mode = normalizePlayMode(mode)
    const device = this.store.getDevice(this.accountId, this.deviceId)
    if (device) this.store.updateDevice(this.accountId, this.deviceId, { play_mode: this.mode })
    this.persist()
    return this.mode
  }

  async setVolume(volume: number): Promise<boolean> {
    await this.ensureLoaded()
    const ok = await this.controller.setVolume(this.accountId, this.deviceId, volume)
    if (ok) {
      this.volume = Math.max(0, Math.min(100, Math.floor(volume)))
      this.store.updateDevice(this.accountId, this.deviceId, { volume: this.volume })
    }
    return ok
  }

  async syncVolume(): Promise<number> {
    const volume = await this.controller.readVolume(this.accountId, this.deviceId)
    if (volume >= 0) {
      this.volume = volume
      this.store.updateDevice(this.accountId, this.deviceId, { volume })
    }
    return volume
  }

  async favoriteCurrent(action: 'add' | 'remove'): Promise<boolean> {
    await this.ensureLoaded()
    const song = this.currentSong()
    if (!song) return false
    const username = this.settings.username
    try {
      if (action === 'add') {
        if (await isSongLoved(username, song)) return true
        return await addSongToLoved(username, song)
      }
      return await removeSongFromLoved(username, song)
    } catch (err: any) {
      miotLog.warn(`[MIoT] 收藏操作失败: ${err?.message || err}`)
      return false
    }
  }

  async addCurrentToList(listId: string): Promise<'added' | 'exists' | 'not-found' | 'no-song' | 'failed'> {
    await this.ensureLoaded()
    const song = this.currentSong()
    if (!song) return 'no-song'
    try {
      const result = await addSongToList(this.settings.username, listId, song)
      if (result === 'added') miotLog.info(`[MIoT] 已收藏 "${song.name}" 到歌单 ${listId}`)
      return result
    } catch (err: any) {
      miotLog.warn(`[MIoT] 收藏到歌单失败: ${err?.message || err}`)
      return 'failed'
    }
  }

  getSleepState(): { active: boolean; mode: 'time' | 'songs'; remaining: number; total: number } {
    if (!this.sleep) return { active: false, mode: 'time', remaining: 0, total: 0 }
    if (this.sleep.mode === 'songs') {
      return { active: true, mode: 'songs', remaining: Math.max(0, this.sleep.remainingSongs), total: this.sleep.total }
    }
    return { active: true, mode: 'time', remaining: Math.max(0, this.sleep.expiresAt - Date.now()), total: this.sleep.total }
  }

  setSleepTimer(mode: 'time' | 'songs', value: number): ReturnType<MiotPlayer['getSleepState']> {
    this.cancelSleepTimer()
    if (mode === 'time') {
      const total = Math.max(1, Math.round(value)) * 60 * 1000
      const state: SleepTimerState = {
        mode: 'time',
        total,
        expiresAt: Date.now() + total,
        remainingSongs: 0,
        timer: setTimeout(() => { void this.expireSleep() }, total),
      }
      this.sleep = state
    } else {
      const count = Math.max(1, Math.round(value))
      this.sleep = { mode: 'songs', total: count, expiresAt: 0, remainingSongs: count, timer: null }
    }
    return this.getSleepState()
  }

  cancelSleepTimer(): boolean {
    if (!this.sleep) return false
    if (this.sleep.timer) clearTimeout(this.sleep.timer)
    this.sleep = null
    return true
  }

  private consumeSleepSong(): boolean {
    if (!this.sleep || this.sleep.mode !== 'songs') return true
    this.sleep.remainingSongs--
    if (this.sleep.remainingSongs > 0) return true
    this.sleep = null
    void this.expireSleep()
    return false
  }

  private async expireSleep(): Promise<void> {
    this.sleep = null
    miotLog.info(`[MIoT] 睡眠定时到期，停止播放 device=${this.deviceId}`)
    await this.stopInternal()
    await this.say('定时结束，已停止播放')
  }

  async getView(): Promise<MiotPlaybackView> {
    await this.ensureLoaded()
    const sleep = this.getSleepState()
    return {
      accountId: this.accountId,
      deviceId: this.deviceId,
      status: this.status,
      listId: this.listId,
      listName: this.listName,
      index: this.index,
      song: this.currentSong(),
      songs: this.songs,
      mode: this.mode,
      position: Math.round(this.position()),
      duration: Math.round(this.duration),
      volume: this.volume,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      error: this.error || undefined,
      sleepAt: sleep.active && sleep.mode === 'time' ? Date.now() + sleep.remaining : 0,
      sleepRemaining: sleep.active ? sleep.remaining : 0,
      sleepMode: sleep.mode,
      autoRecommend: this.autoRecommend || undefined,
      recommendType: this.recommendType || undefined,
    }
  }

  getStatus(): MiotPlayerStatus {
    return this.status
  }

  getCurrentSong(): MiotSong | null {
    return this.currentSong()
  }

  async ensureCurrentSong(): Promise<MiotSong | null> {
    await this.ensureLoaded()
    return this.currentSong()
  }

  isPlaying(): boolean {
    return this.status === 'playing'
  }

  getDurationLabel(): string {
    return formatDuration(this.duration)
  }

  async announce(text: string): Promise<void> {
    await this.say(text)
  }

  /**
   * 语音唤醒会打断流播放。若设备实际已暂停/停止，恢复当前歌曲；
   * 未被打断则什么都不做。replayIfStopped=false 用于 AI 分类后恢复：
   * 歌曲可能已自然结束，不能把上一首重新推流。
   */
  async ensureDevicePlaying(replayIfStopped = true): Promise<void> {
    if (this.status !== 'playing') return
    await new Promise(resolve => setTimeout(resolve, 1200))
    if (this.status !== 'playing') return
    let state: MiotDevicePlayState | null = null
    try {
      state = await this.controller.getPlayState(this.accountId, this.deviceId)
    } catch { /* ignore */ }
    if (!state || state.status === 1 || this.status !== 'playing') return
    if (state.status === 2 && await this.controller.resume(this.accountId, this.deviceId)) {
      this.startedAt = Date.now()
      this.scheduleEndTimer()
      this.scheduleStatusPoll()
      return
    }
    if (state.status === 0 && replayIfStopped) await this.playWithSkip(this.index, MAX_CONSECUTIVE_SKIP)
  }

  shutdown(): void {
    this.clearTimers()
    if (this.sleep?.timer) clearTimeout(this.sleep.timer)
    this.sleep = null
    this.generation++
  }
}
