import { LIST_IDS } from '@/constants'
import { getUserSpace } from '@/user'
import { openLibraryUser } from './resolver'
import type { MiotPlaylistInfo, MiotSong } from './types'

export interface LoadedPlaylist {
  id: string
  name: string
  songs: MiotSong[]
}

const getListManage = (username: string) => getUserSpace(openLibraryUser(username)).listManage

export const listPlaylists = async (username: string): Promise<MiotPlaylistInfo[]> => {
  const data = await getListManage(username).getListData()
  const result: MiotPlaylistInfo[] = [
    { id: LIST_IDS.DEFAULT, name: '试听列表', count: data.defaultList.length, builtin: true },
    { id: LIST_IDS.LOVE, name: '我的收藏', count: data.loveList.length, builtin: true },
  ]
  for (const list of data.userList) {
    result.push({ id: list.id, name: list.name, count: list.list.length, source: list.source, builtin: false })
  }
  return result
}

export const createPlaylist = async (username: string, name: string): Promise<MiotPlaylistInfo> => {
  const manage = getListManage(username)
  const data = await manage.getListData()
  let id = `miot_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  while (data.userList.some(item => item.id === id)) id += Math.random().toString(36).slice(2, 4)
  const listName = name.trim() || '小爱收藏'
  await manage.listDataManage.userListCreate({
    name: listName,
    id,
    position: data.userList.length,
    locationUpdateTime: null,
  })
  await manage.createSnapshot()
  return { id, name: listName, count: 0, builtin: false }
}

export const loadPlaylist = async (username: string, listId: string): Promise<LoadedPlaylist | null> => {
  const data = await getListManage(username).getListData()
  if (listId === LIST_IDS.DEFAULT) return { id: LIST_IDS.DEFAULT, name: '试听列表', songs: data.defaultList as MiotSong[] }
  if (listId === LIST_IDS.LOVE) return { id: LIST_IDS.LOVE, name: '我的收藏', songs: data.loveList as MiotSong[] }
  const list = data.userList.find(item => item.id === listId)
  return list ? { id: list.id, name: list.name, songs: list.list as MiotSong[] } : null
}

export const findPlaylist = async (username: string, query: string): Promise<MiotPlaylistInfo | null> => {
  const playlists = await listPlaylists(username)
  const keyword = query.trim().toLowerCase()
  if (!keyword) return playlists.find(item => item.id === LIST_IDS.DEFAULT) ?? null
  const exact = playlists.find(item => item.name.toLowerCase() === keyword || item.id === keyword)
  if (exact) return exact
  const fuzzy = playlists.find(item => item.name.toLowerCase().includes(keyword) || keyword.includes(item.name.toLowerCase()))
  return fuzzy ?? null
}

export type AddSongToListResult = 'added' | 'exists' | 'not-found'

export const addSongToList = async (username: string, listId: string, song: MiotSong): Promise<AddSongToListResult> => {
  const manage = getListManage(username)
  const data = await manage.getListData()
  let songs: MiotSong[] | null = null
  if (listId === LIST_IDS.DEFAULT) songs = data.defaultList as MiotSong[]
  else if (listId === LIST_IDS.LOVE) songs = data.loveList as MiotSong[]
  else songs = (data.userList.find(item => item.id === listId)?.list as MiotSong[] | undefined) ?? null
  if (!songs) return 'not-found'
  if (songs.some(item => item.id === song.id)) return 'exists'
  await manage.listDataManage.listMusicAdd(listId, [song as any], 'bottom')
  await manage.createSnapshot()
  return 'added'
}

export const removeSongFromList = async (username: string, listId: string, song: MiotSong): Promise<boolean> => {
  const manage = getListManage(username)
  await manage.listDataManage.listMusicRemove(listId, [song.id])
  await manage.createSnapshot()
  return true
}

export const addSongToLoved = async (username: string, song: MiotSong): Promise<boolean> => {
  const manage = getListManage(username)
  await manage.listDataManage.listMusicAdd(LIST_IDS.LOVE, [song as any], 'bottom')
  await manage.createSnapshot()
  return true
}

export const removeSongFromLoved = async (username: string, song: MiotSong): Promise<boolean> => {
  const manage = getListManage(username)
  await manage.listDataManage.listMusicRemove(LIST_IDS.LOVE, [song.id])
  await manage.createSnapshot()
  return true
}

export const isSongLoved = async (username: string, song: MiotSong): Promise<boolean> => {
  const playlist = await loadPlaylist(username, LIST_IDS.LOVE)
  return !!playlist?.songs.some(item => item.id === song.id)
}
