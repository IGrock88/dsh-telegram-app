/**
 * The screens of §5: exact text, the buttons that must be there, and the
 * platform budgets of §10.
 *
 * The texts are asserted literally on purpose. They are UI copy the owner reads
 * on a phone, so "the test still passes after the wording drifted" is not a
 * property worth having.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { MAX_BUTTONS_PER_MESSAGE, MAX_BUTTON_TEXT, callbackFits, countButtons } from '../lib/format.mjs'
import { CB, cbSession, cbWorkspace, parseCallback } from '../lib/markup.mjs'
import { cbNewFor, confirm, currentChatLine, plural, renderChats, renderMenu, renderSession, renderSettings, renderWorkspaces, sessionTitle, stateMark, workspaceTitle } from '../lib/screens.mjs'
import { DEFAULT_SETTINGS } from '../lib/state.mjs'
import { summary, tempDir, workspace } from './fixtures.mjs'

/** Two real directories, for realistic folder rows. */
function folders() {
  const root = tempDir()
  const alpha = path.join(root, 'dsh-telegram-app')
  const beta = path.join(root, 'sandbox')
  fs.mkdirSync(alpha)
  fs.mkdirSync(beta)
  return { alpha, beta }
}

/** Every button label of a keyboard, flattened. */
function labels(keyboard) {
  return (keyboard ?? []).flat().map((entry) => entry.text)
}

/** Every callback payload of a keyboard, flattened. */
function payloads(keyboard) {
  return (keyboard ?? []).flat().map((entry) => entry.callback_data)
}

const NOW = 1_700_000_000_000

test('workspaceTitle falls back to the last path segment', () => {
  assert.equal(workspaceTitle({ title: ' dsh-telegram-app ' }), 'dsh-telegram-app')
  assert.equal(workspaceTitle({ title: '', path: 'W:\\harness\\default' }), 'default')
  assert.equal(workspaceTitle({ title: '', path: '/home/user/work' }), 'work')
  assert.equal(workspaceTitle({}), 'папка')
})

test('sessionTitle prefers the session title and falls back to folder · id8', () => {
  assert.equal(sessionTitle({ sessionId: 'session-1234567890', title: 'Фикс авторизации' }), 'Фикс авторизации')
  assert.equal(sessionTitle({ sessionId: 'session-1234567890' }, { folderTitle: 'default' }), 'default · session-')
  assert.equal(sessionTitle({ sessionId: 'abcdefghijkl' }), 'abcdefgh…kl')
})

test('sessionTitle cuts at 48 characters', () => {
  const long = 'x'.repeat(80)
  assert.equal([...sessionTitle({ sessionId: 's', title: long })].length, 48)
})

test('stateMark distinguishes running from waiting', () => {
  assert.equal(stateMark({ running: true }), '🟢')
  assert.equal(stateMark({ running: false }), '⚪')
  assert.equal(stateMark(null), '⚪')
})

test('currentChatLine names the binding only when there is one', () => {
  assert.equal(currentChatLine({ sessionId: 's' }, 'Фикс'), 'текущий чат: Фикс')
  // `undefined`, not an empty string: the line must vanish without leaving a gap.
  assert.equal(currentChatLine(null, 'Фикс'), undefined)
})

test('plural agrees with the count', () => {
  assert.equal(plural(1, 'сессия', 'сессии', 'сессий'), 'сессия')
  assert.equal(plural(3, 'сессия', 'сессии', 'сессий'), 'сессии')
  assert.equal(plural(12, 'сессия', 'сессии', 'сессий'), 'сессий')
  assert.equal(plural(0, 'сессия', 'сессии', 'сессий'), 'сессий')
})

test('L0 shows the dependency-free menu with two entries', () => {
  const screen = renderMenu({ pairedAt: NOW - 2 * 24 * 60 * 60 * 1000, notify: true, runningCount: 1, now: NOW })
  assert.equal(screen.text, '🏠 DSH\n\nЧат привязан: 2 дн · уведомления: вкл\nСессий в работе: 1\n\nКуда идём?')
  assert.deepEqual(labels(screen.keyboard), ['📁 Воркспейсы', '⚙️ Настройки'])
  assert.deepEqual(payloads(screen.keyboard), [CB.workspaces, CB.settings])
})

test('L0 reflects a muted chat', () => {
  const screen = renderMenu({ pairedAt: NOW, notify: false, runningCount: 0, now: NOW })
  assert.match(screen.text, /уведомления: выкл/)
  assert.match(screen.text, /Сессий в работе: 0/)
})

test('S marks the active value with a bullet and applies on tap', () => {
  const screen = renderSettings({ settings: { sessionLimit: 10, workspaceSort: 'activity', notify: false } })
  assert.match(screen.text, /Сколько чатов показывать в папке: 10/)
  assert.match(screen.text, /Сортировка папок: по активности/)
  assert.match(screen.text, /Уведомления: выкл/)

  const row = labels(screen.keyboard)
  assert.deepEqual(row.slice(0, 4), ['3', '5', '• 10', '15'])
  assert.deepEqual(row.slice(4, 6), ['Как в сайдбаре', '• По активности'])
  assert.deepEqual(row.slice(6, 8), ['Вкл', '• Выкл'])
  assert.deepEqual(row.slice(8), ['⬅️ Меню'])
  // No Save button exists: every value is applied by the tap itself (§5).
  assert.equal(row.some((label) => /Сохранить|Save/u.test(label)), false)
})

test('S keeps every row inside the callback budget', () => {
  for (const payload of payloads(renderSettings({ settings: DEFAULT_SETTINGS }).keyboard)) {
    assert.equal(callbackFits(payload), true, `${payload} must fit`)
  }
})

test('L1 lists folders with counts, activity and a drawn current chat', () => {
  const { alpha, beta } = folders()
  const screen = renderWorkspaces({
    workspaces: [
      { ...workspace('w1', alpha, 'dsh-telegram-app'), sessionCount: 3, lastActivityAt: NOW - 2 * 60 * 60 * 1000 },
      { ...workspace('w2', beta, 'sandbox'), sessionCount: 1, lastActivityAt: NOW - 3 * 24 * 60 * 60 * 1000 },
    ],
    binding: { sessionId: 'session-1' },
    bindingTitle: 'Фикс авторизации',
    now: NOW,
  })
  assert.equal(
    screen.text,
    '📁 Воркспейсы (2)\n'
    + '\n'
    + 'dsh-telegram-app · 3 сессии · 2 ч назад\n'
    + 'sandbox · 1 сессия · 3 дн назад\n'
    + '\n'
    + 'текущий чат: Фикс авторизации',
  )
  assert.deepEqual(labels(screen.keyboard), [
    '📁 dsh-telegram-app · 3',
    '📁 sandbox · 1',
    '🔄 Обновить', '⚙️ Настройки', '🏠 Меню',
  ])
})

test('L1 omits the current-chat line when nothing is bound', () => {
  const { alpha } = folders()
  const screen = renderWorkspaces({ workspaces: [{ ...workspace('w1', alpha, 'a'), sessionCount: 1, lastActivityAt: NOW }], now: NOW })
  assert.equal(screen.text.includes('текущий чат'), false)
})

test('L1 with no folders says so and offers only the menu', () => {
  const screen = renderWorkspaces({ workspaces: [], now: NOW })
  assert.equal(screen.text, '📁 Воркспейсы\n\nНет папок с сессиями.')
  assert.deepEqual(labels(screen.keyboard), ['🏠 Меню'])
})

test('L2 shows the folder path, the cut and one row per session', () => {
  const { alpha } = folders()
  const screen = renderChats({
    workspace: workspace('w1', alpha, 'dsh-telegram-app'),
    sessions: [
      { sessionId: 'session-1', title: 'Фикс авторизации', running: true, updatedAt: NOW - 12 * 60 * 1000 },
      { sessionId: 'session-2', title: 'Спецификация слоя 1', running: false, updatedAt: NOW - 2 * 60 * 60 * 1000 },
    ],
    total: 9,
    limit: 5,
    binding: { sessionId: 'session-1', workspaceId: 'w1' },
    bindingTitle: 'Фикс авторизации',
    bindingSessionId: 'session-1',
    now: NOW,
  })
  assert.equal(
    screen.text,
    `📁 dsh-telegram-app · ${alpha}\n`
    + 'Последние 2 из 9\n'
    + '\n'
    + '1. 🟢 📌 Фикс авторизации · 12 мин\n'
    + '2. ⚪ Спецификация слоя 1 · 2 ч\n'
    + '\n'
    + 'текущий чат: Фикс авторизации',
  )
  assert.deepEqual(labels(screen.keyboard), [
    '1. 🟢 Фикс авторизации', '2. ⚪ Спецификация слоя 1',
    '➕ Новая в этой папке', '🔄 Обновить',
    '⬅️ Воркспейсы', '⚙️ Настройки', '🏠 Меню',
  ])
})

test('L2 marks a bot-created session with 📱', () => {
  const { alpha } = folders()
  const screen = renderChats({
    workspace: workspace('w1', alpha, 'a'),
    sessions: [{ sessionId: 'session-1', title: 'Из бота', running: false, updatedAt: NOW }],
    total: 1,
    limit: 5,
    state: { isCreatedByBot: (id) => id === 'session-1' },
    now: NOW,
  })
  assert.match(screen.text, /1\. ⚪ Из бота 📱 · только что/)
})

test('L2 header counts what is actually shown', () => {
  const { alpha } = folders()
  const three = ['a', 'b', 'c'].map((id, index) => ({ sessionId: id, title: id, running: false, updatedAt: NOW - index * 1000 }))
  const screen = renderChats({ workspace: workspace('w1', alpha, 'a'), sessions: three, total: 3, limit: 5, now: NOW })
  assert.match(screen.text, /Последние 3 из 3/)
})

test('L2 with an empty folder still offers ➕ New', () => {
  const { alpha } = folders()
  const screen = renderChats({ workspace: workspace('w1', alpha, 'a'), sessions: [], total: 0, limit: 5, now: NOW })
  assert.match(screen.text, /В этой папке нет чатов\./)
  assert.equal(labels(screen.keyboard).includes('➕ Новая в этой папке'), true)
})

test('L2 keeps a 15-row list inside the per-message button budget', () => {
  const { alpha } = folders()
  const many = Array.from({ length: 15 }, (unused, index) => ({
    sessionId: `session-${index}`,
    title: `Чат ${index}`,
    running: false,
    updatedAt: NOW - index * 1000,
  }))
  const screen = renderChats({ workspace: workspace('w1', alpha, 'a'), sessions: many, total: 15, limit: 15, now: NOW })
  assert.ok(countButtons(screen.keyboard) <= MAX_BUTTONS_PER_MESSAGE, `got ${countButtons(screen.keyboard)} buttons`)
  // The navigation row is the one that must survive the trim.
  assert.equal(labels(screen.keyboard).includes('🏠 Меню'), true)
  assert.equal(labels(screen.keyboard).includes('⬅️ Воркспейсы'), true)
  for (const label of labels(screen.keyboard)) assert.ok([...label].length <= MAX_BUTTON_TEXT)
  for (const payload of payloads(screen.keyboard)) assert.equal(callbackFits(payload), true)
})

test('L3 draws the card with the state, the id and the last answer', () => {
  const screen = renderSession({
    session: { sessionId: 'session-6f1c2d3e4f5a6b7c8d9e', title: 'Фикс авторизации', running: false, updatedAt: NOW - 12 * 60 * 1000 },
    folderTitle: 'dsh-telegram-app',
    workspaceId: 'w1',
    lastAnswer: 'Готово: тест прошёл.',
    now: NOW,
  })
  assert.equal(
    screen.text,
    '📌 Фикс авторизации\n'
    + 'id: session-…9e · папка: dsh-telegram-app\n'
    + 'состояние: ⚪ ожидает ввода · обновлено: 12 мин назад\n'
    + 'последний ответ: «Готово: тест прошёл.»\n'
    + '\n'
    + 'Пиши текстом — уйдёт в этот чат.',
  )
  assert.deepEqual(labels(screen.keyboard), [
    '⏹ Стоп', '📄 Последние 5', '🔄 Обновить',
    '⬅️ К чатам', '⚙️ Настройки', '🏠 Меню',
  ])
  assert.deepEqual(payloads(screen.keyboard), [
    CB.stop, CB.lastFive, CB.refreshSession,
    cbWorkspace('w1'), CB.settings, CB.menu,
  ])
})

test('L3 marks a running turn and cuts the answer preview to 200 characters', () => {
  const long = 'a'.repeat(500)
  const screen = renderSession({
    session: { sessionId: 'session-1', title: 'Долгий ход', running: true, updatedAt: NOW },
    folderTitle: 'f',
    lastAnswer: long,
    now: NOW,
  })
  assert.match(screen.text, /состояние: 🟢 выполняется/)
  const answer = /последний ответ: «(.+)»/u.exec(screen.text)[1]
  assert.equal([...answer].length, 200)
})

test('L3 without an answer still renders the line', () => {
  const screen = renderSession({
    session: { sessionId: 'session-1', title: 'Новый', running: false, updatedAt: NOW },
    folderTitle: 'f',
    lastAnswer: null,
    now: NOW,
  })
  assert.match(screen.text, /последний ответ: —/)
})

test('L3 for a vanished session offers the way back instead of a dead end', () => {
  const screen = renderSession({ session: null, stale: true })
  assert.match(screen.text, /Сессия недоступна/)
  assert.match(screen.text, /Привязка снята/)
  assert.deepEqual(labels(screen.keyboard), ['📁 Воркспейсы', '🏠 Меню'])
})

test('confirm carries no keyboard, so a plain answer is a plain answer', () => {
  const screen = confirm('Готово')
  assert.equal(screen.text, 'Готово')
  assert.equal(screen.keyboard, undefined)
})

test('the ➕ New payload round-trips through the callback parser', () => {
  const { alpha } = folders()
  const payload = cbNewFor(workspace('w1', alpha, 'a'))
  assert.equal(payload, 'n:w1')
  // This assertion used to demand `{ kind: 'unknown' }` with the note "routed separately",
  // which described an intention rather than the code: nothing handled the prefix, so every
  // press of this button answered "кнопка устарела". A test that pins a bug as a design is
  // worse than no test, because it argues against the fix.
  assert.deepEqual(parseCallback(payload), { kind: 'newInFolder', workspaceId: 'w1' })
})

test('the legacy n:t toggle still wins over the n: folder prefix', () => {
  // Both payloads start with `n:`, so the order of the checks decides. `n:t` is the older
  // notification toggle and must keep working; only a longer `n:<id>` is a folder.
  assert.deepEqual(parseCallback('n:t'), { kind: 'toggleNotify' })
  assert.deepEqual(parseCallback('n:'), { kind: 'unknown' }, 'an empty folder id is not a route')
})

test('every payload the screens emit is understood by the parser', () => {
  // The class behind the "кнопка устарела" bug: a renderer can emit a prefix the parser does
  // not know, and nothing notices until someone taps it on a phone. This walks the buttons of
  // the screens themselves, so a future button with an unroutable prefix fails here instead.
  const { alpha, beta } = folders()
  const screens = [
    renderMenu({ pairedAt: 0, notify: true, runningCount: 0, sessionCount: 1, workspaceCount: 1 }),
    renderSettings({ settings: { sessionLimit: 5, workspaceSort: 'registry', notify: true } }),
    renderWorkspaces({ workspaces: [{ id: 'w1', title: 'a', path: alpha, sessionCount: 1 }] }),
    renderChats({
      workspace: { id: 'w1', title: 'a', path: alpha },
      sessions: [{ sessionId: 'session-1', title: 't', running: false, updatedAt: 1 }],
      total: 1,
      limit: 5,
    }),
    renderSession({ session: { sessionId: 'session-1', title: 't', running: false }, folder: { id: 'w1', title: 'a', path: beta } }),
  ]
  const unroutable = []
  for (const screen of screens) {
    for (const buttonRow of screen.keyboard ?? []) {
      for (const entry of buttonRow) {
        if (parseCallback(entry.callback_data).kind === 'unknown') unroutable.push(entry.callback_data)
      }
    }
  }
  assert.deepEqual(unroutable, [], 'no screen may emit a payload the parser cannot route')
})

test('a session callback stays inside 64 bytes for a real Harness id', () => {
  const payload = cbSession('session-58b80b9b-1bc5-495d-9626-4270b477a8b9')
  assert.equal(callbackFits(payload), true)
  assert.deepEqual(parseCallback(payload), { kind: 'session', sessionId: 'session-58b80b9b-1bc5-495d-9626-4270b477a8b9' })
})

test('a callback payload built from a long id is refused rather than truncated', () => {
  const screen = renderChats({
    workspace: workspace('w1', tempDir(), 'a'),
    sessions: [{ sessionId: `session-${'x'.repeat(80)}`, title: 'Очень длинный id', running: false, updatedAt: NOW }],
    total: 1,
    limit: 5,
    now: NOW,
  })
  // The button is dropped, and the rest of the screen is still usable.
  assert.equal(payloads(screen.keyboard).some((value) => value.startsWith('c:')), false)
  assert.equal(labels(screen.keyboard).includes('🏠 Меню'), true)
})
