/**
 * The chat router: pairing, commands, callbacks, permissions and degradation.
 *
 * The block below walks the acceptance checklist of §13 in order, because that
 * list is what the owner will actually exercise by hand on a phone. The rest
 * covers the refusals — a stranger, a group chat, a stale button — which are the
 * paths a manual pass is least likely to reach.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { ASK_FOR_TOKEN, COMMANDS, MAX_PROMPT_LENGTH, PAIR_MAX_FAILURES, createRouter, parseCommand } from '../lib/chat.mjs'
import { MAX_HISTORY_LINE } from '../lib/format.mjs'
import { CB, cbLimit, cbNotify, cbSession, cbSort, cbWorkspace, parseCallback } from '../lib/markup.mjs'
import { cbNewFor } from '../lib/screens.mjs'
import { createSessionApi } from '../lib/sessions.mjs'
import { StateStore } from '../lib/state.mjs'
import { callback, fakeBot, fakeLogger, fakeRegistry, fakeSessions, message, summary, tempDir, workspace } from './fixtures.mjs'

const CHAT = 424242

/** Two real folders plus a populated registry, all inside one temp root. */
function world(options = {}) {
  const root = tempDir()
  const alpha = path.join(root, 'dsh-telegram-app')
  const beta = path.join(root, 'sandbox')
  fs.mkdirSync(alpha)
  fs.mkdirSync(beta)

  const now = options.now ?? 1_700_000_000_000
  const summaries = options.summaries ?? [
    summary('session-1', { cwd: alpha, title: 'Фикс авторизации', updatedAt: now - 12 * 60 * 1000 }),
    summary('session-2', { cwd: alpha, title: 'Спецификация слоя 1', updatedAt: now - 2 * 60 * 60 * 1000 }),
    summary('session-3', { cwd: beta, title: 'Песочница', updatedAt: now - 3 * 24 * 60 * 60 * 1000 }),
  ]
  const workspaces = options.workspaces ?? [workspace('w-alpha', alpha, 'dsh-telegram-app'), workspace('w-beta', beta, 'sandbox')]
  const archived = options.archived ?? []

  const file = options.stateFile ?? path.join(root, 'state.json')
  const state = new StateStore({ file, logger: fakeLogger() })
  if (options.stateFile === undefined) {
    state.load()
    state.setControlToken(options.controlToken ?? 'correct-horse')
  }

  const bot = fakeBot(options.bot)
  const rawSessions = fakeSessions({ summaries, history: options.history, onCreate: options.onCreate })
  // Wrap it exactly as `index.js` does. The chat layer only ever sees `createSessionApi`,
  // which is what supplies the signal `prompt` requires; handing it the raw controller
  // would exercise a call pattern the Host never performs, and that is precisely how the
  // missing-signal bug stayed invisible here.
  const sessions = createSessionApi({ get: (name) => (name === 'sessionController' ? rawSessions : undefined) }, { logger: fakeLogger() })
  const registry = fakeRegistry({ workspaces, archived })
  const logger = fakeLogger()
  const router = createRouter({ config: options.config ?? {}, state, bot, sessions, registry, logger, now: () => now })

  return { root, alpha, beta, workspaces, summaries, state, bot, sessions, rawSessions, router, logger, file, now }
}

/** Pair the default chat, as a successful token message would. */
async function pair(env) {
  return env.router.handleMessage(message(CHAT, 'correct-horse'))
}

// ── §13 acceptance checklist ────────────────────────────────────────────────

test('§13.1 an unauthorized chat gets /whoami but only a token prompt for text', async () => {
  const env = world()
  // A stranger‘s `/whoami` is answered: it is the one command that tells them who
  // they are and what to do next, and it needs no authorization (§6).
  assert.equal(await env.router.handleMessage(message(CHAT, '/whoami')), 'whoami')
  assert.match(env.bot.lastTo(CHAT), /привязка: нет/)
  assert.match(env.bot.lastTo(CHAT), /Пришли контрольный токен/)

  // Each attempt below uses its own chat, because the prompt itself is
  // rate-limited per chat — asserted separately in the throttling block.
  assert.equal(await env.router.handleMessage(message(1001, '/stop')), 'unpaired-command')
  assert.equal(env.bot.lastTo(1001), ASK_FOR_TOKEN)
  assert.equal(await env.router.handleMessage(message(1002, '/status')), 'unpaired-command')
  assert.equal(env.bot.lastTo(1002), ASK_FOR_TOKEN)

  // Text that is not a command is a pairing attempt: it is counted, not
  // throttled, because the token itself is the thing being tested.
  assert.equal(await env.router.handleMessage(message(1003, 'привет, сделай задачу')), 'pair-refused')
  assert.equal(env.bot.lastTo(1003), 'Неверный токен.')
  assert.equal(env.rawSessions.calls.prompt.length, 0, '§11: a stranger cannot reach a Session')
})

test('§13.2 the right token pairs and opens L0; the wrong one refuses', async () => {
  const env = world()
  assert.equal(await pair(env), 'paired')
  assert.equal(env.state.hasChat(CHAT), true)

  const texts = env.bot.textsTo(CHAT)
  // The pairing sequence ends with the menu; before it come the confirmation and the note
  // that installs the persistent keyboard (sent as its own message, because Telegram
  // accepts one `reply_markup` per message and screens need theirs for buttons).
  assert.equal(texts.at(-3), '✅ Чат привязан.')
  assert.match(texts.at(-2), /Кнопка «Меню»/)
  // The menu reports both the turns in flight and what the bot can actually reach, so a
  // lonely "0" cannot be read as "you have no sessions".
  assert.equal(
    texts.at(-1),
    '🏠 DSH\n\nЧат привязан: только что · уведомления: вкл\nСессий в работе: 0 · доступно: 3 сессии в 2 воркспейсах\n\nКуда идём?',
  )

  // And the menu must actually carry its buttons: a screen without them is a message the
  // owner can only stare at, which is exactly the bug this guards against.
  const keyboard = env.bot.lastKeyboard(CHAT)
  assert.notEqual(keyboard, null, 'the menu arrives with an inline keyboard')
  const data = keyboard.flat().map((entry) => entry.callback_data)
  assert.ok(data.includes('wl'), 'the workspaces button is reachable')
  assert.ok(data.includes('st'), 'the settings button is reachable')
})

test('§13.2 five wrong attempts pause the chat for 15 minutes', async () => {
  const env = world()
  for (let attempt = 1; attempt < PAIR_MAX_FAILURES; attempt += 1) {
    await env.router.handleMessage(message(CHAT, `wrong-${attempt}`))
  }
  assert.equal(env.state.hasChat(CHAT), false)

  assert.equal(await env.router.handleMessage(message(CHAT, 'wrong-5')), 'pair-refused')
  assert.match(env.bot.lastTo(CHAT), /приостановлена на 15 минут/)

  // The pause holds even for the correct token.
  assert.equal(await env.router.handleMessage(message(CHAT, 'correct-horse')), 'pair-paused')
  assert.equal(env.state.hasChat(CHAT), false)
})

test('§13.3 L0 offers the two entries and the reply button returns to it', async () => {
  const env = world()
  await pair(env)
  await env.router.handleMessage(message(CHAT, '/menu'))
  const labels = (env.bot.lastKeyboard(CHAT) ?? []).flat().map((entry) => entry.text)
  assert.deepEqual(labels, ['📁 Воркспейсы', '⚙️ Настройки'])

  await env.router.handleMessage(message(CHAT, '/chats'))
  assert.equal(await env.router.handleMessage(message(CHAT, '🏠 Меню')), 'menu')
  assert.match(env.bot.lastTo(CHAT), /^🏠 DSH/)
})

test('§13.4 L1 shows only folders with suitable sessions, in registry order', async () => {
  const env = world()
  await pair(env)
  await env.router.handleMessage(message(CHAT, '/chats'))

  const text = env.bot.lastTo(CHAT)
  assert.match(text, /^📁 Воркспейсы \(2\)/)
  assert.match(text, /dsh-telegram-app · 2 сессии · 12 мин назад/)
  assert.match(text, /sandbox · 1 сессия · 3 дн назад/)
  assert.ok(text.indexOf('dsh-telegram-app') < text.indexOf('sandbox'), 'registry order is kept')
})

test('§13.5 L2 shows N sessions of the folder, newest first, with ➕, ⚙️ and ⬅️', async () => {
  const env = world()
  await pair(env)
  await env.router.handleMessage(message(CHAT, '/chats 1'))

  const text = env.bot.lastTo(CHAT)
  assert.match(text, /Последние 2 из 2/)
  assert.match(text, /1\. ⚪ Фикс авторизации · 12 мин/)
  assert.match(text, /2\. ⚪ Спецификация слоя 1 · 2 ч/)
  const labels = (env.bot.lastKeyboard(CHAT) ?? []).flat().map((entry) => entry.text)
  assert.deepEqual(labels, [
    '1. ⚪ Фикс авторизации', '2. ⚪ Спецификация слоя 1',
    '➕ Новая в этой папке', '🔄 Обновить',
    '⬅️ Воркспейсы', '⚙️ Настройки', '🏠 Меню',
  ])
})

test('§13.6 tapping a session binds it and plain text becomes its prompt', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.handleCallback(callback(CHAT, cbSession('session-2'))), 'cb-session')
  assert.equal(env.state.boundSessionId(CHAT), 'session-2')

  assert.equal(await env.router.handleMessage(message(CHAT, 'добавь тест на отказ')), 'prompted')
  assert.equal(env.rawSessions.calls.prompt.length, 1, 'exactly one prompt reached the controller')
  const [sent] = env.rawSessions.calls.prompt
  assert.equal(sent.sessionId, 'session-2')
  assert.equal(sent.text, 'добавь тест на отказ')
  assert.equal(sent.request.mode, 'queue', 'a plain message is queued, not steered')
  assert.match(sent.request.requestId, /^tg-/)
  assert.equal(env.bot.lastTo(CHAT), '→ отправлено в «Спецификация слоя 1»')
})

test('§13.6 a prompt into a running session is announced as queued', async () => {
  const root = tempDir()
  const env = world({
    summaries: [summary('session-1', { cwd: root, title: 'Занят', running: true, updatedAt: 1 })],
    workspaces: [workspace('w1', root, 'tmp')],
  })
  await pair(env)
  env.state.bindSession(CHAT, 'session-1')
  assert.equal(await env.router.handleMessage(message(CHAT, 'ещё одну правку')), 'prompted')
  assert.equal(env.bot.lastTo(CHAT), '→ отправлено в «Занят» (в очередь)')
})

test('§13.6 the tail of a session is readable with /last', async () => {
  const env = world({
    history: {
      'session-1': {
        records: [
          { event: { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'сделай X' }] } } } },
          { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'сделал X' }] } } } },
          { event: { type: 'tool/call', data: { name: 'bash' } } },
        ],
      },
    },
  })
  await pair(env)
  env.state.bindSession(CHAT, 'session-1')
  assert.equal(await env.router.handleMessage(message(CHAT, '/last 5')), 'last')
  assert.equal(env.bot.lastTo(CHAT), '👤 сделай X\n\n🤖 сделал X')
})

test('§13.7 stop cancels a running turn and reports the admission', async () => {
  const root = tempDir()
  const env = world({
    summaries: [summary('session-1', { cwd: root, title: 'Занят', running: true, updatedAt: 1 })],
    workspaces: [workspace('w1', root, 'tmp')],
  })
  await pair(env)
  env.state.bindSession(CHAT, 'session-1')

  assert.equal(await env.router.handleMessage(message(CHAT, '/stop')), 'stopped')
  assert.deepEqual(env.rawSessions.calls.cancel, ['session-1'])
  assert.equal(env.bot.lastTo(CHAT), '⏹ Отмена отправлена')
})

test('§13.7 stop on an idle session says nothing is running', async () => {
  const env = world()
  await pair(env)
  env.state.bindSession(CHAT, 'session-1')
  assert.equal(await env.router.handleMessage(message(CHAT, '/stop')), 'stop-idle')
  assert.equal(env.bot.lastTo(CHAT), 'Сейчас ничего не выполняется.')
  assert.deepEqual(env.rawSessions.calls.cancel, [])
})

test('§13.8 subagents, blanks and archived sessions never appear in a list', async () => {
  const root = tempDir()
  const alpha = path.join(root, 'alpha')
  fs.mkdirSync(alpha)
  const env = world({
    workspaces: [workspace('w-alpha', alpha, 'alpha')],
    archived: ['session-archived'],
    summaries: [
      summary('session-ok', { cwd: alpha, title: 'Видимый', updatedAt: 5000 }),
      summary('session-sub', { cwd: alpha, title: 'Субагент', origin: 'subagent', parentSessionId: 'session-ok', updatedAt: 6000 }),
      summary('session-blank', { cwd: alpha, title: 'Пустышка', blank: true, updatedAt: 7000 }),
      summary('session-archived', { cwd: alpha, title: 'Архив', updatedAt: 8000 }),
    ],
  })
  await pair(env)
  await env.router.handleMessage(message(CHAT, '/chats 1'))

  const text = env.bot.lastTo(CHAT)
  assert.match(text, /Последние 1 из 1/)
  assert.match(text, /Видимый/)
  for (const hidden of ['Субагент', 'Пустышка', 'Архив']) {
    assert.equal(text.includes(hidden), false, `${hidden} must not be listed`)
  }
  const payloads = (env.bot.lastKeyboard(CHAT) ?? []).flat().map((entry) => entry.callback_data)
  assert.equal(payloads.includes(cbSession('session-sub')), false)
})

test('§13.9 a finished turn notifies the chat, and /notify off silences it', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.notifyIdle('session-1', 80), 'notified')
  assert.equal(env.bot.lastTo(CHAT), '✅ Фикс авторизации · 1 мин 20 с')
  const keyboard = (env.bot.lastKeyboard(CHAT) ?? []).flat()
  assert.deepEqual(keyboard.map((entry) => entry.text), ['📄 Последний ответ', '📌 Открыть'])

  assert.equal(await env.router.handleMessage(message(CHAT, '/notify off')), 'notify')
  assert.equal(await env.router.notifyIdle('session-1', 80), 'notify-muted')
  assert.equal(env.state.notifyEnabled(CHAT), false)
})

test('§13.9 a session the filters exclude is not announced', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.notifyIdle('session-unknown', 80), 'notify-skipped')
  assert.equal(await env.router.notifyIdle('session-2', 5), 'notified', 'a short turn is the caller‘s filter, not ours')
})

test('§13.10 an approval is decided by buttons from the chat', async () => {
  const env = world()
  await pair(env)
  let decided = null
  const nonce = 'abcd1234'
  env.router.pendingApprovals.set(nonce, { decide: (allow, chatId, messageId) => { decided = { allow, chatId, messageId } } })

  const keyboard = env.router.approvalKeyboard(nonce)
  assert.deepEqual(keyboard.flat().map((entry) => entry.callback_data), [`a:${nonce}:allow`, `a:${nonce}:deny`])
  assert.equal(await env.router.handleCallback(callback(CHAT, `a:${nonce}:allow`)), 'approval-answered')
  assert.deepEqual(decided, { allow: true, chatId: CHAT, messageId: 55 })
  assert.equal(env.bot.answers.at(-1).text, 'Разрешено')
})

test('§13.10 an approval press from an unpaired chat changes nothing', async () => {
  const env = world()
  const nonce = 'abcd1234'
  let called = false
  env.router.pendingApprovals.set(nonce, { decide: () => { called = true } })
  assert.equal(await env.router.handleCallback(callback(999, `a:${nonce}:allow`)), 'approval-denied')
  assert.equal(called, false)
  assert.equal(env.bot.answers.at(-1).text, 'Нет доступа')
})

test('§13.11 /unpair asks for confirmation and revokes on ✅', async () => {
  const env = world()
  await pair(env)
  env.state.bindSession(CHAT, 'session-1')

  assert.equal(await env.router.handleMessage(message(CHAT, '/unpair')), 'unpair-ask')
  assert.match(env.bot.lastTo(CHAT), /Отвязать этот чат/)
  assert.equal(env.state.hasChat(CHAT), true, 'asking is not revoking')

  assert.equal(await env.router.handleCallback(callback(CHAT, CB.unpairNo)), 'cb-unpair-cancelled')
  assert.equal(env.state.hasChat(CHAT), true)

  assert.equal(await env.router.handleCallback(callback(CHAT, CB.unpairYes)), 'cb-unpaired')
  assert.equal(env.state.hasChat(CHAT), false)
  assert.equal(env.state.boundSessionId(CHAT), null)
  assert.match(env.bot.lastTo(CHAT), /Чат отвязан/)

  // The chat is a stranger again, so text is treated as a pairing attempt.
  assert.equal(await env.router.handleMessage(message(CHAT, 'привет')), 'pair-refused')
})

test('§13.11 a group chat is ignored with a single hint', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.handleMessage(message(CHAT, 'привет', { type: 'group' })), 'non-private')
  assert.equal(env.bot.lastTo(CHAT), 'Я работаю только в личной переписке.')
  assert.equal(env.rawSessions.calls.prompt.length, 0)

  const before = env.bot.sent.length
  assert.equal(await env.router.handleMessage(message(CHAT, 'и ещё раз', { type: 'group' })), 'non-private')
  assert.equal(env.bot.sent.length, before, 'the hint is rate-limited, not repeated')
})

test('§13.12 [⚙️] on L1–L3 leads to S, and S returns to the menu', async () => {
  const env = world()
  await pair(env)

  // §2: `[⚙️]` sits beside the navigation row on every level below L0, so the
  // settings screen is always one tap away from a list that disappointed you.
  for (const from of [CB.workspaces, cbWorkspace('w-alpha'), cbSession('session-1')]) {
    const code = await env.router.handleCallback(callback(CHAT, from))
    assert.equal(code.startsWith('cb-'), true, `${from} answered ${code}`)
    const payloads = (env.bot.lastKeyboard(CHAT) ?? []).flat().map((entry) => entry.callback_data)
    assert.equal(payloads.includes(CB.settings), true, `no ⚙️ after ${from}`)
  }
  await env.router.handleCallback(callback(CHAT, CB.settings))
  assert.match(env.bot.lastTo(CHAT), /^⚙️ Настройки/)

  await env.router.handleCallback(callback(CHAT, CB.menu))
  assert.match(env.bot.lastTo(CHAT), /^🏠 DSH/)
})

test('§13.13 a settings tap applies at once and survives a restart', async () => {
  const env = world()
  await pair(env)

  assert.equal(await env.router.handleCallback(callback(CHAT, cbLimit(10))), 'cb-limit')
  assert.match(env.bot.lastTo(CHAT), /Сколько чатов показывать в папке: 10/)
  assert.equal(env.state.settings(CHAT).sessionLimit, 10)

  // `/limit 10` → ten rows on L2.
  const ten = Array.from({ length: 12 }, (unused, index) => summary(`session-${index}`, { cwd: env.alpha, title: `Чат ${index}`, updatedAt: env.now - index }))
  const env2 = world({
    summaries: ten,
    workspaces: [workspace('w-alpha', env.alpha, 'dsh-telegram-app')],
    stateFile: env.file,
  })
  env2.state.load()
  env2.state.pair({ userId: CHAT, chatId: CHAT })
  await env2.router.handleMessage(message(CHAT, '/chats 1'))
  assert.match(env2.bot.lastTo(CHAT), /Последние 10 из 12/)

  // `/sort activity` reorders the folders by freshness.
  const env3 = world()
  await pair(env3)
  await env3.router.handleMessage(message(CHAT, '/sort activity'))
  assert.equal(env3.state.settings(CHAT).workspaceSort, 'activity')
  await env3.router.handleMessage(message(CHAT, '/chats'))
  const text = env3.bot.lastTo(CHAT)
  assert.ok(text.indexOf('dsh-telegram-app') < text.indexOf('sandbox'), 'the fresher folder is first')
})

test('§13.13 a settings tap is applied to this chat only', async () => {
  const env = world()
  await pair(env)
  env.state.pair({ userId: 777, chatId: 777 })
  await env.router.handleCallback(callback(CHAT, cbLimit(3)))
  assert.equal(env.state.settings(CHAT).sessionLimit, 3)
  assert.equal(env.state.settings(777).sessionLimit, 5, 'the other chat keeps the default')
})

// ── §6 commands and §5 screens ──────────────────────────────────────────────

test('every /help line corresponds to a command that is actually routed', async () => {
  const env = world()
  await pair(env)
  const help = env.router.helpText()
  for (const [command] of COMMANDS) {
    if (command === 'menu') continue
    assert.equal(help.includes(`/${command} —`), true, `/help must document /${command}`)
  }
})

test('/status reports the four facts of §6', async () => {
  const env = world()
  await pair(env)
  env.state.bindSession(CHAT, 'session-1', { workspaceId: 'w-alpha' })
  await env.router.handleMessage(message(CHAT, '/status'))

  const text = env.bot.lastTo(CHAT)
  assert.match(text, new RegExp(`^🔐 чат: ${CHAT} \\(привязан: только что, уведомления: вкл\\)`, 'u'))
  // The fixture ids are short, so `shortId` leaves them whole; the ellipsis form
  // is covered by the format tests.
  assert.match(text, /📌 сессия: Фикс авторизации · session-1 · ⚪ ожидает ввода/)
  assert.match(text, /🧩 воркспейсов: 2, сессий: 3, выполняются: 0/)
  assert.match(text, /⚙️ бот: @dsh_test_bot · Harness — · плагин —/)
})

test('/use takes a number and an id prefix, and reports a miss', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.handleMessage(message(CHAT, '/use 1')), 'use')
  assert.equal(env.state.boundSessionId(CHAT), 'session-1')
  assert.equal(env.state.binding(CHAT).workspaceId, 'w-alpha')

  assert.equal(await env.router.handleMessage(message(CHAT, '/use session-2')), 'use')
  assert.equal(env.state.boundSessionId(CHAT), 'session-2')

  assert.equal(await env.router.handleMessage(message(CHAT, '/use 99')), 'use-missing')
  assert.match(env.bot.lastTo(CHAT), /Не нашёл чат «99»/)
  assert.equal(env.state.boundSessionId(CHAT), 'session-2', 'a miss leaves the binding alone')
})

test('/unbind drops the binding and shows L1', async () => {
  const env = world()
  await pair(env)
  env.state.bindSession(CHAT, 'session-1', { workspaceId: 'w-alpha' })
  assert.equal(await env.router.handleMessage(message(CHAT, '/unbind')), 'unbind')
  assert.equal(env.state.boundSessionId(CHAT), null)
  assert.match(env.bot.lastTo(CHAT), /^📁 Воркспейсы/)
})

test('/new creates inside the bound folder and marks the session', async () => {
  // A freshly created Session is listed by the controller straight away, so the
  // fake publishes it too — otherwise the card would report it as gone.
  const env = world({
    onCreate: (request, publish) => {
      publish(summary('session-fresh', { cwd: request.workspaceId === 'w-alpha' ? env.alpha : request.cwd, title: 'Новая', updatedAt: env.now + 1000 }))
      return { sessionId: 'session-fresh' }
    },
  })
  await pair(env)
  env.state.bindSession(CHAT, 'session-1', { workspaceId: 'w-alpha' })
  assert.equal(await env.router.handleMessage(message(CHAT, '/new')), 'new')
  assert.deepEqual(env.rawSessions.calls.create, [{ workspaceId: 'w-alpha' }])
  assert.equal(env.state.isCreatedByBot('session-fresh'), true)
  assert.equal(env.state.boundSessionId(CHAT), 'session-fresh')
  assert.equal(env.bot.textsTo(CHAT).includes('➕ Новая сессия в «dsh-telegram-app».'), true)
  assert.match(env.bot.lastTo(CHAT), /^📌 Новая/)
})

test('/new with an explicit path creates by directory when it is not a folder', async () => {
  const env = world({ onCreate: () => ({ sessionId: 'session-fresh' }) })
  await pair(env)
  const outside = tempDir()
  assert.equal(await env.router.handleMessage(message(CHAT, `/new ${outside}`)), 'new')
  assert.deepEqual(env.rawSessions.calls.create, [{ cwd: outside }])
})

test('/new with the path of a registered folder creates through its id', async () => {
  const env = world({ onCreate: () => ({ sessionId: 'session-fresh' }) })
  await pair(env)
  // §1: a Session created by `cwd` alone floats outside every folder, so a
  // registered path must go through `workspaceId` to land in the sidebar.
  assert.equal(await env.router.handleMessage(message(CHAT, `/new ${env.alpha}`)), 'new')
  assert.deepEqual(env.rawSessions.calls.create, [{ workspaceId: 'w-alpha' }])
})

test('/new without any folder and without a working directory says how to fix it', async () => {
  const env = world({ summaries: [], workspaces: [] })
  await pair(env)
  assert.equal(await env.router.handleMessage(message(CHAT, '/new')), 'new-failed')
  assert.match(env.bot.lastTo(CHAT), /Укажи путь: \/new/)
})

test('a text message without a binding asks for one instead of guessing', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.handleMessage(message(CHAT, 'сделай что-нибудь')), 'no-binding')
  assert.equal(env.bot.lastTo(CHAT), 'Сначала выбери чат.')
  const keyboard = (env.bot.lastKeyboard(CHAT) ?? []).flat()
  assert.deepEqual(keyboard.map((entry) => entry.callback_data), [CB.workspaces])
})

test('§2 text sent from L1 still reaches the bound session and names it', async () => {
  const env = world()
  await pair(env)
  env.state.bindSession(CHAT, 'session-2', { workspaceId: 'w-alpha' })
  await env.router.handleMessage(message(CHAT, '/chats'))
  assert.equal(await env.router.handleMessage(message(CHAT, 'и ещё правку')), 'prompted')
  assert.equal(env.rawSessions.calls.prompt[0].sessionId, 'session-2')
  assert.equal(env.bot.lastTo(CHAT), '→ отправлено в «Спецификация слоя 1»')
})

test('an empty or whitespace-only message is not an event', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.handleMessage(message(CHAT, '   ')), 'empty')
  assert.equal(await env.router.handleMessage(message(CHAT, '')), 'empty')
  assert.equal(await env.router.handleMessage({ chat: { id: CHAT, type: 'private' }, from: { id: CHAT } }), 'empty')
})

test('a message longer than the prompt limit is refused with a hint', async () => {
  const env = world()
  await pair(env)
  env.state.bindSession(CHAT, 'session-1')
  assert.equal(await env.router.handleMessage(message(CHAT, 'x'.repeat(MAX_PROMPT_LENGTH + 1))), 'too-long')
  assert.match(env.bot.lastTo(CHAT), /Слишком длинно/)
  assert.equal(env.rawSessions.calls.prompt.length, 0)
})

test('a message from another bot is ignored outright', async () => {
  const env = world()
  await pair(env)
  const fromBot = { ...message(CHAT, '/start'), from: { id: 9, is_bot: true } }
  assert.equal(await env.router.handleMessage(fromBot), 'ignored')
})

test('an unknown command is answered rather than swallowed', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.handleMessage(message(CHAT, '/nonsense')), 'unknown-command')
  assert.match(env.bot.lastTo(CHAT), /Не знаю команду \/nonsense/)
})

test('the legacy /pair and /panel commands answer instead of looking broken', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.handleMessage(message(CHAT, '/pair token')), 'legacy')
  assert.match(env.bot.lastTo(CHAT), /Привязка идёт сама/)
  assert.equal(await env.router.handleMessage(message(CHAT, '/panel')), 'legacy')
  assert.match(env.bot.lastTo(CHAT), /Панель Mini App пока выключена/)
})

test('/chats with a bad folder number says how many there are', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.handleMessage(message(CHAT, '/chats 9')), 'chats-bad-index')
  assert.match(env.bot.lastTo(CHAT), /Нет папки с номером 9\. Всего папок: 2\./)
})

test('/notify with a bad value shows the current state and the syntax', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.handleMessage(message(CHAT, '/notify maybe')), 'notify-hint')
  assert.match(env.bot.lastTo(CHAT), /Сейчас уведомления: вкл\. Формат: \/notify on\|off/)
})

test('/limit and /sort reject values outside the offered set', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.handleMessage(message(CHAT, '/limit 7')), 'limit-hint')
  assert.match(env.bot.lastTo(CHAT), /Формат: \/limit 3\|5\|10\|15/)
  assert.equal(env.router.handleMessage(message(CHAT, '/sort alphabetical')) instanceof Promise, true)
  assert.equal(await env.router.handleMessage(message(CHAT, '/sort alphabetical')), 'sort-hint')
  assert.equal(env.state.settings(CHAT).sessionLimit, 5)
  assert.equal(env.state.settings(CHAT).workspaceSort, 'registry')
})

// ── §7 callbacks ────────────────────────────────────────────────────────────

test('§7 the legacy n:t button flips notifications rather than looking stale', async () => {
  const env = world()
  await pair(env)
  assert.equal(env.state.notifyEnabled(CHAT), true)
  assert.equal(await env.router.handleCallback(callback(CHAT, 'n:t')), 'cb-toggle-notify')
  assert.equal(env.state.notifyEnabled(CHAT), false)
  assert.equal(env.bot.answers.at(-1).text, 'Уведомления выключены')
  assert.equal(await env.router.handleCallback(callback(CHAT, 'n:t')), 'cb-toggle-notify')
  assert.equal(env.state.notifyEnabled(CHAT), true)
})

test('§7 a callback from a non-paired chat answers "Нет доступа" and changes nothing', async () => {
  const env = world()
  assert.equal(await env.router.handleCallback(callback(999, CB.menu)), 'callback-denied')
  assert.equal(env.bot.answers.at(-1).text, 'Нет доступа')
  assert.equal(env.bot.sent.length, 0, 'the message is left untouched')
  assert.equal(env.bot.edits.length, 0)
})

test('§7 an unknown or stale callback is answered politely', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.handleCallback(callback(CHAT, 'zzz')), 'cb-unknown')
  assert.equal(env.bot.answers.at(-1).text, 'Кнопка устарела')
  assert.equal(await env.router.handleCallback(callback(CHAT, 'c:')), 'cb-unknown')
})

test('§7 a stale approval nonce is reported as no longer relevant', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.handleCallback(callback(CHAT, 'a:deadbeef:allow')), 'approval-stale')
  assert.equal(env.bot.answers.at(-1).text, 'Уже не актуально')
})

test('§7 a screen is edited in place, not posted again', async () => {
  const env = world()
  await pair(env)
  await env.router.handleCallback(callback(CHAT, CB.workspaces, { messageId: 77 }))
  assert.equal(env.bot.edits.length, 1)
  assert.equal(env.bot.edits[0].messageId, 77)
  assert.match(env.bot.screenText(77), /^📁 Воркспейсы/)
  // Nothing was posted for the screen itself; only the pairing messages came before.
  const sentAfterPairing = env.bot.sent.filter((entry) => entry.text.startsWith('📁')).length
  assert.equal(sentAfterPairing, 0)
})

test('§12 a deleted screen is re-sent instead of failing silently', async () => {
  const env = world({ bot: { editFails: true } })
  await pair(env)
  const before = env.bot.sent.length
  await env.router.handleCallback(callback(CHAT, CB.workspaces, { messageId: 77 }))
  assert.equal(env.bot.sent.length, before + 1, 'the edit was refused, so a fresh screen was sent')
  assert.match(env.bot.lastTo(CHAT), /^📁 Воркспейсы/)
})

test('§2 ⬅️ К чатам returns to the folder the bound session lives in', async () => {
  const env = world()
  await pair(env)
  await env.router.handleCallback(callback(CHAT, cbSession('session-3')))
  const keyboard = (env.bot.lastKeyboard(CHAT) ?? []).flat()
  const back = keyboard.find((entry) => entry.text === '⬅️ К чатам')
  assert.equal(back.callback_data, cbWorkspace('w-beta'))
  assert.equal(await env.router.handleCallback(callback(CHAT, back.callback_data)), 'cb-workspace')
  assert.match(env.bot.lastTo(CHAT), /Песочница/)
})

test('§8 📌 Открыть from a notification lands on that session', async () => {
  const env = world()
  await pair(env)
  await env.router.notifyIdle('session-2', 80)
  const open = (env.bot.lastKeyboard(CHAT) ?? []).flat().find((entry) => entry.text === '📌 Открыть')
  assert.equal(open.callback_data, cbSession('session-2'))
  await env.router.handleCallback(callback(CHAT, open.callback_data))
  assert.equal(env.state.boundSessionId(CHAT), 'session-2')
  assert.match(env.bot.lastTo(CHAT), /^📌 Спецификация слоя 1/)
})

test('📄 Последний ответ answers with the tail of the bound session', async () => {
  const env = world({
    history: {
      'session-1': { records: [{ event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'готово' }] } } } }] },
    },
  })
  await pair(env)
  env.state.bindSession(CHAT, 'session-1')
  assert.equal(await env.router.handleCallback(callback(CHAT, CB.lastFive)), 'cb-history')
  assert.equal(env.bot.lastTo(CHAT), '🤖 готово')
})

test('the session card preview shows the last assistant answer', async () => {
  const env = world({
    history: {
      'session-1': {
        records: [
          { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'первый ответ' }] } } } },
          { event: { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'ещё' }] } } } },
          { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'второй ответ' }] } } } },
        ],
      },
    },
  })
  await pair(env)
  await env.router.handleCallback(callback(CHAT, cbSession('session-1')))
  assert.match(env.bot.lastTo(CHAT), /последний ответ: «второй ответ»/)
})

test('a tool call is never shown as the answer', async () => {
  // The bug the owner hit: the preview rendered tool calls as "→ <tool>", so a turn that
  // ended with tool calls and no closing prose showed an itinerary of the agent's activity
  // — "→ shell → pwsh → edit" — where the answer should be. Tool calls carry no
  // user-facing text, so the last *prose* must win, even from an earlier message.
  const env = world({
    history: {
      'session-1': {
        records: [
          { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'вот что я сделал' }] } } } },
          {
            event: {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'tool-call', name: 'shell' }, { type: 'tool-call', name: 'pwsh' }] } },
            },
          },
        ],
      },
    },
  })
  await pair(env)

  // The preview on the session card.
  await env.router.handleCallback(callback(CHAT, cbSession('session-1')))
  const card = env.bot.lastTo(CHAT)
  assert.match(card, /последний ответ: «вот что я сделал»/)
  assert.doesNotMatch(card, /→ shell|→ pwsh/, 'tool calls are not an answer')

  // And the explicit request for the tail.
  assert.equal(await env.router.handleCallback(callback(CHAT, CB.lastFive)), 'cb-history')
  assert.equal(env.bot.lastTo(CHAT), '🤖 вот что я сделал')

  // A turn with nothing but tool calls has no answer to show at all, and that is said
  // plainly rather than filled with tool names.
  const silent = world({
    history: {
      'session-1': { records: [{ event: { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'shell' }] } } } }] },
    },
  })
  await pair(silent)
  silent.state.bindSession(CHAT, 'session-1')
  assert.equal(await silent.router.handleCallback(callback(CHAT, CB.lastFive)), 'cb-history')
  assert.doesNotMatch(silent.bot.lastTo(CHAT), /→ shell/)
})

test('a truncated answer says so instead of trailing off', async () => {
  // `cut` truncates silently, so a long answer looked like a broken one. The marker is the
  // difference between "the agent said this" and "the bridge stopped printing".
  const long = 'я'.repeat(MAX_HISTORY_LINE + 50)
  const env = world({
    history: {
      'session-1': { records: [{ event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: long }] } } } }] },
    },
  })
  await pair(env)
  env.state.bindSession(CHAT, 'session-1')
  await env.router.handleCallback(callback(CHAT, CB.lastFive))

  const shown = env.bot.lastTo(CHAT)
  assert.ok(shown.endsWith('…'), 'a cut answer ends with a marker')

  // A short answer must NOT get the marker, or it would lie in the other direction.
  const short = world({
    history: {
      'session-1': { records: [{ event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'коротко' }] } } } }] },
    },
  })
  await pair(short)
  short.state.bindSession(CHAT, 'session-1')
  await short.router.handleCallback(callback(CHAT, CB.lastFive))
  assert.equal(short.bot.lastTo(CHAT), '🤖 коротко')
})

test('a long realistic answer arrives whole, conclusion included', async () => {
  // The owner's complaint in one test: a normal-length answer lost its tail. The fixture is
  // deliberately longer than the old 400-character limit, or the test would pass under the
  // very limit it exists to rule out — an earlier version of this test made that mistake.
  const body = Array.from({ length: 40 }, (_, index) => `Строка ${index + 1}: пояснение к шагу.`).join('\n')
  const answer = `Разобрал причины.\n\n${body}\n\nКОНЕЦ ОТВЕТА`
  assert.ok(answer.length > 400, `the fixture must exceed the old limit; it is ${answer.length}`)

  const env = world({
    history: {
      'session-1': { records: [{ event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: answer }] } } } }] },
    },
  })
  await pair(env)
  env.state.bindSession(CHAT, 'session-1')
  await env.router.handleCallback(callback(CHAT, CB.lastFive))

  const shown = env.bot.lastTo(CHAT)
  assert.ok(shown.includes('КОНЕЦ ОТВЕТА'), 'the conclusion is present, not replaced by an ellipsis')
  assert.equal(shown.endsWith('…'), false, 'nothing was cut')
  // Paragraphs survive: an answer is content, and flattening it into one line destroys lists.
  assert.ok(shown.includes('\n'), 'line structure is kept')
  assert.ok(shown.includes('Строка 20'), 'the middle is not lost either')
})

test('➕ Новая в этой папке creates the Session in the folder the button names', async () => {
  // The owner's report: pressing this button answered "кнопка устарела". Two separate faults
  // were behind it — the parser had no branch for the `n:` prefix its own renderer emitted,
  // and the screen that followed dropped the binding because the new Session was not in the
  // list yet. This walks the whole path and asserts both halves.
  const env = world({
    // A controller that publishes the new Session, as the live one does.
    onCreate: (request, publish) => publish(summary('session-fresh', { cwd: env.beta, title: 'Новая' })),
  })
  await pair(env)

  await env.router.handleCallback(callback(CHAT, cbWorkspace('w-beta')))
  const pressed = await env.router.handleCallback(callback(CHAT, cbNewFor({ id: 'w-beta' })))
  assert.equal(pressed, 'cb-new', 'the button is routed, not reported as stale')
  assert.deepEqual(env.rawSessions.calls.create, [{ workspaceId: 'w-beta' }], 'the named folder wins over the binding')
  assert.equal(env.state.boundSessionId(CHAT), 'session-fresh', 'the new Session stays bound')
  // The card must show the fresh Session rather than the "unavailable" wording — the half of
  // the bug that binding assertions alone cannot see. Structural checks, not a literal copy of
  // the screen: the exact wording is already pinned in screens.test.mjs.
  const card = env.bot.lastTo(CHAT)
  assert.match(card, /^📌 Новая/)
  assert.match(card, /id: session-[^ ]* · папка: sandbox/)
  assert.match(card, /состояние: ⚪ ожидает ввода/)
  assert.match(card, /Пиши текстом/)
  assert.doesNotMatch(card, /недоступна|Привязка снята/)
})

test('a Session absent from the list does not silently drop the binding', async () => {
  // The destructive half of the same bug. A read that fails, or a Session the read model has
  // not indexed yet, used to unbind the chat — and the owner's next message went nowhere.
  const env = world()
  await pair(env)
  env.state.bindSession(CHAT, 'session-1')
  env.rawSessions.list = async () => {
    throw new Error('controller restarting')
  }

  await env.router.handleCallback(callback(CHAT, CB.refreshSession))
  assert.equal(env.state.boundSessionId(CHAT), 'session-1', 'a failed read keeps the binding')
  assert.match(env.bot.lastTo(CHAT), /Привязка сохранена/)
  assert.doesNotMatch(env.bot.lastTo(CHAT), /Привязка снята/)
})

test('an archived Session is reported as gone and drops the binding', async () => {
  // The other side of the same rule: positive evidence must still unbind, or a chat would
  // keep writing into a Session the owner archived.
  const env = world({ archived: ['session-1'] })
  await pair(env)
  env.state.bindSession(CHAT, 'session-1')

  await env.router.handleCallback(callback(CHAT, CB.refreshSession))
  assert.equal(env.state.boundSessionId(CHAT), null, 'an archived Session unbinds')
  assert.match(env.bot.lastTo(CHAT), /Сессия недоступна/)
})

test('a [🔄] press on a quiet screen still redraws it', async () => {
  const env = world()
  await pair(env)
  await env.router.handleCallback(callback(CHAT, cbWorkspace('w-alpha'), { messageId: 90 }))
  const first = env.bot.screenText(90)
  await env.router.handleCallback(callback(CHAT, cbWorkspace('w-alpha'), { messageId: 90 }))
  assert.match(env.bot.screenText(90), /^📁 dsh-telegram-app/)
  assert.equal(typeof first, 'string')
})

// ── §12 degradation ─────────────────────────────────────────────────────────

test('§12 without a workspace registry the lists are empty but pairing works', async () => {
  const env = world({ workspaces: [] })
  assert.equal(await pair(env), 'paired')
  assert.match(env.bot.lastTo(CHAT), /^🏠 DSH/)
  await env.router.handleMessage(message(CHAT, '/chats'))
  assert.equal(env.bot.lastTo(CHAT), '📁 Воркспейсы\n\nНет папок с сессиями.')
})

test('§12 a sessionController failure degrades to a human answer', async () => {
  const env = world()
  await pair(env)
  env.state.bindSession(CHAT, 'session-1')
  env.sessions.list = async () => {
    throw new Error('no session controller in this composition')
  }
  assert.equal(await env.router.handleMessage(message(CHAT, 'привет')), 'no-controller')
  assert.match(env.bot.lastTo(CHAT), /Сессии недоступны: no session controller/)
  assert.equal(env.state.boundSessionId(CHAT), 'session-1', 'a broken controller does not drop the binding')
})

test('§12 a session that vanished or was archived drops the binding and offers L1', async () => {
  const env = world({ archived: ['session-1'] })
  await pair(env)
  env.state.bindSession(CHAT, 'session-1', { workspaceId: 'w-alpha' })
  assert.equal(await env.router.handleMessage(message(CHAT, 'привет')), 'session-gone')
  assert.match(env.bot.lastTo(CHAT), /Сессия недоступна/)
  assert.equal(env.state.boundSessionId(CHAT), null)
  const keyboard = (env.bot.lastKeyboard(CHAT) ?? []).flat()
  assert.deepEqual(keyboard.map((entry) => entry.callback_data), [CB.workspaces])
})

test('§12 tapping a session that is gone shows L1 with a message', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.handleCallback(callback(CHAT, cbSession('session-vanished'))), 'cb-session-gone')
  assert.equal(env.bot.answers.at(-1).text, 'Сессия недоступна')
  assert.match(env.bot.lastTo(CHAT), /^📁 Воркспейсы/)
})

test('openers go back to the chat level, not into a missing session', async () => {
  const env = world()
  await pair(env)
  // `[⬅️ К чатам]` with nothing bound lands on the first folder, the same place a
  // bare `/chats` opens; with a binding it returns to that Session's own folder,
  // which is covered above.
  assert.equal(await env.router.handleCallback(callback(CHAT, CB.backToL3)), 'cb-back-chats')
  assert.match(env.bot.lastTo(CHAT), /^📁 dsh-telegram-app · /)
  assert.match(env.bot.lastTo(CHAT), /Последние 2 из 2/)
})

// ── §11 throttling ──────────────────────────────────────────────────────────

test('§11 answers to an unauthorized chat are throttled', async () => {
  const env = world()
  assert.equal(await env.router.handleMessage(message(CHAT, '/whoami')), 'whoami')
  assert.equal(await env.router.handleMessage(message(CHAT, '/whoami')), 'throttled')
  assert.equal(await env.router.handleMessage(message(CHAT, '/start')), 'throttled')
  assert.equal(await env.router.handleMessage(message(CHAT, 'some text')), 'pair-refused', 'a token attempt is counted, not throttled')
})

test('§11 an unauthorized chat cannot reach commands through a callback', async () => {
  const env = world()
  for (const payload of [CB.stop, CB.lastFive, cbLimit(15), cbNotify(false), cbWorkspace('w-alpha')]) {
    assert.equal(await env.router.handleCallback(callback(999, payload)), 'callback-denied', payload)
  }
  assert.equal(env.state.settings(999).sessionLimit, 5)
})

test('§11 attempts older than the pause window are forgiven', async () => {
  let clock = 1_700_000_000_000
  const root = tempDir()
  const file = path.join(root, 'state.json')
  const state = new StateStore({ file })
  state.load()
  state.setControlToken('correct-horse')
  const router = createRouter({
    config: {},
    state,
    bot: fakeBot(),
    sessions: fakeSessions(),
    registry: fakeRegistry(),
    logger: fakeLogger(),
    now: () => clock,
  })
  for (let attempt = 0; attempt < PAIR_MAX_FAILURES; attempt += 1) await router.handleMessage(message(CHAT, 'wrong'))
  assert.equal(await router.handleMessage(message(CHAT, 'correct-horse')), 'pair-paused')

  clock += 16 * 60 * 1000
  assert.equal(await router.handleMessage(message(CHAT, 'correct-horse')), 'paired')
})

// ── §8 error notifications ──────────────────────────────────────────────────

test('§8 an agent error is reported once per session per five minutes', async () => {
  const env = world()
  await pair(env)
  assert.equal(await env.router.notifyError('session-1', 'bash failed with exit code 1'), 'error-notified')
  assert.equal(env.bot.lastTo(CHAT), '⚠️ Фикс авторизации: bash failed with exit code 1')
  // The throttle is per Session: a second failure of the same one is suppressed,
  // while another Session still gets its own message.
  assert.equal(await env.router.notifyError('session-1', 'again'), 'error-throttled')
  assert.equal(await env.router.notifyError('session-2', 'other failure'), 'error-notified')
  assert.equal(env.bot.lastTo(CHAT), '⚠️ Спецификация слоя 1: other failure')
  // A Session the filters exclude is never announced at all.
  assert.equal(await env.router.notifyError('session-unknown', 'x'), 'error-skipped')
})

// ── helpers ─────────────────────────────────────────────────────────────────

test('parseCommand tolerates the group-chat @BotName suffix', () => {
  assert.deepEqual(parseCommand('/use@dsh_test_bot 3'), { command: 'use', argument: '3' })
  assert.deepEqual(parseCommand('/start'), { command: 'start', argument: '' })
  assert.deepEqual(parseCommand('not a command'), null)
})

test('§7 every documented callback payload parses to a distinct action', () => {
  const cases = [
    [CB.menu, 'menu'],
    [CB.settings, 'settings'],
    [cbLimit(3), 'setLimit'],
    [cbSort('activity'), 'setSort'],
    [cbNotify(true), 'setNotify'],
    [CB.workspaces, 'workspaces'],
    [cbWorkspace('w1'), 'workspace'],
    [cbSession('session-1'), 'session'],
    [CB.backToL3, 'backChats'],
  [CB.refreshSession, 'refreshSession'],
    [CB.backToL1, 'backWorkspaces'],
    ['a:nonce:allow', 'approval'],
    [CB.stop, 'stop'],
    [CB.lastFive, 'history'],
    [CB.unpairYes, 'unpairConfirm'],
    [CB.unpairNo, 'unpairCancel'],
  ]
  for (const [payload, kind] of cases) {
    assert.equal(parseCallback(payload).kind, kind, `${payload} should parse as ${kind}`)
  }
})

test('every callback payload the router can emit fits the byte budget', () => {
  const payloads = [
    CB.menu, CB.settings, CB.workspaces, CB.backToL1, CB.backToL3, CB.refreshSession, CB.stop, CB.lastFive, CB.unpairYes, CB.unpairNo,
    cbLimit(15), cbSort('activity'), cbNotify(false), cbWorkspace('workspace-uuid-1234'), cbSession('session-58b80b9b-1bc5-495d-9626-4270b477a8b9'),
  ]
  for (const payload of payloads) {
    assert.ok(Buffer.byteLength(payload, 'utf8') <= 64, `${payload} is ${Buffer.byteLength(payload, 'utf8')} bytes`)
  }
})
