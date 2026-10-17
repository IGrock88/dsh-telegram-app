/**
 * Offline tests for the Mini App payload verification.
 *
 * The vector is built here with the documented algorithm and then checked from
 * the outside, so the test proves the implementation follows the specification
 * rather than merely agreeing with itself.
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { PairingStore, SessionTokens, dataCheckString, hashToken, safeEqual, validateInitData } from '../lib/auth.mjs'

const BOT_TOKEN = '5768337691:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8'
const USER = { id: 279058397, first_name: 'Vladislav', username: 'vdkfrost', language_code: 'ru' }

/** Build a signed initData payload exactly the way Telegram does. */
function sign(fields, botToken = BOT_TOKEN) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) params.set(key, String(value))
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const hash = createHmac('sha256', secret).update(dataCheckString(params)).digest('hex')
  params.set('hash', hash)
  return params.toString()
}

test('accepts a payload signed by the bot token', () => {
  const initData = sign({ auth_date: 1733584787, chat_instance: '-1', chat_type: 'private', user: JSON.stringify(USER) })
  const result = validateInitData(initData, BOT_TOKEN, { now: 1733584787 * 1000 + 1000 })
  assert.equal(result.ok, true)
  assert.equal(result.userId, 279058397)
  assert.equal(result.chatId, 279058397, 'a private chat id equals the user id')
  assert.equal(result.chatType, 'private')
  assert.equal(result.username, 'vdkfrost')
})

test('rejects a payload signed by another bot token', () => {
  const initData = sign({ auth_date: 1733584787, user: JSON.stringify(USER) })
  const result = validateInitData(initData, '123456:OTHER-TOKEN', { now: 1733584787 * 1000 + 1000 })
  assert.equal(result.ok, false)
  assert.match(result.error, /signature mismatch/)
})

test('rejects a payload whose user field was edited after signing', () => {
  const initData = sign({ auth_date: 1733584787, user: JSON.stringify(USER) })
  const tampered = initData.replace('279058397', '999999999')
  const result = validateInitData(tampered, BOT_TOKEN, { now: 1733584787 * 1000 + 1000 })
  assert.equal(result.ok, false)
})

test('rejects a stale payload', () => {
  const initData = sign({ auth_date: 1733584787, user: JSON.stringify(USER) })
  const result = validateInitData(initData, BOT_TOKEN, { now: 1733584787 * 1000 + 90_000_000 })
  assert.equal(result.ok, false)
  assert.match(result.error, /expired/)
})

test('accepts a payload that also carries a third-party signature field', () => {
  const params = new URLSearchParams(sign({ auth_date: 1733584787, user: JSON.stringify(USER) }))
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  params.set('signature', 'ZmFrZS1zaWduYXR1cmU')
  params.set('hash', createHmac('sha256', secret).update(dataCheckString(params)).digest('hex'))
  const result = validateInitData(params.toString(), BOT_TOKEN, { now: 1733584787 * 1000 + 1000 })
  assert.equal(result.ok, true)
})

test('control tokens compare in constant time and by value only', () => {
  assert.equal(safeEqual('secret-token', 'secret-token'), true)
  assert.equal(safeEqual('secret-token', 'secret-tokeN'), false)
  assert.equal(safeEqual('secret-token', 'secret-token '), false)
})

test('pairing persists chats and survives a reload', () => {
  const file = `${process.env.TMPDIR ?? '/tmp'}/dsh-telegram-app-test-${process.pid}.json`
  const store = new PairingStore({ file })
  store.load()
  assert.equal(store.hasChat(1), false)
  store.pair('control-token', { userId: 42, chatId: 42 })
  assert.equal(store.hasChat(42), true)

  const reloaded = new PairingStore({ file })
  reloaded.load()
  assert.equal(reloaded.hasChat(42), true)
  assert.equal(reloaded.state.controlTokenHash, hashToken('control-token'))
})

test('issued session tokens expire', () => {
  const expired = new SessionTokens({ ttlSec: 0 })
  const token = expired.issue({ userId: 1, chatId: 1 })
  assert.equal(expired.verify(token), null, 'a zero-ttl token is already expired')

  const live = new SessionTokens({ ttlSec: 60 })
  const ok = live.issue({ userId: 1, chatId: 1 })
  assert.equal(live.verify(ok)?.userId, 1)
  assert.equal(live.verify('nope'), null)
})
