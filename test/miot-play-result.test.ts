import assert from 'node:assert/strict'
import test from 'node:test'
import { MinaHTTPClient } from '../src/server/integrations/miot/minaClient'

const client = MinaHTTPClient.fromManualToken('1', 'test-token')
const evaluate = (result: unknown) => (client as any).evaluatePlayResult(result, 'test')

test('cloud control timeout 3012 is uncertain instead of a play failure', () => {
  assert.equal(evaluate({
    code: 101,
    message: 'ubus server or device returned invalid result',
    data: { device_data: '{"msg":"远程控制超时","code":3012}' },
  }), 'timeout')
})

test('ubus code 101 without device result is treated as uncertain', () => {
  assert.equal(evaluate({ code: 101, message: 'ubus unavailable' }), 'timeout')
})

test('missing ubus response is treated as uncertain', () => {
  assert.equal(evaluate(null), 'timeout')
})

test('explicit device rejection stays a failure', () => {
  assert.equal(evaluate({ code: 0, data: { code: 3 } }), 'failed')
  assert.equal(evaluate({ code: 102, message: 'invalid request' }), 'failed')
})

test('successful ubus response is ok', () => {
  assert.equal(evaluate({ code: 0, data: { code: 0 } }), 'ok')
  assert.equal(evaluate({ code: 0 }), 'ok')
})
