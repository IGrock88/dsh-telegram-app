/**
 * Chat-side localisation: dictionary integrity, and the bot actually speaking English.
 *
 * Two kinds of test live here, and they catch different mistakes.
 *
 * The dictionary tests are exhaustive and cheap: they guarantee that every key exists in every
 * language, that none is empty, and that a phrase needing parameters really receives them. A
 * half-finished translation is the likely failure of a feature like this, and it fails
 * silently — a missing key falls back to Russian, so the screen still renders and only a
 * Russian-reading owner would notice the seam.
 *
 * The screen and router tests are the opposite: they check a handful of complete sentences in
 * English, end to end, through the same fake bot the Russian acceptance tests use. Those are
 * what prove the language setting is actually threaded from the config into a message.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { COMMANDS, commandsFor, createRouter } from '../lib/chat.mjs'
import { relativeTime, runDuration } from '../lib/format.mjs'
import { DICTIONARIES, LOCALES, createTranslator, dictionaryKeys, pluralEn, pluralRu, resolveLocale } from '../lib/i18n.mjs'
import { CB, cbNotify, menuReplyKeyboard, menuReplyLabel } from '../lib/markup.mjs'
import { renderChats, renderMenu, renderSession, renderSettings, renderWorkspaces } from '../lib/screens.mjs'
import { createSessionApi } from '../lib/sessions.mjs'
import { StateStore } from '../lib/state.mjs'
import { callback, fakeBot, fakeLogger, fakeRegistry, fakeSessions, message, summary, tempDir, workspace } from './fixtures.mjs'

const CHAT = 424242

/** The English and Russian translators, for direct renderer calls. */
const en = createTranslator('en')
const ru = createTranslator('ru')

/** A router wired the way `index.js` wires it, in the requested language. */
function world(options = {}) {
  const root = tempDir()
  const alpha = path.join(root, 'dsh-telegram-app')
  fs.mkdirSync(alpha)

  const now = 1_700_000_000_000
  const summaries = [
    summary('session-1', { cwd: alpha, title: 'Auth fix', updatedAt: now - 12 * 60 * 1000 }),
    summary('session-2', { cwd: alpha, title: 'Layer 1 spec', updatedAt: now - 2 * 60 * 60 * 1000 }),
  ]
  const state = new StateStore({ file: path.join(root, 'state.json'), logger: fakeLogger() })
  state.load()
  state.setControlToken('correct-horse')

  const bot = fakeBot()
  const rawSessions = fakeSessions({ summaries })
  const sessions = createSessionApi(
    { get: (name) => (name === 'sessionController' ? rawSessions : undefined) },
    { logger: fakeLogger() },
  )
  const registry = fakeRegistry({
    workspaces: [workspace('w-alpha', alpha, 'dsh-telegram-app')],
    archived: [],
  })
  const config = { locale: options.locale, cwd: alpha, harnessVersion: '0.2.0', pluginVersion: '0.1.0' }
  const router = createRouter({ config, state, bot, sessions, registry, logger: fakeLogger(), now: () => now })
  return { root, alpha, state, bot, router, now }
}

// ── Dictionaries ────────────────────────────────────────────────────────────

test('every locale defines exactly the same keys', () => {
  const keys = dictionaryKeys()
  assert.ok(keys.length > 100, 'the dictionary is not a stub')
  for (const locale of LOCALES) {
    const own = Object.keys(DICTIONARIES[locale]).sort()
    assert.deepEqual(own, keys, `${locale} must define every key`)
  }
})

test('no entry is an empty string', () => {
  for (const locale of LOCALES) {
    for (const [key, entry] of Object.entries(DICTIONARIES[locale])) {
      if (typeof entry === 'string') {
        assert.notEqual(entry.trim(), '', `${locale}.${key} is empty`)
      } else {
        assert.equal(typeof entry, 'function', `${locale}.${key} is neither a string nor a function`)
      }
    }
  }
})

test('every placeholder a function uses is supplied by its callers', () => {
  // A phrase that interpolates `{count}` and receives nothing renders the literal braces, which
  // reaches the owner as visible junk. Calling every function with a full set of plausible
  // parameters is the cheapest way to catch a typo in a placeholder name.
  const params = { count: 3, total: 3, shown: 2, title: 'x', id: 'abc', folder: 'f', state: 's', when: 'now', value: 'v', values: 'a|b', state2: 's', length: 1, max: 2, argument: 'a', error: 'e', reason: 'r', tool: 't', seconds: 5, duration: 'd', command: 'c', username: 'u', harness: 'h', plugin: 'p', workspaces: 1, sessions: 2, running: 0, answer: 'a', where: 'w', queued: false }
  for (const locale of LOCALES) {
    for (const [key, entry] of Object.entries(DICTIONARIES[locale])) {
      if (typeof entry !== 'function') continue
      const rendered = entry(params)
      assert.equal(typeof rendered, 'string', `${locale}.${key} must return a string`)
      assert.ok(!/\{\w+\}/u.test(rendered), `${locale}.${key} left a placeholder unfilled: ${rendered}`)
    }
  }
})

test('a missing key falls back to Russian, and an unknown one stays visible', () => {
  // Falling back means a translation gap shows up as the wrong language rather than as an
  // empty message the owner cannot act on.
  assert.equal(en('cmd.help'), 'Help')
  assert.equal(ru('cmd.help'), 'Справка')
  assert.equal(en('this.key.does.not.exist'), 'this.key.does.not.exist')
})

test('resolveLocale accepts real-world values and refuses to crash', () => {
  assert.equal(resolveLocale('en'), 'en')
  assert.equal(resolveLocale('EN'), 'en')
  assert.equal(resolveLocale('en-GB'), 'en')
  assert.equal(resolveLocale('ru_RU'), 'ru')
  assert.equal(resolveLocale(' en '), 'en')
  // Anything unrecognised resolves to the default rather than failing: a bad language setting
  // must not take the bridge down.
  assert.equal(resolveLocale('de'), 'ru')
  assert.equal(resolveLocale(''), 'ru')
  assert.equal(resolveLocale(undefined), 'ru')
  assert.equal(resolveLocale(42), 'ru')
  // The translator records what it settled on.
  assert.equal(createTranslator('en-GB').locale, 'en')
  assert.equal(createTranslator('klingon').locale, 'ru')
})

test('plural agreement follows each language own rules', () => {
  assert.equal(pluralRu(1, 'сессия', 'сессии', 'сессий'), 'сессия')
  assert.equal(pluralRu(2, 'сессия', 'сессии', 'сессий'), 'сессии')
  assert.equal(pluralRu(5, 'сессия', 'сессии', 'сессий'), 'сессий')
  assert.equal(pluralRu(11, 'сессия', 'сессии', 'сессий'), 'сессий')
  assert.equal(pluralRu(21, 'сессия', 'сессии', 'сессий'), 'сессия')
  // English has two forms where Russian has three, which is why the agreement lives in the
  // dictionaries instead of in one shared helper.
  assert.equal(pluralEn(1, 'session', 'sessions'), 'session')
  assert.equal(pluralEn(0, 'session', 'sessions'), 'sessions')
  assert.equal(pluralEn(2, 'session', 'sessions'), 'sessions')
})

test('the command list is translated, but command names are not', () => {
  const names = COMMANDS.map(([command]) => command)
  assert.deepEqual(commandsFor(ru).map(([command]) => command), names)
  assert.deepEqual(commandsFor(en).map(([command]) => command), names)
  assert.equal(commandsFor(ru)[0][1], 'Открыть меню')
  assert.equal(commandsFor(en)[0][1], 'Open the menu')
})

// ── Screens ─────────────────────────────────────────────────────────────────

test('L0 renders in English', () => {
  const view = { pairedAt: 1_700_000_000_000 - 5 * 60 * 1000, now: 1_700_000_000_000, notify: true, runningCount: 0, sessionCount: 3, workspaceCount: 2 }
  const { text, keyboard } = renderMenu({ ...view, t: en })
  assert.match(text, /^🏠 DSH/)
  assert.match(text, /Chat paired: 5 min · notifications: on/)
  assert.match(text, /0 running · 3 sessions in 2 workspaces/)
  assert.match(text, /Where to\?/)
  assert.deepEqual(keyboard[0].map((button) => button.text), ['📁 Workspaces', '⚙️ Settings'])
})

test('L0 still renders in Russian, and agrees on the counts', () => {
  const { text } = renderMenu({ pairedAt: 1_700_000_000_000, now: 1_700_000_000_000, notify: false, runningCount: 1, sessionCount: 21, workspaceCount: 5, t: ru })
  assert.match(text, /Сессий в работе: 1 · доступно: 21 сессия в 5 воркспейсах/)
  assert.match(text, /уведомления: выкл/)
})

test('S renders in English with translated value rows', () => {
  const { text, keyboard } = renderSettings({ t: en, settings: { sessionLimit: 5, workspaceSort: 'activity', notify: false } })
  assert.match(text, /^⚙️ Settings/)
  assert.match(text, /Chats shown per folder: 5/)
  assert.match(text, /Folder order: by activity/)
  assert.match(text, /Notifications: off/)
  // The active value carries the bullet, whichever language labels it.
  assert.deepEqual(keyboard[1].map((button) => button.text), ['As in the sidebar', '• By activity'])
  assert.deepEqual(keyboard[2].map((button) => button.text), ['On', '• Off'])
})

test('L1 renders in English, including an empty folder list', () => {
  const workspaces = [{ id: 'w-alpha', title: 'dsh-telegram-app', path: '/work/app', sessionCount: 2, lastActivityAt: 1_700_000_000_000 - 3 * 24 * 60 * 60 * 1000 }]
  const { text, keyboard } = renderWorkspaces({ t: en, workspaces, now: 1_700_000_000_000, binding: false })
  assert.match(text, /^📁 Workspaces \(1\)/)
  assert.match(text, /dsh-telegram-app · 2 sessions · 3 d ago/)
  assert.deepEqual(keyboard.at(-1).map((button) => button.text), ['🔄 Refresh', '⚙️ Settings', '🏠 Menu'])

  const empty = renderWorkspaces({ t: en, workspaces: [] })
  assert.match(empty.text, /No folders with sessions\./)
})

test('L2 renders in English', () => {
  const { text, keyboard } = renderChats({
    t: en,
    workspace: { id: 'w-alpha', title: 'dsh-telegram-app', path: '/work/app' },
    sessions: [{ sessionId: 'session-1', title: 'Auth fix', running: true, updatedAt: 1_700_000_000_000 }],
    total: 4,
    limit: 5,
    bindingSessionId: 'session-1',
    now: 1_700_000_000_000,
    state: { isCreatedByBot: () => false },
  })
  assert.match(text, /^📁 dsh-telegram-app · \/work\/app/)
  assert.match(text, /Last 1 of 4/)
  assert.match(text, /1\. 🟢 📌 Auth fix · just now/)
  assert.ok(keyboard.flat().some((button) => button.text === '➕ New in this folder'))
})

test('L3 renders in English, in all three of its shapes', () => {
  const session = { sessionId: 'session-1', title: 'Auth fix', running: false, updatedAt: 1_700_000_000_000 - 90 * 1000 }
  const bound = renderSession({ t: en, session, folderTitle: 'dsh-telegram-app', lastAnswer: 'Done.', now: 1_700_000_000_000 })
  assert.match(bound.text, /^📌 Auth fix/)
  assert.match(bound.text, /id: session-1 · folder: dsh-telegram-app/)
  assert.match(bound.text, /state: ⚪ waiting for input · updated 1 min ago/)
  assert.match(bound.text, /last answer: «Done\.»/)
  assert.match(bound.text, /Type text — it goes to this chat\./)

  const gone = renderSession({ t: en, session: null, stale: true })
  assert.match(gone.text, /Session unavailable/)
  assert.match(gone.text, /It was deleted or archived/)

  const pending = renderSession({ t: en, session, unknown: true })
  assert.match(pending.text, /not in the list yet/)
  assert.ok(pending.keyboard.flat().some((button) => button.text === '🔄 Refresh'))
})

test('an unbound session screen names no folder rather than printing a blank', () => {
  const bound = renderSession({ t: en, session: { sessionId: 'session-1', title: 'Auth fix', running: false, updatedAt: 1_700_000_000_000 }, now: 1_700_000_000_000 })
  assert.match(bound.text, /folder: —/)
})

// ── Clock helpers ───────────────────────────────────────────────────────────

test('time units follow the language', () => {
  const now = 1_700_000_000_000
  assert.equal(relativeTime(now - 5 * 60 * 1000, { now, t: en }), '5 min')
  assert.equal(relativeTime(now - 5 * 60 * 1000, { now, suffix: true, t: en }), '5 min ago')
  assert.equal(relativeTime(now - 2 * 60 * 60 * 1000, { now, t: en }), '2 h')
  assert.equal(relativeTime(now - 3 * 24 * 60 * 60 * 1000, { now, t: en }), '3 d')
  assert.equal(relativeTime(now - 1000, { now, t: en }), 'just now')
  assert.equal(relativeTime(0, { t: en }), '—')
  // The Russian wording is unchanged, which is what keeps the existing suite meaningful.
  assert.equal(relativeTime(now - 5 * 60 * 1000, { now, suffix: true }), '5 мин назад')
})

test('turn duration follows the language', () => {
  assert.equal(runDuration(45, { t: en }), '45 s')
  assert.equal(runDuration(80, { t: en }), '1 min 20 s')
  assert.equal(runDuration(120, { t: en }), '2 min')
  assert.equal(runDuration(7500, { t: en }), '2 h 5 min')
  assert.equal(runDuration(7500), '2 ч 5 мин')
})

test('the reply keyboard carries the translated label', () => {
  assert.deepEqual(menuReplyKeyboard(en), [[{ text: '🏠 Menu' }]])
  assert.equal(menuReplyLabel(en), '🏠 Menu')
  assert.equal(menuReplyLabel(ru), '🏠 Меню')
})

// ── The bot itself ──────────────────────────────────────────────────────────

test('an English bot pairs, navigates and answers in English', async () => {
  const env = world({ locale: 'en' })

  // A stranger's plain text is read as a token attempt, so it is refused — in English.
  await env.router.handleMessage(message(CHAT, 'hello'))
  assert.match(env.bot.lastTo(CHAT), /Wrong token\./)

  await env.router.handleMessage(message(CHAT, 'correct-horse'))
  assert.ok(env.bot.textsTo(CHAT).includes('✅ Chat paired.'))

  // The menu, then a folder, then the chats of that folder — the whole walk.
  await env.router.handleMessage(message(CHAT, '/menu'))
  assert.match(env.bot.lastTo(CHAT), /Chat paired:/)
  assert.match(env.bot.lastTo(CHAT), /Where to\?/)

  await env.router.handleMessage(message(CHAT, '/chats'))
  assert.match(env.bot.lastTo(CHAT), /📁 Workspaces/)

  // `/help` lists translated descriptions, but the names stay literal.
  await env.router.handleMessage(message(CHAT, '/help'))
  const help = env.bot.lastTo(CHAT)
  assert.match(help, /DSH is online\./)
  assert.match(help, /\/start — Open the menu/)
  assert.match(help, /Any text = a task in the bound chat\./)
  assert.ok(!/[А-Яа-яЁё]/u.test(help), 'no Russian leaks into an English help screen')
})

test('an English bot answers commands with English copy', async () => {
  const env = world({ locale: 'en' })
  await env.router.handleMessage(message(CHAT, 'correct-horse'))

  await env.router.handleMessage(message(CHAT, '/status'))
  const status = env.bot.lastTo(CHAT)
  assert.match(status, /session: none/)
  assert.match(status, /workspaces: 1, sessions: 2, running: 0/)
  assert.match(status, /plugin 0\.1\.0/)
  assert.ok(!/[А-Яа-яЁё]/u.test(status), 'no Russian leaks into an English status screen')

  // The authorization line lives on /whoami, not on /status.
  await env.router.handleMessage(message(CHAT, '/whoami'))
  assert.match(env.bot.lastTo(CHAT), /binding: yes/)

  await env.router.handleMessage(message(CHAT, '/limit'))
  assert.match(env.bot.lastTo(CHAT), /Format: \/limit 3\|5\|10\|15\. Currently: 5\./)

  await env.router.handleMessage(message(CHAT, '/limit 10'))
  assert.match(env.bot.lastTo(CHAT), /Chats per folder: 10\./)

  await env.router.handleMessage(message(CHAT, '/sort activity'))
  assert.match(env.bot.lastTo(CHAT), /Folder order: by activity\./)

  await env.router.handleMessage(message(CHAT, '/notify off'))
  assert.match(env.bot.lastTo(CHAT), /Notifications: off\./)

  await env.router.handleMessage(message(CHAT, '/nonsense'))
  assert.match(env.bot.lastTo(CHAT), /I do not know the command \/nonsense\. Try \/help/)

  await env.router.handleMessage(message(CHAT, 'x'.repeat(8001)))
  assert.match(env.bot.lastTo(CHAT), /Too long: 8001 characters, 8000 maximum\./)
})

test('an English bot sends English notifications and toasts', async () => {
  const env = world({ locale: 'en' })
  await env.router.handleMessage(message(CHAT, 'correct-horse'))

  await env.router.notifyIdle('session-1', 71)
  assert.match(env.bot.lastTo(CHAT), /^✅ Auth fix · 1 min 11 s$/)

  await env.router.notifyError('session-1', 'the tool failed')
  assert.match(env.bot.lastTo(CHAT), /^⚠️ Auth fix: the tool failed$/)

  // A stale button answers with a toast, not a screen.
  await env.router.handleCallback(callback(CHAT, 'zz:not-a-route'))
  assert.equal(env.bot.answers.at(-1).text, 'This button is stale')
})

test('the settings screen toggles in English and applies on tap', async () => {
  const env = world({ locale: 'en' })
  await env.router.handleMessage(message(CHAT, 'correct-horse'))

  await env.router.handleCallback(callback(CHAT, CB.settings))
  assert.match(env.bot.lastTo(CHAT), /⚙️ Settings/)
  assert.match(env.bot.lastTo(CHAT), /Notifications: on/)

  // The real builder, not a hand-written payload: a made-up callback would only prove that
  // the parser rejects what production never sends.
  await env.router.handleCallback(callback(CHAT, cbNotify(false)))
  assert.equal(env.bot.answers.at(-1).text, 'Notifications off')
  assert.equal(env.state.notifyEnabled(CHAT), false)
  assert.match(env.bot.lastTo(CHAT), /Notifications: off/)
})

test('an unknown locale leaves the bot speaking the default language', async () => {
  // The failure mode worth guarding: a typo in the config must not produce a bot that answers
  // in keys, nor one that refuses to answer at all.
  const env = world({ locale: 'klingon' })
  await env.router.handleMessage(message(CHAT, 'correct-horse'))
  assert.ok(env.bot.textsTo(CHAT).includes('✅ Чат привязан.'))

  await env.router.handleMessage(message(CHAT, '/menu'))
  assert.match(env.bot.lastTo(CHAT), /Куда идём\?/)
})

test('no locale is configured at all', async () => {
  const env = world({})
  await env.router.handleMessage(message(CHAT, 'correct-horse'))
  assert.ok(env.bot.textsTo(CHAT).includes('✅ Чат привязан.'))
})
