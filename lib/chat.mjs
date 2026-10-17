/**
 * The chat-layer brain: command routing, screen navigation and callback handling.
 *
 * Everything the bot does in a private chat is decided here, so the plugin entry
 * point only has to own the poll loop, the timers and the approval plumbing. The
 * router takes its collaborators by injection — transport, session API, state
 * store, registry reader — which keeps the whole surface testable with a fake
 * bot and a fake session controller.
 *
 * Rules implemented here, and where they come from:
 *
 * - §6 command table, including `/whoami` answering without authorization;
 * - §2/§5 screen navigation, one editable message per screen;
 * - §7 callback vocabulary, and "a press from a non-paired chat changes nothing";
 * - §11 private chats only, constant-time token comparison, 5 failures then a
 *   15-minute pause, silence plus a log line for unpaired prompts;
 * - §12 graceful degradation when a Session or the controller disappears.
 */
import { randomBytes } from 'node:crypto'
import { MAX_HISTORY_LINE, asMessage, cut, oneLine, relativeTime, runDuration, shortId } from './format.mjs'
import { CB, MENU_REPLY_KEYBOARD, MENU_REPLY_LABEL, cbApproval, cbSession, parseCallback } from './markup.mjs'
import { buildView, folderPage } from './nav.mjs'
import { renderChats, renderMenu, renderSession, renderSettings, renderWorkspaces, sessionTitle, workspaceTitle } from './screens.mjs'
import { SESSION_LIMITS, WORKSPACE_SORTS } from './state.mjs'

/** Longest prompt the chat layer accepts; files are out of scope for layer 1 (§6). */
export const MAX_PROMPT_LENGTH = 8000

/** Failed token attempts before the chat is paused (§11). */
export const PAIR_MAX_FAILURES = 5

/** How long that pause lasts. */
export const PAIR_PAUSE_MS = 15 * 60 * 1000

/** Cooldown between answers to an unauthorized chat. */
export const UNAUTHORIZED_COOLDOWN_MS = 30 * 1000

/** How long one Session's error notice is suppressed after it fired (§8). */
export const ERROR_THROTTLE_MS = 5 * 60 * 1000

/** The prompt shown to an unpaired chat (§6). */
export const ASK_FOR_TOKEN = 'Пришли контрольный токен, чтобы привязать этот чат.'

/** Every command the bot answers, for `/help` and Telegram's own hint list. */
export const COMMANDS = Object.freeze([
  ['start', 'Открыть меню'],
  ['menu', 'Открыть меню'],
  ['chats', 'Воркспейсы и чаты'],
  ['use', 'Привязать чат по номеру или id'],
  ['new', 'Новая сессия в папке'],
  ['last', 'Последние сообщения сессии'],
  ['stop', 'Остановить текущий ход'],
  ['status', 'Состояние моста'],
  ['settings', 'Настройки экрана'],
  ['notify', 'Уведомления: on или off'],
  ['limit', 'Сколько чатов показывать в папке'],
  ['sort', 'Порядок папок: registry или activity'],
  ['unbind', 'Отвязать сессию от чата'],
  ['unpair', 'Отвязать чат от бота'],
  ['whoami', 'Мой telegram id'],
  ['help', 'Справка'],
])

/** Split `/cmd@BotName arg` into its command and argument. */
export function parseCommand(text) {
  const value = String(text ?? '').trim()
  if (!value.startsWith('/')) return null
  const [head, ...rest] = value.split(/\s+/u)
  const command = head.slice(1).split('@')[0].toLowerCase()
  return { command, argument: rest.join(' ').trim() }
}

/**
 * The text of one message, or `null` when it carries none.
 *
 * Only `text` blocks count. An earlier version also rendered `tool-call` blocks as
 * `→ <tool>`, which is a transcript rather than an answer: a turn that ends with tool calls
 * and no closing prose produced "→ shell → pwsh → edit", so pressing "last answer" showed
 * an itinerary of the agent's own activity instead of what it had said. A tool call carries
 * no user-facing text, so it is skipped rather than summarized.
 *
 * Paragraph structure is preserved (`asMessage`, not `oneLine`): an answer is content, and
 * flattening it into a single paragraph turns headings, lists and code into one unreadable
 * run. Callers that need a one-line label flatten it themselves.
 *
 * @param message - a message whose `content` is a string or a block array.
 * @returns the text, or `null`.
 */
export function textOfMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return asMessage(content) || null
  if (!Array.isArray(content)) return null
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const joined = asMessage(parts.join('\n\n'))
  return joined.length > 0 ? joined : null
}

/**
 * The last assistant message that actually carries text, or `null`.
 *
 * Messages are scanned newest first and skipped when they hold no text, so a turn whose
 * final message is a bare tool call does not shadow the prose that came before it.
 *
 * @param page - a history page.
 * @returns the text, or `null` when the Session has no assistant prose at all.
 */
export function lastAssistantText(page) {
  const records = page?.records ?? []
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const event = records[index]?.event ?? records[index]
    if (event?.type !== 'assistant/message') continue
    const text = textOfMessage(event.data?.message)
    if (text) return text
  }
  return null
}

/** Clamp a numeric argument into `[1, max]`, falling back when it is not a number. */
export function clampCount(argument, fallback, max) {
  const value = Number(argument)
  if (!Number.isFinite(value) || value < 1) return fallback
  return Math.min(Math.floor(value), max)
}

/**
 * Build the router.
 *
 * @param options.config - normalized plugin config.
 * @param options.state - durable state store.
 * @param options.bot - Telegram transport.
 * @param options.sessions - session API (`list`, `history`, `prompt`, `cancel`, `create`).
 * @param options.registry - reads Workspaces, the archive set and availability.
 * @param options.logger - logger.
 * @param options.now - injectable clock, for tests.
 */
export function createRouter({ config, state, bot, sessions, registry, logger, now = () => Date.now() }) {
  /** Failed-token bookkeeping per chat (§11). */
  const attempts = new Map()
  /** Answer cooldowns for unauthorized chats (§11). */
  const cooldowns = new Map()
  /** Error notices already sent, per Session (§8). */
  const errorNotifiedAt = new Map()
  /** Approval questions this process is holding, keyed by nonce. */
  const pendingApprovals = new Map()

  /** Whether this chat may drive the bridge. */
  const isPaired = (chatId) => state.hasChat(chatId)

  /** Record one failed token attempt and report whether the chat must now pause. */
  function registerFailure(chatId) {
    const entry = attempts.get(chatId) ?? { count: 0, firstAt: now() }
    if (now() - entry.firstAt > PAIR_PAUSE_MS) {
      entry.count = 0
      entry.firstAt = now()
    }
    entry.count += 1
    attempts.set(chatId, entry)
    return entry.count >= PAIR_MAX_FAILURES
  }

  /** Whether this chat is still inside its pause window. */
  function paused(chatId) {
    const entry = attempts.get(chatId)
    return Boolean(entry && entry.count >= PAIR_MAX_FAILURES && now() - entry.firstAt <= PAIR_PAUSE_MS)
  }

  /** Rate-limit answers to an unauthorized chat, so a stranger cannot use the bot as a megaphone. */
  function cooldownAllows(chatId) {
    const until = cooldowns.get(chatId) ?? 0
    if (now() < until) return false
    cooldowns.set(chatId, now() + UNAUTHORIZED_COOLDOWN_MS)
    return true
  }

  // ── Transport helpers ─────────────────────────────────────────────────────

  /** Send one message, splitting at the Telegram limit. */
  function send(chatId, text, options = {}) {
    return bot.sendMessage(chatId, text, options)
  }

  /**
   * Show one screen, editing the message it replaces when there is one.
   *
   * Telegram refuses `editMessageText` with "message is not modified" when the
   * text is unchanged — a plain `[🔄 Обновить]` on a quiet screen does exactly
   * that — and refuses it outright once the message is gone. Both are normal,
   * so a failed edit falls back to sending a fresh screen (§7, §12).
   *
   * The custom reply keyboard deliberately does **not** ride along: Telegram accepts
   * one `reply_markup` per message, so attaching it here suppressed every screen's
   * inline buttons. It is sent once, when the chat pairs.
   *
   * @returns the message id the screen now lives in, or `null`.
   */
  async function show(chatId, screen, { messageId } = {}) {
    if (typeof messageId === 'number') {
      const edited = await bot.editMessageText(chatId, messageId, screen.text, { keyboard: screen.keyboard })
      if (edited) return messageId
    }
    const sent = await send(chatId, screen.text, { keyboard: screen.keyboard })
    return sent?.message_id ?? null
  }

  /**
   * Send a standalone message and return its id.
   *
   * No reply keyboard is forced in here: an approval question arrives through this path
   * with its own inline buttons, and Telegram would have dropped them in favour of the
   * keyboard. Callers that want the persistent keyboard ask for it explicitly.
   */
  async function notify(chatId, text, options = {}) {
    const sent = await send(chatId, text, options)
    return sent?.message_id ?? null
  }

  // ── Data access ───────────────────────────────────────────────────────────

  /**
   * Read both registries and classify them into the screen view model.
   *
   * A missing `sessionController` degrades to an empty view rather than an
   * error, so pairing and notifications keep working (§12). The chat id is an
   * explicit argument because the workspace ordering is a per-chat setting.
   *
   * @param chatId - the chat whose settings shape this view.
   */
  async function collect(chatId) {
    const binding = state.binding(chatId)
    let summaries = []
    let controllerError = null
    try {
      summaries = await sessions.list(AbortSignal.timeout(8000))
    } catch (error) {
      controllerError = error
    }
    const settings = state.settings(chatId)
    const view = buildView(summaries, registry.workspaces(), {
      sort: settings.workspaceSort,
      archivedSessionIds: registry.archivedSessionIds(),
      createdByBot: (sessionId) => state.isCreatedByBot(sessionId),
      binding: binding ? { sessionId: binding.sessionId, workspaceId: binding.workspaceId } : null,
    })
    return { view, controllerError, workspacesAvailable: registry.available(), settings }
  }

  /** The last assistant text of a Session, or `null` (§5, L3 preview). */
  async function lastAnswerOf(sessionId) {
    try {
      return lastAssistantText(await sessions.history(sessionId, { maxMessages: 20 }))
    } catch (error) {
      logger?.debug?.('last answer unavailable', { sessionId: shortId(sessionId), error: String(error) })
      return null
    }
  }

  // ── Screen builders ───────────────────────────────────────────────────────

  /** L0 — the menu. */
  async function screenMenu(chatId) {
    const { view, workspacesAvailable } = await collect(chatId)
    return renderMenu({
      pairedAt: state.pairedAt(chatId),
      notify: state.notifyEnabled(chatId),
      runningCount: workspacesAvailable ? view.runningCount : 0,
      // Reachable totals, so "0 in flight" cannot be misread as "no sessions at all":
      // a quiet harness always reports 0 turns running.
      sessionCount: workspacesAvailable ? view.workspaceSessionCount : 0,
      workspaceCount: view.workspaces.length,
      now: now(),
    })
  }

  /** S — settings. */
  function screenSettings(chatId) {
    return renderSettings({ settings: state.settings(chatId) })
  }

  /** L1 — workspaces. */
  async function screenWorkspaces(chatId) {
    const { view } = await collect(chatId)
    const folder = view.bound ? view.folderFor(view.bound.sessionId) : null
    return renderWorkspaces({
      workspaces: view.workspaces,
      binding: view.binding,
      bindingTitle: view.bound ? sessionTitle(view.bound, { folderTitle: folder?.title ?? '' }) : null,
      now: now(),
    })
  }

  /** L2 — the last N chats of one folder. */
  async function screenChats(chatId, workspaceId) {
    const { view, settings } = await collect(chatId)
    const workspace = view.workspaces.find((entry) => entry.id === String(workspaceId ?? ''))
      ?? view.workspaces.find((entry) => entry.id === view.binding?.workspaceId)
      ?? view.workspaces[0]
      ?? null
    if (!workspace) return screenWorkspaces(chatId)
    const page = folderPage(workspace, settings.sessionLimit)
    const folder = view.bound ? view.folderFor(view.bound.sessionId) : null
    return renderChats({
      workspace,
      sessions: page.sessions,
      total: page.total,
      limit: page.limit,
      binding: view.binding,
      bindingTitle: view.bound ? sessionTitle(view.bound, { folderTitle: folder?.title ?? workspaceTitle(workspace) }) : null,
      bindingSessionId: view.binding?.sessionId ?? null,
      state,
      now: now(),
    })
  }

  /** L3 — the card of the bound (or named) Session. */
  /**
   * How long to wait before re-reading the Session list once.
   *
   * A Session the bridge has just created can be missing from the very next list read: the
   * controller acknowledges the creation before the read model shows it. One short retry
   * covers that window, and it is bounded so a genuinely deleted Session is still reported
   * promptly.
   */
  const SESSION_REINDEX_RETRY_MS = 400

  /** Wait, without pulling a timer abstraction into this module. */
  function delay(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }

  async function screenSession(chatId, sessionId) {
    let { view, controllerError } = await collect(chatId)
    const target = sessionId ?? view.binding?.sessionId ?? null
    if (!target) return screenWorkspaces(chatId)
    let session = view.sessions.find((entry) => entry.sessionId === target) ?? null

    // The Session may simply not be indexed yet — most often right after it was created, which
    // is exactly when the owner is looking at this screen. Re-read once before concluding
    // anything, because the conclusion is destructive: it drops the binding.
    if (!session && controllerError === null) {
      await delay(SESSION_REINDEX_RETRY_MS)
      const again = await collect(chatId)
      view = again.view
      controllerError = again.controllerError
      session = view.sessions.find((entry) => entry.sessionId === target) ?? null
    }

    if (!session) {
      // §12 says a Session that is gone or archived drops the binding. The trap is that
      // "absent from this list" is not the same fact: the list itself can be a degraded read.
      // Dropping the binding on that destroys a working link, which is what the owner saw as
      // "Сессия недоступна. Привязка снята" straight after creating one.
      //
      // Unbind only on positive evidence: the registry calls this Session archived, or a read
      // that succeeded — twice — still does not know it. A failed read keeps the binding,
      // because discarding it cannot be undone by the next tap.
      const archived = registry.archivedSessionIds().map(String).includes(String(target))
      if (!archived && controllerError) {
        logger?.warn?.('session list unavailable; keeping the binding', {
          chatId,
          sessionId: shortId(target),
          error: String(controllerError?.message ?? controllerError),
        })
        return renderSession({ session: { sessionId: target, title: view.binding?.title ?? null }, unknown: true })
      }
      state.unbindSession(chatId)
      return renderSession({ session: null, stale: true })
    }
    const folder = view.folderFor(session.sessionId)
    return renderSession({
      session,
      folderTitle: workspaceTitle(folder ?? {}),
      workspaceId: folder?.id ?? view.binding?.workspaceId ?? null,
      lastAnswer: await lastAnswerOf(session.sessionId),
      now: now(),
    })
  }

  // ── Command answers (§6) ──────────────────────────────────────────────────

  /** `/help` — one line per command. */
  function helpText() {
    return [
      'DSH на связи.',
      '',
      ...COMMANDS.filter(([command]) => command !== 'menu').map(([command, description]) => `/${command} — ${description}`),
      '',
      'Любой текст = задача в привязанный чат.',
    ].join('\n')
  }

  /** `/status` — the health report of §6. */
  async function statusText(chatId, userId) {
    const { view, settings } = await collect(chatId)
    const binding = state.binding(chatId)
    const folder = view.bound ? view.folderFor(view.bound.sessionId) : null
    const boundTitle = view.bound ? sessionTitle(view.bound, { folderTitle: folder?.title ?? '' }) : null
    const boundState = view.bound ? (view.bound.running ? '🟢 выполняется' : '⚪ ожидает ввода') : '—'
    const username = bot.me?.username
    return [
      `🔐 чат: ${chatId} (привязан: ${relativeTime(state.pairedAt(chatId), { now: now() })}, уведомления: ${settings.notify ? 'вкл' : 'выкл'})`,
      binding
        ? `📌 сессия: ${boundTitle ?? binding.sessionId} · ${shortId(binding.sessionId)} · ${boundState}`
        : '📌 сессия: не выбрана',
      `🧩 воркспейсов: ${view.workspaces.length}, сессий: ${view.sessions.length}, выполняются: ${view.runningCount}`,
      `⚙️ бот: ${username ? `@${username}` : '—'} · Harness ${config.harnessVersion ?? '—'} · плагин ${config.pluginVersion ?? '—'}`,
      `👤 user id: ${userId ?? '—'}`,
    ].join('\n')
  }

  // ── Message handling ──────────────────────────────────────────────────────

  /**
   * Handle one incoming message.
   * @param message - Telegram message object.
   * @returns a code describing the outcome, which the tests assert on.
   */
  async function handleMessage(message) {
    const chatId = Number(message?.chat?.id)
    const userId = Number(message?.from?.id)
    if (!Number.isFinite(chatId)) return 'ignored'
    if (message?.from?.is_bot === true) return 'ignored'

    // §11: only private chats. A group gets one hint per cooldown window.
    if (message?.chat?.type !== 'private') {
      if (cooldownAllows(chatId)) await send(chatId, 'Я работаю только в личной переписке.')
      logger?.warn?.('ignored a message from a non-private chat', { chatId, type: message?.chat?.type })
      return 'non-private'
    }

    const text = typeof message?.text === 'string' ? message.text.trim() : ''
    // §6: empty or whitespace-only text is not an event.
    if (text.length === 0) return 'empty'
    if (text.length > MAX_PROMPT_LENGTH) {
      await send(chatId, `Слишком длинно: ${text.length} символов, максимум ${MAX_PROMPT_LENGTH}. Файлы слой 1 не принимает — пришли текстом короче.`)
      return 'too-long'
    }

    const command = parseCommand(text)
    const paired = isPaired(chatId)

    if (command) {
      // `/whoami` is deliberately reachable without authorization (§6).
      if (command.command === 'whoami') {
        if (!cooldownAllows(chatId)) return 'throttled'
        const lines = [`user id: ${userId}`, `chat id: ${chatId}`, `привязка: ${paired ? 'есть' : 'нет'}`]
        if (paired) {
          const bound = state.boundSessionId(chatId)
          lines.push(`сессия: ${bound ? shortId(bound) : 'не выбрана'}`)
        } else {
          lines.push('', ASK_FOR_TOKEN)
        }
        await notify(chatId, lines.join('\n'))
        return 'whoami'
      }
      if (command.command === 'help') {
        await notify(chatId, helpText())
        return 'help'
      }
    }

    if (!paired) {
      // `/start` and `/menu` ask for the token; any other command is answered
      // with the same prompt, rate-limited (§6, §11).
      if (command) {
        if (!cooldownAllows(chatId)) return 'throttled'
        await send(chatId, ASK_FOR_TOKEN)
        return 'unpaired-command'
      }
      return tryPair(chatId, userId, text)
    }

    // The persistent reply-keyboard button is a plain message, not a command.
    if (text === MENU_REPLY_LABEL) {
      await show(chatId, await screenMenu(chatId), {})
      return 'menu'
    }

    if (command) return handleCommand(chatId, userId, command)

    // §14: plain text goes to the bound Session, and the answer names it.
    return promptBound(chatId, text)
  }

  /** Attempt to authorize a chat with the text the operator sent (§6, §11). */
  async function tryPair(chatId, userId, candidate) {
    if (paused(chatId)) {
      if (cooldownAllows(chatId)) await send(chatId, 'Слишком много неверных попыток. Попробуй через 15 минут.')
      return 'pair-paused'
    }
    if (!state.hasControlToken()) {
      if (cooldownAllows(chatId)) await send(chatId, 'На стороне Harness ещё не задан контрольный токен — открой настройки плагина в DSH.')
      return 'pair-no-token'
    }
    if (!state.matchesControlToken(candidate)) {
      const exhausted = registerFailure(chatId)
      logger?.warn?.('chat pairing refused', { chatId, userId, attempts: attempts.get(chatId)?.count })
      if (cooldownAllows(chatId) || exhausted) {
        await send(chatId, exhausted ? 'Неверный токен. Привязка приостановлена на 15 минут.' : 'Неверный токен.')
      }
      return 'pair-refused'
    }

    attempts.delete(chatId)
    state.pair({ userId, chatId })
    logger?.info?.('chat paired', { chatId, userId })
    await notify(chatId, '✅ Чат привязан.')
    // The persistent keyboard is installed here, once, and never again: Telegram allows a
    // single `reply_markup` per message, so attaching it to screens would replace their
    // inline buttons. Sent as its own message so it cannot compete with anything.
    await notify(chatId, 'Кнопка «Меню» внизу открывает меню в любой момент.', { replyKeyboard: MENU_REPLY_KEYBOARD })
    await show(chatId, await screenMenu(chatId), {})
    return 'paired'
  }

  /** Route one recognized command. */
  async function handleCommand(chatId, userId, { command, argument }) {
    switch (command) {
      case 'start':
      case 'menu':
        await show(chatId, await screenMenu(chatId), {})
        return 'menu'

      case 'chats': {
        const { view } = await collect(chatId)
        const index = Number(argument)
        if (argument.length > 0 && Number.isInteger(index) && index >= 1 && index <= view.workspaces.length) {
          await show(chatId, await screenChats(chatId, view.workspaces[index - 1].id), {})
          return 'chats-folder'
        }
        if (argument.length > 0) {
          await notify(chatId, `Нет папки с номером ${argument}. Всего папок: ${view.workspaces.length}.`)
          return 'chats-bad-index'
        }
        await show(chatId, await screenWorkspaces(chatId), {})
        return 'chats'
      }

      case 'use': {
        const { view } = await collect(chatId)
        const target = resolveSessionArgument(view, argument)
        if (!target) {
          await notify(chatId, argument ? `Не нашёл чат «${argument}».` : 'Формат: /use <номер|id>. Список — /chats.')
          return 'use-missing'
        }
        state.bindSession(chatId, target.session.sessionId, { workspaceId: target.workspace?.id ?? null })
        await show(chatId, await screenSession(chatId, target.session.sessionId), {})
        return 'use'
      }

      case 'new': {
        const created = await createSession(chatId, argument)
        if (!created.ok) {
          await notify(chatId, created.message)
          return 'new-failed'
        }
        await show(chatId, await screenSession(chatId, created.sessionId), {})
        return 'new'
      }

      case 'last':
        await sendHistory(chatId, clampCount(argument, 5, 10))
        return 'last'

      case 'stop':
        return stopTurn(chatId)

      case 'status':
        await notify(chatId, await statusText(chatId, userId))
        return 'status'

      case 'settings':
        await show(chatId, screenSettings(chatId), {})
        return 'settings'

      case 'notify': {
        const value = argument.toLowerCase()
        if (value !== 'on' && value !== 'off') {
          await notify(chatId, `Сейчас уведомления: ${state.notifyEnabled(chatId) ? 'вкл' : 'выкл'}. Формат: /notify on|off`)
          return 'notify-hint'
        }
        state.setSetting(chatId, 'notify', value === 'on')
        await notify(chatId, `Уведомления: ${value === 'on' ? 'вкл' : 'выкл'}.`)
        return 'notify'
      }

      case 'limit': {
        const value = Number(argument)
        if (!SESSION_LIMITS.includes(value)) {
          await notify(chatId, `Формат: /limit ${SESSION_LIMITS.join('|')}. Сейчас: ${state.settings(chatId).sessionLimit}.`)
          return 'limit-hint'
        }
        state.setSetting(chatId, 'sessionLimit', value)
        await notify(chatId, `Сколько чатов в папке: ${value}.`)
        return 'limit'
      }

      case 'sort': {
        if (!WORKSPACE_SORTS.includes(argument)) {
          await notify(chatId, `Формат: /sort ${WORKSPACE_SORTS.join('|')}. Сейчас: ${state.settings(chatId).workspaceSort}.`)
          return 'sort-hint'
        }
        state.setSetting(chatId, 'workspaceSort', argument)
        await notify(chatId, `Сортировка папок: ${argument === 'activity' ? 'по активности' : 'как в сайдбаре'}.`)
        return 'sort'
      }

      case 'unbind':
        state.unbindSession(chatId)
        await show(chatId, await screenWorkspaces(chatId), {})
        return 'unbind'

      case 'unpair':
        await notify(chatId, 'Отвязать этот чат от бота?', {
          keyboard: [[{ text: '✅ Да, отвязать', callback_data: CB.unpairYes }, { text: '⬅️ Отмена', callback_data: CB.unpairNo }]],
        })
        return 'unpair-ask'

      case 'panel':
      case 'pair':
        // Commands an earlier version answered. Keeping them as no-ops with a
        // clear answer means an old habit does not look like a broken bot.
        await notify(
          chatId,
          command === 'panel'
            ? 'Панель Mini App пока выключена: она ждёт транспорт (свой домен или туннель).'
            : 'Привязка идёт сама: просто пришли контрольный токен сообщением.',
        )
        return 'legacy'

      default:
        await notify(chatId, `Не знаю команду /${command}. Справка — /help`)
        return 'unknown-command'
    }
  }

  /**
   * Resolve `/use`'s argument against the current numbering and raw ids.
   *
   * Numbering runs across folders in folder order, freshest session first, which
   * is the order the lists stack in.
   */
  function resolveSessionArgument(view, argument) {
    if (!argument) return null
    if (/^\d+$/u.test(argument)) {
      const index = Number(argument)
      let cursor = 0
      for (const workspace of view.workspaces) {
        for (const session of workspace.sessions) {
          cursor += 1
          if (cursor === index) return { session, workspace }
        }
      }
      return null
    }
    for (const workspace of view.workspaces) {
      const session = workspace.sessions.find((entry) => entry.sessionId === argument || entry.sessionId.startsWith(argument))
      if (session) return { session, workspace }
    }
    return null
  }

  /**
   * `/new [path]` and `➕ Новая в этой папке` — the directory comes from the argument, then
   * an explicitly named folder, then the bound folder, then `config.cwd`, then the first
   * registry folder (§6).
   *
   * §1 warns that a Session without a directory never appears in a list, so a directory is
   * always chosen; and when it names a registered folder the Session is created through
   * `workspaceId`, which is what makes it appear in the Web UI sidebar instead of floating
   * outside every folder.
   *
   * @param chatId - the chat asking.
   * @param argument - free-form path or folder reference; empty for the button route.
   * @param options.workspaceId - a folder named by the caller, which wins over the binding
   *   because the button already knows which folder it belongs to.
   */
  async function createSession(chatId, argument, { workspaceId } = {}) {
    const { view } = await collect(chatId)
    const boundFolder = view.binding ? view.folderFor(view.binding.sessionId) : null
    const requested = argument.length > 0 ? argument : null
    const named = typeof workspaceId === 'string' && workspaceId.length > 0
      ? view.workspaces.find((entry) => entry.id === workspaceId) ?? null
      : null
    let workspace = null
    let cwd = null

    if (named) {
      // The button names its folder, so neither the argument nor the binding is consulted.
      workspace = named
    } else if (requested) {
      workspace = view.workspaces.find((entry) => entry.path.toLowerCase() === requested.toLowerCase())
        ?? view.workspaces.find((entry) => entry.id === requested)
        ?? null
      cwd = workspace ? null : requested
    } else if (boundFolder) {
      workspace = boundFolder
    } else if (config.cwd) {
      workspace = view.workspaces.find((entry) => entry.path.toLowerCase() === config.cwd.toLowerCase()) ?? null
      cwd = workspace ? null : config.cwd
    } else {
      workspace = view.workspaces[0] ?? null
    }

    if (!workspace && !cwd) {
      return { ok: false, message: 'Не вижу ни одной папки, и рабочий каталог не задан. Укажи путь: /new W:\\harness\\default' }
    }
    try {
      const created = await sessions.create(workspace ? { workspaceId: workspace.id } : { cwd })
      const sessionId = String(created?.sessionId ?? '')
      if (sessionId.length === 0) return { ok: false, message: 'Harness не вернул id новой сессии.' }
      state.markCreatedByBot(sessionId)
      state.bindSession(chatId, sessionId, { workspaceId: workspace?.id ?? null })
      logger?.info?.('session created from telegram', {
        chatId,
        sessionId: shortId(sessionId),
        workspace: workspace?.id ?? null,
        cwd,
      })
      const where = workspace ? workspaceTitle(workspace) : cwd
      await notify(chatId, `➕ Новая сессия в «${where}».`)
      return { ok: true, sessionId }
    } catch (error) {
      return { ok: false, message: `Не получилось создать сессию: ${String(error?.message ?? error)}` }
    }
  }

  /** Admit one prompt through the session API, with its own request id. */
  function sendPrompt(sessionId, text) {
    const requestId = `tg-${now().toString(36)}-${randomBytes(4).toString('hex')}`
    return sessions.prompt(sessionId, text, { mode: 'queue', requestId })
  }

  /** Send a prompt into the bound Session, naming it in the answer (§2, §14). */
  async function promptBound(chatId, text) {
    const binding = state.binding(chatId)
    if (!binding) {
      await send(chatId, 'Сначала выбери чат.', { keyboard: [[{ text: '📁 Воркспейсы', callback_data: CB.workspaces }]] })
      return 'no-binding'
    }
    const { view, controllerError } = await collect(chatId)
    if (view.bound === null) {
      if (controllerError) {
        await send(chatId, `Сессии недоступны: ${String(controllerError?.message ?? controllerError)}`)
        return 'no-controller'
      }
      state.unbindSession(chatId)
      await send(chatId, 'Сессия недоступна: она удалена или архивирована. Привязка снята.', {
        keyboard: [[{ text: '📁 Воркспейсы', callback_data: CB.workspaces }]],
      })
      return 'session-gone'
    }
    const folder = view.folderFor(view.bound.sessionId)
    const title = sessionTitle(view.bound, { folderTitle: folder?.title ?? '' })
    const wasRunning = view.bound.running
    try {
      await sendPrompt(view.bound.sessionId, text)
    } catch (error) {
      logger?.warn?.('prompt rejected', { chatId, sessionId: shortId(view.bound.sessionId), error: String(error?.message ?? error) })
      await send(chatId, `Не получилось отправить: ${String(error?.message ?? error)}`)
      return 'prompt-failed'
    }
    await send(chatId, `→ отправлено в «${title}»${wasRunning ? ' (в очередь)' : ''}`)
    return 'prompted'
  }

  /** `📄 Последние N` — the tail of the bound Session (§5). */
  async function sendHistory(chatId, count) {
    const sessionId = state.boundSessionId(chatId)
    if (!sessionId) {
      await send(chatId, 'Сначала выбери чат.')
      return 'history-no-binding'
    }
    let page
    try {
      page = await sessions.history(sessionId, { maxMessages: Math.max(count * 3, 20) })
    } catch (error) {
      await send(chatId, `История недоступна: ${String(error?.message ?? error)}`)
      return 'history-failed'
    }
    const lines = []
    for (const record of page?.records ?? []) {
      const event = record?.event ?? record
      const type = event?.type
      if (type !== 'assistant/message' && type !== 'user/message') continue
      const text = textOfMessage(event.data?.message)
      if (!text) continue
      // A silent cut reads as a broken answer: the owner cannot tell a short reply from a
      // truncated one. The marker costs one character and removes the doubt.
      const body = cut(text, MAX_HISTORY_LINE)
      lines.push(`${type === 'user/message' ? '👤' : '🤖'} ${body}${body.length < text.length ? '…' : ''}`)
    }
    const tail = lines.slice(-count)
    if (tail.length === 0) {
      await send(chatId, 'В этой сессии пока нет сообщений.')
      return 'history-empty'
    }
    await send(chatId, tail.join('\n\n'))
    return 'history'
  }

  /** `⏹ Стоп` and `/stop` — cancel the running turn (§5). */
  async function stopTurn(chatId) {
    const sessionId = state.boundSessionId(chatId)
    if (!sessionId) {
      await send(chatId, 'Сначала выбери чат.')
      return 'stop-no-binding'
    }
    const { view } = await collect(chatId)
    const session = view.sessions.find((entry) => entry.sessionId === sessionId)
    if (session && !session.running) {
      await send(chatId, 'Сейчас ничего не выполняется.')
      return 'stop-idle'
    }
    try {
      await sessions.cancel(sessionId)
    } catch (error) {
      logger?.warn?.('cancel failed', { chatId, sessionId: shortId(sessionId), error: String(error?.message ?? error) })
      await send(chatId, `Не получилось отменить: ${String(error?.message ?? error)}`)
      return 'stop-failed'
    }
    await send(chatId, '⏹ Отмена отправлена')
    return 'stopped'
  }

  // ── Callback handling (§7) ────────────────────────────────────────────────

  /** Resolve one approval press against the questions this process is holding. */
  async function resolveApproval(query, action) {
    const chatId = Number(query?.message?.chat?.id)
    if (!Number.isFinite(chatId) || !isPaired(chatId)) {
      await bot.answerCallbackQuery(query?.id, 'Нет доступа')
      return 'approval-denied'
    }
    const pending = pendingApprovals.get(action.nonce)
    if (!pending) {
      await bot.answerCallbackQuery(query?.id, 'Уже не актуально')
      return 'approval-stale'
    }
    pending.decide(action.allow, chatId, query?.message?.message_id)
    await bot.answerCallbackQuery(query?.id, action.allow ? 'Разрешено' : 'Отклонено')
    return 'approval-answered'
  }

  /**
   * Handle one inline button press.
   *
   * Every path re-checks the pairing, because §7 requires a press from a
   * non-paired chat to leave the message untouched.
   *
   * @param query - Telegram callback query.
   * @returns a code describing the outcome.
   */
  async function handleCallback(query) {
    const data = typeof query?.data === 'string' ? query.data : ''
    const chatId = Number(query?.message?.chat?.id)
    const messageId = Number.isFinite(Number(query?.message?.message_id)) ? Number(query.message.message_id) : undefined
    const action = parseCallback(data)

    // Approvals are answered from the chat that received the question, which is
    // always paired; the nonce lookup is the real gate there.
    if (action.kind === 'approval') return resolveApproval(query, action)

    if (!Number.isFinite(chatId) || !isPaired(chatId)) {
      await bot.answerCallbackQuery(query?.id, 'Нет доступа')
      logger?.warn?.('callback from an unpaired chat ignored', { chatId, data })
      return 'callback-denied'
    }

    switch (action.kind) {
      case 'menu':
        await bot.answerCallbackQuery(query?.id)
        await show(chatId, await screenMenu(chatId), { messageId })
        return 'cb-menu'

      case 'settings':
        await bot.answerCallbackQuery(query?.id)
        await show(chatId, screenSettings(chatId), { messageId })
        return 'cb-settings'

      case 'workspaces':
        await bot.answerCallbackQuery(query?.id)
        await show(chatId, await screenWorkspaces(chatId), { messageId })
        return 'cb-workspaces'

      case 'workspace':
        await bot.answerCallbackQuery(query?.id)
        await show(chatId, await screenChats(chatId, action.workspaceId), { messageId })
        return 'cb-workspace'

      case 'session': {
        const { view } = await collect(chatId)
        const session = view.sessions.find((entry) => entry.sessionId === action.sessionId)
        if (!session) {
          await bot.answerCallbackQuery(query?.id, 'Сессия недоступна')
          await show(chatId, await screenWorkspaces(chatId), { messageId })
          return 'cb-session-gone'
        }
        const folder = view.folderFor(session.sessionId)
        state.bindSession(chatId, session.sessionId, { workspaceId: folder?.id ?? null })
        await bot.answerCallbackQuery(query?.id, `Выбрано: ${sessionTitle(session, { folderTitle: folder?.title ?? '' })}`)
        await show(chatId, await screenSession(chatId, session.sessionId), { messageId })
        return 'cb-session'
      }

      case 'backChats':
        await bot.answerCallbackQuery(query?.id)
        await show(chatId, await screenChats(chatId, state.binding(chatId)?.workspaceId ?? null), { messageId })
        return 'cb-back-chats'

      case 'refreshSession':
        // Redraw the Session the chat is bound to. Distinct from `backChats`, which leaves for
        // the folder list: the L3 button used to carry that payload, so "Обновить" navigated
        // away instead of refreshing.
        await bot.answerCallbackQuery(query?.id)
        await show(chatId, await screenSession(chatId, state.boundSessionId(chatId)), { messageId })
        return 'cb-refresh-session'

      case 'newInFolder': {
        // `➕ Новая в этой папке`. The folder comes from the button, so the Session lands
        // where the owner was looking rather than in whatever the binding happens to name.
        const created = await createSession(chatId, '', { workspaceId: action.workspaceId })
        if (!created.ok) {
          await bot.answerCallbackQuery(query?.id, 'Не получилось')
          await notify(chatId, created.message)
          return 'cb-new-failed'
        }
        await bot.answerCallbackQuery(query?.id, 'Создана')
        await show(chatId, await screenSession(chatId, created.sessionId), { messageId })
        return 'cb-new'
      }

      case 'backWorkspaces':
        await bot.answerCallbackQuery(query?.id)
        await show(chatId, await screenWorkspaces(chatId), { messageId })
        return 'cb-back-workspaces'

      case 'stop': {
        const code = await stopTurn(chatId)
        await bot.answerCallbackQuery(query?.id, code === 'stopped' ? 'Отмена отправлена' : 'Ничего не выполняется')
        await show(chatId, await screenSession(chatId, state.boundSessionId(chatId)), { messageId })
        return 'cb-stop'
      }

      case 'history':
        await bot.answerCallbackQuery(query?.id)
        await sendHistory(chatId, Math.min(action.count, 10))
        return 'cb-history'

      case 'setLimit':
        state.setSetting(chatId, 'sessionLimit', action.value)
        await bot.answerCallbackQuery(query?.id, `Чатов в папке: ${state.settings(chatId).sessionLimit}`)
        await show(chatId, screenSettings(chatId), { messageId })
        return 'cb-limit'

      case 'setSort':
        state.setSetting(chatId, 'workspaceSort', action.value)
        await bot.answerCallbackQuery(query?.id, action.value === 'activity' ? 'По активности' : 'Как в сайдбаре')
        await show(chatId, screenSettings(chatId), { messageId })
        return 'cb-sort'

      case 'setNotify':
        state.setSetting(chatId, 'notify', action.value)
        await bot.answerCallbackQuery(query?.id, action.value ? 'Уведомления включены' : 'Уведомления выключены')
        await show(chatId, screenSettings(chatId), { messageId })
        return 'cb-notify'

      case 'toggleNotify': {
        // §7's legacy `n:t` button from an earlier message: flip the switch.
        const next = !state.notifyEnabled(chatId)
        state.setSetting(chatId, 'notify', next)
        await bot.answerCallbackQuery(query?.id, next ? 'Уведомления включены' : 'Уведомления выключены')
        return 'cb-toggle-notify'
      }

      case 'unpairConfirm':
        state.unpair(chatId)
        logger?.info?.('chat unpaired', { chatId })
        await bot.answerCallbackQuery(query?.id, 'Чат отвязан')
        await notify(chatId, 'Чат отвязан. Пришли контрольный токен, чтобы привязать снова.')
        return 'cb-unpaired'

      case 'unpairCancel':
        await bot.answerCallbackQuery(query?.id, 'Отменено')
        await show(chatId, await screenMenu(chatId), { messageId })
        return 'cb-unpair-cancelled'

      default:
        await bot.answerCallbackQuery(query?.id, 'Кнопка устарела')
        return 'cb-unknown'
    }
  }

  // ── Automatic messages (§8) ───────────────────────────────────────────────

  /**
   * The ✅/⛔ pair for one approval question (§7, §8).
   * @param nonce - the question's nonce.
   */
  function approvalKeyboard(nonce) {
    return [[
      { text: '✅ Разрешить', callback_data: cbApproval(nonce, true) },
      { text: '⛔ Отклонить', callback_data: cbApproval(nonce, false) },
    ]]
  }

  /**
   * `running → idle` for one Session.
   *
   * §8 sends this for every root Session of the profile, not only the bound one,
   * but a Session that the filters exclude is not a root conversation and gets
   * no message.
   *
   * @param sessionId - the Session that settled.
   * @param seconds - how long the turn ran.
   */
  async function notifyIdle(sessionId, seconds) {
    let delivered = 0
    const recipients = state.chats().filter((chatId) => state.notifyEnabled(chatId))
    if (recipients.length === 0) return 'notify-muted'
    const { view } = await collect(recipients[0])
    const session = view.sessions.find((entry) => entry.sessionId === String(sessionId))
    if (!session) return 'notify-skipped'
    const folder = view.folderFor(session.sessionId)
    const title = sessionTitle(session, { folderTitle: folder?.title ?? '' })
    const text = `✅ ${title} · ${runDuration(seconds)}`
    const keyboard = [[{ text: '📄 Последний ответ', callback_data: CB.lastFive }, { text: '📌 Открыть', callback_data: cbSession(sessionId) }]]
    for (const chatId of recipients) {
      // Inline buttons only: the notification's own actions matter more than the
      // persistent keyboard, and Telegram accepts just one `reply_markup`.
      await bot.sendMessage(chatId, text, { keyboard })
      delivered += 1
    }
    return delivered > 0 ? 'notified' : 'notify-muted'
  }

  /**
   * `agent/error` — throttled to one message per Session per five minutes (§8).
   * @param sessionId - the Session that failed.
   * @param reason - short cause.
   */
  async function notifyError(sessionId, reason) {
    if (now() - (errorNotifiedAt.get(String(sessionId)) ?? 0) < ERROR_THROTTLE_MS) return 'error-throttled'
    const recipients = state.chats().filter((chatId) => state.notifyEnabled(chatId))
    if (recipients.length === 0) return 'error-muted'
    const { view } = await collect(recipients[0])
    const session = view.sessions.find((entry) => entry.sessionId === String(sessionId))
    if (!session) return 'error-skipped'
    errorNotifiedAt.set(String(sessionId), now())
    const folder = view.folderFor(session.sessionId)
    const title = sessionTitle(session, { folderTitle: folder?.title ?? '' })
    const text = `⚠️ ${title}: ${cut(oneLine(reason), 200)}`
    for (const chatId of recipients) {
      await bot.sendMessage(chatId, text, { replyKeyboard: MENU_REPLY_KEYBOARD })
    }
    return 'error-notified'
  }

  return {
    /** Approval questions the plugin entry point registers and settles. */
    pendingApprovals,
    approvalKeyboard,
    handleMessage,
    handleCallback,
    notifyIdle,
    notifyError,
    show,
    notify,
    collect,
    screenMenu,
    screenSettings,
    screenWorkspaces,
    screenChats,
    screenSession,
    sendHistory,
    stopTurn,
    statusText,
    helpText,
  }
}
