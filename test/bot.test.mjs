/**
 * Transport-level tests for the Bot API payloads.
 *
 * These exist because of a bug that made the whole interface unusable and that no
 * screen-level test could see: `sendMessage` accepted both `keyboard` and
 * `replyKeyboard` and assigned them to the same `reply_markup` field, so the second
 * assignment won. Every screen therefore shipped without its buttons — the bot answered
 * and the owner had nothing to press — while the screen renderers, which are pure, kept
 * returning correct keyboards and every test stayed green.
 *
 * The lesson is that a payload builder needs its own test: correctness of the model plus
 * correctness of the request does not follow from either one alone.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { TelegramBot } from '../lib/bot.mjs'

/** A bot whose API call is captured instead of sent. */
function capturingBot() {
  const sent = []
  const bot = new TelegramBot({ token: 'test-token' })
  bot.call = async (method, payload) => {
    sent.push({ method, payload })
    return { message_id: sent.length }
  }
  return { bot, sent }
}

test('an inline keyboard survives on its own', async () => {
  const { bot, sent } = capturingBot()
  const keyboard = [[{ text: '📁 Воркспейсы', callback_data: 'wl' }]]
  await bot.sendMessage(1, 'text', { keyboard })

  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].payload.reply_markup, { inline_keyboard: keyboard })
})

test('a message never carries both keyboards at once', async () => {
  // The regression itself. Telegram accepts exactly one `reply_markup`; the transport must
  // not pretend otherwise, because the losing keyboard disappears without an error.
  const { bot, sent } = capturingBot()
  const keyboard = [[{ text: '📁 Воркспейсы', callback_data: 'wl' }]]
  const replyKeyboard = [[{ text: '🏠 Меню' }]]
  await bot.sendMessage(1, 'text', { keyboard, replyKeyboard })

  assert.equal(sent.length, 1)
  const markup = sent[0].payload.reply_markup
  assert.equal('inline_keyboard' in markup && 'keyboard' in markup, false, 'only one slot is filled')

  // The reply keyboard wins by design: it is the one the owner needs to get back to the
  // menu, and a screen's buttons can be reached from that menu again.
  assert.notEqual(markup.keyboard, undefined, 'the reply keyboard is what rides a pairing message')
  assert.equal(markup.resize_keyboard, true)
  assert.equal(markup.is_persistent, true)
  assert.equal(markup.inline_keyboard, undefined, 'the inline keyboard is not silently half-sent')
})

test('a message with no keyboard carries no reply_markup at all', async () => {
  const { bot, sent } = capturingBot()
  await bot.sendMessage(1, 'text')
  assert.equal('reply_markup' in sent[0].payload, false)
})

test('a long message is split and only the first part is returned', async () => {
  const { bot, sent } = capturingBot()
  const keyboard = [[{ text: 'ok', callback_data: 'm' }]]
  const first = await bot.sendMessage(1, 'x'.repeat(9000), { keyboard })

  assert.ok(sent.length > 1, 'the text was split')
  assert.equal(first.message_id, 1, 'the caller gets the first message')
  // Every part keeps the keyboard, so the buttons are reachable from the tail as well.
  for (const call of sent) {
    assert.deepEqual(call.payload.reply_markup, { inline_keyboard: keyboard })
  }
})

test('an unconfigured bot sends nothing', async () => {
  const sent = []
  const bot = new TelegramBot({ token: '' })
  bot.call = async (method, payload) => {
    sent.push({ method, payload })
    return { message_id: 1 }
  }
  assert.equal(bot.configured, false)
  assert.equal(await bot.sendMessage(1, 'text', { keyboard: [[{ text: 'a', callback_data: 'm' }]] }), undefined)
  assert.deepEqual(sent, [], 'no request is made without a token')
})
