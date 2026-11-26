import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-file-cache-collision-'))
let checkCache: any
let indexManager: any
let setUserCacheLocation: any

before(async () => {
  const userPath = path.join(dataRoot, 'users')
  fs.mkdirSync(userPath, { recursive: true })
  ;(globalThis as any).lx = { dataPath: dataRoot, userPath, config: { serverCacheLocation: 'data', users: [] } }
  const mod = await import('../src/server/music/fileCache')
  checkCache = mod.checkCache
  indexManager = mod.indexManager
  setUserCacheLocation = mod.setUserCacheLocation
})

after(async () => {
  // src/user/data.ts 会在导入后延迟写 serverInfo.json，等它落盘再清理临时目录。
  await new Promise(resolve => setTimeout(resolve, 1200))
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

const makeUserDir = (username: string, folder: 'music' | 'cache') => {
  const dir = path.join(dataRoot, folder, username)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const addIndexItem = (username: string, folder: 'music' | 'cache', item: Record<string, any>) => {
  indexManager.update(username, item as any, folder)
}

test('same name + singer + quality from another source counts as existing', t => {
  const username = 'lx_collision_user'
  setUserCacheLocation(username, 'data')
  const dir = makeUserDir(username, 'music')
  const audio = path.join(dir, 'real.flac')
  fs.writeFileSync(audio, Buffer.alloc(2048))
  t.after(() => { try { fs.unlinkSync(audio) } catch { } })

  addIndexItem(username, 'music', {
    id: 'wy_111', songmid: 'wy_111', name: 'TestSong', singer: 'TestSinger', album: 'A',
    quality: 'flac', filename: 'real.flac', folder: 'music', mtime: Date.now(), size: 2048,
  })

  const hit = checkCache({ name: 'TestSong', singer: ' testSinger ', source: 'kw', songmid: '222', quality: 'flac' }, username) as any
  assert.equal(hit.exists, true)
  assert.equal(hit.isCollision, true)
  assert.equal(hit.folder, 'music')
  assert.equal(hit.quality, 'flac')
  assert.ok(String(hit.path).endsWith('real.flac'))
  assert.match(String(hit.url), /folder=music/)

  const upgrade = checkCache({ name: 'TestSong', singer: 'TestSinger', source: 'kw', songmid: '222', quality: '320k' }, username) as any
  assert.equal(upgrade.exists, false, 'different quality should fall through to upgrade download')

  const otherSinger = checkCache({ name: 'TestSong', singer: 'OtherSinger', source: 'kw', songmid: '333', quality: 'flac' }, username) as any
  assert.equal(otherSinger.exists, false, 'different singer is not the same song')

  fs.unlinkSync(audio)
  const stale = checkCache({ name: 'TestSong', singer: 'TestSinger', source: 'kw', songmid: '222', quality: 'flac' }, username) as any
  assert.equal(stale.exists, false, 'stale index entries must not block downloads')
})

test('same source different quality still requires an upgrade download', t => {
  const username = 'lx_upgrade_user'
  setUserCacheLocation(username, 'data')
  const dir = makeUserDir(username, 'music')
  const audio = path.join(dir, 'real320.mp3')
  fs.writeFileSync(audio, Buffer.alloc(1024))
  t.after(() => { try { fs.unlinkSync(audio) } catch { } })

  addIndexItem(username, 'music', {
    id: 'kw_900', songmid: 'kw_900', name: 'UpgradeSong', singer: 'S', album: 'B',
    quality: '320k', filename: 'real320.mp3', folder: 'music', mtime: Date.now(), size: 1024,
  })

  const exactFlac = checkCache({ name: 'UpgradeSong', singer: 'S', source: 'kw', songmid: '900', quality: 'flac', exactQuality: true }, username) as any
  assert.equal(exactFlac.exists, false)

  const ownQuality = checkCache({ name: 'UpgradeSong', singer: 'S', source: 'kw', songmid: '900', quality: '320k', exactQuality: true }, username) as any
  assert.equal(ownQuality.exists, true)
  assert.equal(ownQuality.isCollision, undefined)
})
