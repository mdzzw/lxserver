import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildIntentPrompt, parseIntentAnswer, shouldAnalyzeIntent } from '../src/server/integrations/miot/aiIntent'
import type { MiotVoiceCommand } from '../src/server/integrations/miot/types'
import { getDefaultVoiceCommands, migrateVoiceCommands, VOICE_COMMAND_DEFAULTS_REV } from '../src/server/integrations/miot/voiceDefaults'

const tempRoot = path.join(os.tmpdir(), `lxserver-miot-test-${process.pid}`)
fs.mkdirSync(tempRoot, { recursive: true })
;(global as any).lx = {
  ...(global as any).lx,
  dataPath: tempRoot,
  userPath: tempRoot,
  config: {
    users: [{ name: 'tester' }],
    maxSnapshotNum: 5,
    'list.addMusicLocationType': 'top',
    'snapshot.backupPath': '',
  },
}

const commands = getDefaultVoiceCommands()
const dislikeTypes = ['dislike_song', 'dislike_artist', 'dislike_album']

test('default commands cover add and remove for three dislike dimensions', () => {
  for (const type of dislikeTypes) {
    const entries = commands.filter(command => command.type === type)
    assert.deepEqual(entries.map(command => command.param).sort(), ['add', 'remove'], type)
    assert.ok(entries.every(command => command.enabled), type)
    assert.ok(entries.every(command => command.keywords.length > 0), type)
  }
})

test('local matching prefers dislike over favorite and reads action param', async () => {
  const { matchVoiceCommand } = await import('../src/server/integrations/miot/voice')
  assert.deepEqual(matchVoiceCommand('不喜欢这首歌', commands)?.command.type, 'dislike_song')
  assert.deepEqual(matchVoiceCommand('不喜欢这首歌', commands)?.command.param, 'add')
  assert.deepEqual(matchVoiceCommand('取消不喜欢这首歌', commands)?.command.param, 'remove')
  assert.deepEqual(matchVoiceCommand('不喜欢这个歌手', commands)?.command.type, 'dislike_artist')
  assert.deepEqual(matchVoiceCommand('取消不喜欢这位歌手', commands)?.command.param, 'remove')
  assert.deepEqual(matchVoiceCommand('不喜欢这张专辑', commands)?.command.type, 'dislike_album')
  assert.deepEqual(matchVoiceCommand('取消不喜欢当前专辑', commands)?.command.param, 'remove')
  assert.deepEqual(matchVoiceCommand('喜欢这首歌', commands)?.command.type, 'favorite')
})

test('one-time migration appends only missing new types', () => {
  const custom: MiotVoiceCommand[] = [
    { type: 'play_song', keywords: ['点歌'], enabled: true },
    { type: 'dislike_song', keywords: ['我的不喜欢'], param: 'add', enabled: false },
  ]
  const migrated = migrateVoiceCommands(custom, 1)
  assert.equal(migrated.changed, true)
  assert.equal(migrated.rev, VOICE_COMMAND_DEFAULTS_REV)
  assert.deepEqual(migrated.commands[0], custom[0])
  const dislikeSong = migrated.commands.filter(command => command.type === 'dislike_song')
  assert.equal(dislikeSong.length, 1)
  assert.deepEqual(dislikeSong[0], custom[1])
  assert.ok(migrated.commands.some(command => command.type === 'dislike_artist'))
  assert.ok(migrated.commands.some(command => command.type === 'dislike_album'))

  const again = migrateVoiceCommands(migrated.commands, migrated.rev)
  assert.equal(again.changed, false)
  assert.deepEqual(again.commands, migrated.commands)

  const afterDelete = migrated.commands.filter(command => command.type !== 'dislike_album')
  const stable = migrateVoiceCommands(afterDelete, migrated.rev)
  assert.equal(stable.changed, false)
  assert.equal(stable.commands.some(command => command.type === 'dislike_album'), false)
})

test('AI prompt and parser understand configured dislike commands', () => {
  for (const query of ['不喜欢这首歌', '不喜欢这个歌手', '不喜欢这张专辑']) {
    assert.equal(shouldAnalyzeIntent(query, commands), true, query)
  }
  assert.deepEqual(parseIntentAnswer('不喜欢这首歌', commands).intent, { type: 'dislike_song', argument: undefined, param: 'add' })
  assert.deepEqual(parseIntentAnswer('取消不喜欢这首歌', commands).intent, { type: 'dislike_song', argument: undefined, param: 'remove' })
  assert.deepEqual(parseIntentAnswer('不喜欢这个歌手', commands).intent, { type: 'dislike_artist', argument: undefined, param: 'add' })
  assert.deepEqual(parseIntentAnswer('取消不喜欢这张专辑', commands).intent, { type: 'dislike_album', argument: undefined, param: 'remove' })

  const prompt = buildIntentPrompt('不喜欢这张专辑', '', commands)
  assert.ok(prompt.includes('不喜欢当前歌曲'))
  assert.ok(prompt.includes('不喜欢当前歌手'))
  assert.ok(prompt.includes('不喜欢当前专辑'))
  assert.ok(prompt.includes('取消不喜欢当前歌曲'))
})

test('song dislike records name with singer and skips after marking', async () => {
  const { handleVoiceQuery } = await import('../src/server/integrations/miot/voice')
  const { getUserSpace } = await import('../src/user')
  const calls: string[] = []
  const player = {
    async ensureCurrentSong() {
      return { name: '晴天', singer: '周杰伦', source: 'test' }
    },
    async announce(text: string) {
      calls.push(`say:${text}`)
    },
    async next() {
      calls.push('next')
      return true
    },
  } as any
  const context = { player, settings: { username: 'tester' } as any, deviceName: '测试音箱' }

  const added = await handleVoiceQuery('不喜欢这首歌', commands, context)
  assert.equal(added.executed, true)
  assert.deepEqual(calls, ['next', 'say:已不喜欢晴天，已切到下一首'])
  assert.ok(added.note.includes('晴天 - 周杰伦'))

  const entries = getUserSpace('tester').dislikeManage.dislikeDataManage.dislikeRules.dislikeList
  const entry = entries.find(item => item.name === '晴天')
  assert.ok(entry)
  assert.equal(entry.singer, '周杰伦')
  assert.equal(entry.dislikeRule, '晴天@周杰伦')

  calls.length = 0
  const removed = await handleVoiceQuery('取消不喜欢这首歌', commands, context)
  assert.equal(removed.executed, true)
  assert.deepEqual(calls, ['say:已取消不喜欢晴天'])
  const after = getUserSpace('tester').dislikeManage.dislikeDataManage.dislikeRules.dislikeList
  assert.equal(after.some(item => item.name === '晴天'), false)
})
