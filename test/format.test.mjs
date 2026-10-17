/**
 * Text and limit helpers for the chat screens.
 *
 * These are the places where a Telegram platform limit is enforced, so the
 * assertions are about bytes and code points rather than about wording.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_CALLBACK_BYTES,
  MAX_MESSAGE_LENGTH,
  callbackFits,
  countButtons,
  cut,
  joinLines,
  oneLine,
  relativeTime,
  runDuration,
  shortId,
  splitMessage,
  truncate,
} from '../lib/format.mjs'

test('truncate counts code points, not UTF-16 units', () => {
  assert.equal(truncate('abcdefghij', 5), 'abcd…')
  assert.equal(truncate('abc', 5), 'abc')
  // A surrogate pair is one character; cutting it in half would produce a
  // replacement glyph in Telegram.
  assert.equal(truncate('🟢🟢🟢🟢', 3), '🟢🟢…')
  assert.equal([...truncate('🟢🟢🟢', 2)].length, 2)
})

test('cut omits the ellipsis so a caller can add its own decoration', () => {
  assert.equal(cut('abcdefghij', 4), 'abcd')
  assert.equal(cut('abc', 10), 'abc')
})

test('oneLine collapses a multi-line answer onto a single line', () => {
  assert.equal(oneLine('a\n\n  b\tc  '), 'a b c')
  assert.equal(oneLine('a\nb', 3), 'a b')
})

test('relativeTime uses the wording of the screens', () => {
  const now = Date.UTC(2026, 9, 14, 12, 0, 0)
  const back = (ms) => relativeTime(now - ms, { now })
  assert.equal(back(30 * 1000), 'только что')
  assert.equal(back(5 * 60 * 1000), '5 мин')
  assert.equal(back(2 * 60 * 60 * 1000), '2 ч')
  assert.equal(back(3 * 24 * 60 * 60 * 1000), '3 дн')
  // Past a week the label becomes a date, and the `suffix` form does not leak
  // the word "назад" onto a bare date.
  assert.equal(back(30 * 24 * 60 * 60 * 1000), '14.09')
  assert.equal(relativeTime(now - 5 * 60 * 1000, { now, suffix: true }), '5 мин назад')
  assert.equal(relativeTime(now - 30 * 24 * 60 * 60 * 1000, { now, suffix: true }), '14.09')
})

test('relativeTime shows a year for a date outside the current one', () => {
  const now = Date.UTC(2026, 0, 5)
  assert.equal(relativeTime(Date.UTC(2025, 10, 20), { now }), '20.11.2025')
})

test('relativeTime degrades to a dash without a timestamp', () => {
  assert.equal(relativeTime(0), '—')
  assert.equal(relativeTime(null), '—')
})

test('runDuration matches the notification wording', () => {
  assert.equal(runDuration(45), '45 с')
  assert.equal(runDuration(80), '1 мин 20 с')
  assert.equal(runDuration(120), '2 мин')
  assert.equal(runDuration(7500), '2 ч 5 мин')
  assert.equal(runDuration(7200), '2 ч')
})

test('shortId keeps a readable head and tail', () => {
  assert.equal(shortId('6f1c2d3e4f5a6b7c8d9e'), '6f1c2d3e…9e')
  assert.equal(shortId('abc'), 'abc')
})

test('splitMessage is lossless and respects the Telegram limit', () => {
  const text = `${'a'.repeat(3000)}\n${'b'.repeat(3000)}`
  const parts = splitMessage(text)
  assert.ok(parts.length >= 2)
  for (const part of parts) assert.ok(part.length <= MAX_MESSAGE_LENGTH, `part of ${part.length} exceeds the limit`)
  assert.equal(parts.join(''), text)
})

test('splitMessage prefers a line break over a hard cut', () => {
  const text = `${'x'.repeat(100)}\n${'y'.repeat(100)}`
  const [first] = splitMessage(text, 120)
  assert.equal(first.endsWith('\n'), true, 'the break lands on the newline')
})

test('callbackFits enforces the 64-byte payload budget', () => {
  assert.equal(callbackFits('m'), true)
  // A real Harness Session id needs 46 bytes for `c:` plus the id.
  assert.equal(callbackFits('c:session-58b80b9b-1bc5-495d-9626-4270b477a8b9'), true)
  assert.equal(callbackFits(`c:${'x'.repeat(80)}`), false)
  assert.equal(Buffer.byteLength(`c:${'x'.repeat(62)}`, 'utf8'), MAX_CALLBACK_BYTES)
  assert.equal(callbackFits(`c:${'x'.repeat(62)}`), true)
  assert.equal(callbackFits(`c:${'x'.repeat(63)}`), false)
})

test('joinLines drops absent blocks but keeps an intentional blank line', () => {
  // `undefined`/`null` mean "this block is not here", so no gap is left behind.
  assert.equal(joinLines(['a', undefined, null, 'b']), 'a\nb')
  // A blank string is the layout's paragraph break (§5) and must survive.
  assert.equal(joinLines(['a', '', 'b']), 'a\n\nb')
  assert.equal(countButtons([[1, 2], [3]]), 3)
  assert.equal(countButtons(undefined), 0)
})
