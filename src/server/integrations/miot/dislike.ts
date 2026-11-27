import fs from 'node:fs'
import path from 'node:path'
import { getUserDirname, getUserSpace } from '@/user'
import { normalizeText, splitSingers } from '@/modules/dislike/match'
import { invalidateDislikeCache } from '@/server/utils/dislikeCache'
import { openLibraryUser } from '@/server/music/playbackFallback'
import { miotLog } from './log'
import type { MiotSong } from './types'

export interface MiotDislikeResult {
  ok: boolean
  changed: boolean
  names: string[]
}

export const getSongAlbumName = (song: MiotSong | null): string =>
  String(song?.albumName ?? song?.meta?.albumName ?? song?.album ?? song?.meta?.album ?? '').trim()

const getSongPic = (song: MiotSong | null): string => String(song?.meta?.picUrl || song?.img || '')

const nameKey = (name: unknown): string => normalizeText(String(name || ''))

const sameSource = (a: unknown, b: unknown): boolean => {
  const left = String(a || '')
  const right = String(b || '')
  return !left || !right || left === right
}

const getPaths = (username: string) => {
  const user = openLibraryUser(username)
  const root = path.join(global.lx.userPath, getUserDirname(user))
  return {
    user,
    dislikeDir: path.join(root, 'dislike', 'library'),
    likeDir: path.join(root, 'library'),
  }
}

const readArray = (file: string): any[] => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const writeArray = (file: string, list: any[]): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8')
}

const removeLikedEntries = (file: string, match: (item: any) => boolean): void => {
  const liked = readArray(file)
  if (liked.length === 0) return
  const next = liked.filter(item => !match(item))
  if (next.length !== liked.length) writeArray(file, next)
}

export const setSongDisliked = async (
  username: string,
  song: MiotSong,
  add: boolean,
): Promise<MiotDislikeResult> => {
  const name = String(song?.name || '').trim()
  const singer = String(song?.singer || '').trim()
  if (!name) return { ok: false, changed: false, names: [] }

  try {
    const manage = getUserSpace(getPaths(username).user).dislikeManage
    const before = manage.dislikeDataManage.dislikeRules.dislikeList.length
    if (add) {
      const at = Date.now()
      await manage.dislikeDataManage.addDislikeInfo([{
        ...song,
        name,
        singer,
        source: String(song.source || ''),
        dislikeRule: '',
        provenance: { channel: 'voice', at },
        reasons: [{ channel: 'voice', at }],
      } as any])
    } else {
      const rule = singer ? `${name}@${singer}` : name
      await manage.dislikeDataManage.removeDislikeInfo(rule, song.source || undefined)
    }
    const after = manage.dislikeDataManage.dislikeRules.dislikeList.length
    const changed = after !== before
    if (add || changed) await manage.createSnapshot()
    if (changed) invalidateDislikeCache(getPaths(username).user)
    miotLog.info(`[MIoT] ${add ? '加入' : '移除'}不喜欢歌曲 "${name}" - "${singer}"${changed ? '' : '（无变化）'}`)
    return { ok: true, changed, names: [name] }
  } catch (err: any) {
    miotLog.warn(`[MIoT] 同步不喜欢歌曲失败 "${name}": ${err?.message || err}`)
    return { ok: false, changed: false, names: [] }
  }
}

export const setArtistsDisliked = async (
  username: string,
  song: MiotSong,
  add: boolean,
): Promise<MiotDislikeResult> => {
  const singers = splitSingers(song?.singer)
  if (singers.length === 0) return { ok: false, changed: false, names: [] }

  const source = String(song.source || '')
  const picUrl = getSongPic(song)
  try {
    const paths = getPaths(username)
    const file = path.join(paths.dislikeDir, 'artists.json')
    const list = readArray(file)
    const before = list.length
    let next = list

    if (add) {
      const additions = singers
        .filter(name => !list.some(item => nameKey(item.name) === nameKey(name) && sameSource(item.source, source)))
        .map(name => ({ id: name, source, name, picUrl, dislikeRule: `@${name}` }))
      if (additions.length > 0) {
        next = [...list, ...additions]
        writeArray(file, next)
        removeLikedEntries(path.join(paths.likeDir, 'artists.json'), item =>
          additions.some(entry => nameKey(entry.name) === nameKey(item.name) && sameSource(entry.source, item.source)))
      }
    } else {
      const targets = new Set(singers.map(nameKey))
      next = list.filter(item => !(targets.has(nameKey(item.name)) && sameSource(item.source, source)))
      if (next.length !== list.length) writeArray(file, next)
    }

    const changed = next.length !== before
    if (changed) invalidateDislikeCache(paths.user)
    miotLog.info(`[MIoT] ${add ? '加入' : '移除'}不喜欢歌手 ${singers.join('、')}${changed ? '' : '（无变化）'}`)
    return { ok: true, changed, names: singers }
  } catch (err: any) {
    miotLog.warn(`[MIoT] 同步不喜欢歌手失败 "${String(song.singer || '')}": ${err?.message || err}`)
    return { ok: false, changed: false, names: [] }
  }
}

export const setAlbumDisliked = async (
  username: string,
  song: MiotSong,
  add: boolean,
): Promise<MiotDislikeResult> => {
  const albumName = getSongAlbumName(song)
  if (!albumName) return { ok: false, changed: false, names: [] }

  const source = String(song.source || '')
  const singer = String(song.singer || '').trim()
  try {
    const paths = getPaths(username)
    const file = path.join(paths.dislikeDir, 'albums.json')
    const list = readArray(file)
    const before = list.length
    let next = list

    if (add) {
      const exists = list.some(item => nameKey(item.name) === nameKey(albumName) && sameSource(item.source, source))
      if (!exists) {
        const entry = {
          id: String(song.meta?.albumId || song.meta?.album?.id || albumName),
          source,
          name: albumName,
          picUrl: getSongPic(song),
          artistName: singer,
          dislikeRule: `!${albumName}@${singer}`,
        }
        next = [...list, entry]
        writeArray(file, next)
        removeLikedEntries(path.join(paths.likeDir, 'albums.json'), item =>
          nameKey(item.name) === nameKey(albumName) && sameSource(item.source, source))
      }
    } else {
      next = list.filter(item => !(nameKey(item.name) === nameKey(albumName) && sameSource(item.source, source)))
      if (next.length !== list.length) writeArray(file, next)
    }

    const changed = next.length !== before
    if (changed) invalidateDislikeCache(paths.user)
    miotLog.info(`[MIoT] ${add ? '加入' : '移除'}不喜欢专辑 "${albumName}"${changed ? '' : '（无变化）'}`)
    return { ok: true, changed, names: [albumName] }
  } catch (err: any) {
    miotLog.warn(`[MIoT] 同步不喜欢专辑失败 "${albumName}": ${err?.message || err}`)
    return { ok: false, changed: false, names: [] }
  }
}
