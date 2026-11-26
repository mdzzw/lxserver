import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeAiFailureThreshold, normalizeAiFailureWindow } from '../src/server/integrations/miot/aiConstants'
import { buildIntentPrompt, parseIntentAnswer, sanitizeIntentQuery, shouldAnalyzeIntent } from '../src/server/integrations/miot/aiIntent'
import type { MiotVoiceCommand } from '../src/server/integrations/miot/types'
import { getDefaultVoiceCommands } from '../src/server/integrations/miot/voiceDefaults'

const commands = getDefaultVoiceCommands()

test('local music gate skips non-song requests', () => {
  for (const query of ['今天天气怎么样', '播放新闻', '讲个笑话', '关闭空调', '把灯关掉', '我想听新闻', '放盐']) {
    assert.equal(shouldAnalyzeIntent(query, commands), false, query)
  }
})

test('local music gate keeps song and player requests', () => {
  for (const query of ['放首周杰伦', '放周杰伦', '随便放点歌曲', '来点适合睡觉的', '下一首', '播放歌曲', '播放时间都去哪儿了']) {
    assert.equal(shouldAnalyzeIntent(query, commands), true, query)
  }
})

test('gate and prompt follow configured command keywords', () => {
  const custom: MiotVoiceCommand[] = [{ type: 'play_song', keywords: ['点歌'], enabled: true }]
  assert.equal(shouldAnalyzeIntent('点歌晴天', custom), true)
  const prompt = buildIntentPrompt('点歌晴天', '', custom)
  assert.ok(prompt.includes('点歌'))
  assert.ok(prompt.includes('随机听歌'))
  assert.deepEqual(parseIntentAnswer('点歌：晴天', custom).intent, { type: 'play_song', argument: '晴天', param: undefined })
})

test('parser uses configured command table', () => {
  assert.deepEqual(parseIntentAnswer('播放歌曲：夜曲', commands).intent, { type: 'play_song', argument: '夜曲', param: undefined })
  assert.deepEqual(parseIntentAnswer('播放歌手：周杰伦的歌', commands).intent, { type: 'play_artist', argument: '周杰伦', param: undefined })
  assert.deepEqual(parseIntentAnswer('播放热歌榜', commands).intent, { type: 'play_chart', argument: '热歌榜', param: undefined })
  assert.deepEqual(parseIntentAnswer('播放榜单：飙升榜', commands).intent, { type: 'play_chart', argument: '飙升榜', param: undefined })
  assert.deepEqual(parseIntentAnswer('播放榜单', commands).intent, { type: 'play_chart', argument: '热歌榜', param: undefined })
  assert.deepEqual(parseIntentAnswer('下一首', commands).intent, { type: 'next', argument: undefined, param: undefined })
  assert.deepEqual(parseIntentAnswer('取消收藏', commands).intent, { type: 'favorite', argument: undefined, param: 'remove' })
  assert.deepEqual(parseIntentAnswer('收藏到歌单：我的收藏', commands).intent, { type: 'favorite_to', argument: '我的收藏', param: undefined })
})

test('parser keeps random and hot extensions', () => {
  assert.deepEqual(parseIntentAnswer('随机听歌：摇滚', commands).intent, { type: 'play_random', argument: '摇滚', param: undefined })
  assert.deepEqual(parseIntentAnswer('播放热门', commands).intent, { type: 'play_hot', argument: undefined, param: undefined })
  assert.deepEqual(parseIntentAnswer('播放热门歌曲', commands).intent, { type: 'play_hot', argument: undefined, param: undefined })
})

test('parser treats unrelated and unknown answers as no execution', () => {
  assert.deepEqual(parseIntentAnswer('无关', commands), { intent: null, noIntent: true })
  assert.deepEqual(parseIntentAnswer('播放歌曲', commands), { intent: null, noIntent: true })
  assert.deepEqual(parseIntentAnswer('你好呀', commands), { intent: null, noIntent: false })
})

test('custom prompt without placeholders gets catalog and query appended', () => {
  const prompt = buildIntentPrompt('放周杰伦', '只输出一行口令。用户原话：{query}。口令：', commands)
  assert.ok(prompt.includes('口令表'))
  assert.ok(prompt.indexOf('口令表') < prompt.indexOf('用户原话'))
  const noPlaceholder = buildIntentPrompt('放周杰伦', '只输出一行口令。', commands)
  assert.ok(noPlaceholder.includes('口令表'))
  assert.ok(noPlaceholder.includes('用户原话：放周杰伦'))
})

test('sanitizeIntentQuery flattens and trims user text', () => {
  assert.equal(sanitizeIntentQuery('  播放\n“夜曲”\t'), '播放 夜曲')
  assert.ok(sanitizeIntentQuery('播'.repeat(100)).length <= 60)
})

test('failure settings are clamped', () => {
  assert.equal(normalizeAiFailureThreshold(0), 1)
  assert.equal(normalizeAiFailureThreshold(99), 10)
  assert.equal(normalizeAiFailureWindow(0), 1)
  assert.equal(normalizeAiFailureWindow(99), 60)
  assert.equal(normalizeAiFailureThreshold('bad'), 3)
  assert.equal(normalizeAiFailureWindow('bad'), 10)
})
