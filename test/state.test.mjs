/**
 * The durable state file.
 *
 * Two properties are load-bearing and are pinned here: the control token never
 * reaches the disk in the clear, and a restart or a schema change cannot lose a
 * chat's authorization or its per-chat settings.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_SETTINGS, SESSION_LIMITS, StateStore, WORKSPACE_SORTS, hashToken, normalizeSettings } from '../lib/state.mjs'

/** A throwaway state file inside the OS temp directory. */
function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telegram-app-'))
  return path.join(dir, name)
}

test('a fresh store remembers nothing and is not armed', () => {
  const store = new StateStore({ file: tempFile('state.json') })
  store.load()
  assert.deepEqual(store.chats(), [])
  assert.equal(store.hasControlToken(), false)
  assert.equal(store.binding(1), null)
  assert.equal(store.notifyEnabled(1), DEFAULT_SETTINGS.notify)
})

test('the control token is stored as a digest, never in the clear', () => {
  const file = tempFile('state.json')
  const store = new StateStore({ file })
  store.load()
  store.setControlToken('super-secret-token')

  const raw = fs.readFileSync(file, 'utf8')
  assert.equal(raw.includes('super-secret-token'), false, 'the token itself must not be on disk')
  assert.equal(JSON.parse(raw).controlTokenHash, hashToken('super-secret-token'))
  assert.equal(store.matchesControlToken('super-secret-token'), true)
  assert.equal(store.matchesControlToken('super-secret-tokeN'), false)
  // Length differences must not leak either: the comparison is over digests.
  assert.equal(store.matchesControlToken('super-secret-token '), false)
  assert.equal(store.matchesControlToken(''), false)
})

test('pairing, binding and settings survive a reload', () => {
  const file = tempFile('state.json')
  const store = new StateStore({ file })
  store.load()
  store.setControlToken('token')
  store.pair({ userId: 42, chatId: 42 })
  store.bindSession(42, 'session-1', { workspaceId: 'ws-1' })
  store.setSetting(42, 'sessionLimit', 10)
  store.setSetting(42, 'workspaceSort', 'activity')
  store.setSetting(42, 'notify', false)
  store.markCreatedByBot('session-1')

  const reloaded = new StateStore({ file })
  reloaded.load()
  assert.equal(reloaded.hasChat(42), true)
  assert.equal(reloaded.hasUser(42), true)
  assert.deepEqual(reloaded.binding(42), { sessionId: 'session-1', workspaceId: 'ws-1', boundAt: reloaded.binding(42).boundAt })
  assert.deepEqual(reloaded.settings(42), { sessionLimit: 10, workspaceSort: 'activity', notify: false })
  assert.equal(reloaded.isCreatedByBot('session-1'), true)
  assert.equal(reloaded.matchesControlToken('token'), true)
})

test('a chat never opened the settings screen follows the plugin defaults', () => {
  const store = new StateStore({ file: tempFile('state.json'), defaults: { sessionLimit: 15, workspaceSort: 'activity', notify: false } })
  store.load()
  assert.deepEqual(store.settings(7), { sessionLimit: 15, workspaceSort: 'activity', notify: false })
  // Touching one field must not reset the others back to the built-in values.
  store.setSetting(7, 'notify', true)
  assert.deepEqual(store.settings(7), { sessionLimit: 15, workspaceSort: 'activity', notify: true })
})

test('settings refuse values outside the offered set', () => {
  const store = new StateStore({ file: tempFile('state.json') })
  store.load()
  assert.equal(store.setSetting(1, 'sessionLimit', 7), false, '7 is not one of 3/5/10/15')
  assert.equal(store.setSetting(1, 'sessionLimit', 5), false, '5 is already the default, so nothing changed')
  assert.equal(store.setSetting(1, 'workspaceSort', 'alphabetical'), false)
  assert.equal(store.setSetting(1, 'workspaceSort', 'activity'), true)
  assert.equal(store.setSetting(1, 'notify', 'yes'), false, 'only booleans are accepted')
  assert.equal(store.setSetting(1, 'unknownKey', true), false)
  // Every offered value is accepted, and re-applying the current one is not a
  // change — which is what lets the settings screen skip a pointless redraw.
  let previous = store.settings(1).sessionLimit
  for (const value of SESSION_LIMITS) {
    assert.equal(store.setSetting(1, 'sessionLimit', value), value !== previous, `setting the limit to ${value}`)
    assert.equal(store.setSetting(1, 'sessionLimit', value), false, `setting the limit to ${value} twice`)
    previous = value
  }
  previous = store.settings(1).workspaceSort
  for (const value of WORKSPACE_SORTS) {
    assert.equal(store.setSetting(1, 'workspaceSort', value), value !== previous, `setting the sort to ${value}`)
    previous = value
  }
})

test('normalizeSettings repairs a corrupt block field by field', () => {
  const fallback = { sessionLimit: 5, workspaceSort: 'registry', notify: true }
  assert.deepEqual(normalizeSettings({ sessionLimit: 999, workspaceSort: 'nope', notify: 'maybe' }, fallback), fallback)
  assert.deepEqual(normalizeSettings({ sessionLimit: 10 }, fallback), { sessionLimit: 10, workspaceSort: 'registry', notify: true })
  assert.equal(normalizeSettings(undefined, fallback).notify, true)
})

test('rotating the control token keeps the chats that are already paired', () => {
  const file = tempFile('state.json')
  const store = new StateStore({ file })
  store.load()
  store.setControlToken('old-token')
  store.pair({ userId: 42, chatId: 42 })
  store.bindSession(42, 'session-1')

  store.setControlToken('new-token')
  assert.equal(store.hasChat(42), true, '§9: a token change must not reset chat bindings')
  assert.equal(store.boundSessionId(42), 'session-1')
  assert.equal(store.matchesControlToken('old-token'), false)
  assert.equal(store.matchesControlToken('new-token'), true)
})

test('unpair revokes authorization and forgets what belonged to the chat', () => {
  const store = new StateStore({ file: tempFile('state.json') })
  store.load()
  store.pair({ userId: 42, chatId: 42 })
  store.bindSession(42, 'session-1', { workspaceId: 'ws-1' })
  store.setSetting(42, 'notify', false)

  assert.equal(store.unpair(42), true)
  assert.equal(store.hasChat(42), false)
  assert.equal(store.binding(42), null)
  assert.deepEqual(store.settings(42), DEFAULT_SETTINGS)
  assert.equal(store.unpair(42), false, 'unpairing twice is not a change')
})

test('unpair keeps a user id that another paired chat still needs', () => {
  const store = new StateStore({ file: tempFile('state.json') })
  store.load()
  store.pair({ userId: 42, chatId: 42 })
  store.pair({ userId: 42, chatId: 43 })
  store.unpair(43)
  assert.equal(store.hasUser(42), true, 'chat 42 still belongs to user 42')
  store.unpair(42)
  assert.equal(store.hasUser(42), false)
})

test('the legacy pairing file is read without losing the pairing', () => {
  const file = tempFile('state.json')
  // Exactly what the Mini App layer used to write.
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    controlTokenHash: hashToken('legacy-token'),
    users: [42],
    chats: [42],
    pairedAt: 1700000000000,
  }))

  const store = new StateStore({ file })
  store.load()
  assert.equal(store.hasChat(42), true)
  assert.equal(store.matchesControlToken('legacy-token'), true)
  assert.equal(store.pairedAt(42), 1700000000000, 'the old single timestamp becomes this chat‘s stamp')
  assert.deepEqual(store.settings(42), DEFAULT_SETTINGS)
})

test('the pre-settings flat notify map is folded into the settings block', () => {
  const file = tempFile('state.json')
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    chats: [42],
    notify: { 42: false },
    settings: { 42: { sessionLimit: 10, workspaceSort: 'registry' } },
  }))
  const store = new StateStore({ file })
  store.load()
  assert.deepEqual(store.settings(42), { sessionLimit: 10, workspaceSort: 'registry', notify: false })
})

test('a corrupt entry is dropped instead of poisoning the whole file', () => {
  const file = tempFile('state.json')
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    chats: [42, 'nonsense', null],
    // A binding and a settings block keyed by a non-numeric chat id are not
  // addressable, so they are dropped rather than kept in a half-typed shape.
  bindings: { 42: { sessionId: 'session-1' }, 43: { sessionId: '' }, nonsense: { sessionId: 'session-x' } },
    settings: { 42: { sessionLimit: 999 }, nonsense: { notify: true } },
    createdByBot: ['session-1', '', 5],
  }))
  const store = new StateStore({ file })
  store.load()
  assert.deepEqual(store.chats(), [42])
  assert.equal(store.boundSessionId(42), 'session-1')
  assert.equal(store.binding(43), null, 'a binding without a session id is not a binding')
  assert.deepEqual(store.settings(42), DEFAULT_SETTINGS, 'an out-of-range limit falls back')
  assert.deepEqual(store.state.createdByBot, ['session-1'])
})

test('an unreadable file is treated as an empty state, not a crash', () => {
  const file = tempFile('state.json')
  fs.writeFileSync(file, '{ this is not json')
  const warnings = []
  const store = new StateStore({ file, logger: { warn: (...args) => warnings.push(args) } })
  store.load()
  assert.deepEqual(store.chats(), [])
  assert.equal(warnings.length, 1, 'the fault is reported once')
})

test('saving is atomic: no temporary file is left behind', () => {
  const file = tempFile('state.json')
  const store = new StateStore({ file })
  store.load()
  store.pair({ userId: 1, chatId: 1 })
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp'))
  assert.deepEqual(leftovers, [])
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1)
})

test('markCreatedByBot is idempotent and forgettable', () => {
  const store = new StateStore({ file: tempFile('state.json') })
  store.load()
  assert.equal(store.markCreatedByBot('session-1'), true)
  assert.equal(store.markCreatedByBot('session-1'), false)
  assert.equal(store.isCreatedByBot('session-1'), true)
  assert.equal(store.forgetCreatedByBot('session-1'), true)
  assert.equal(store.isCreatedByBot('session-1'), false)
})
