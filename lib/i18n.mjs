/**
 * Chat-side localisation.
 *
 * The Harness Web UI has its own message catalogs (`locale/*.json`); this module owns the
 * other half — every string the **bot** says in Telegram. Until it existed those strings were
 * Russian literals scattered across the renderers, the router and the approval path, so the
 * bridge could only speak one language.
 *
 * Two decisions are worth stating, because both are easy to get wrong:
 *
 * - A dictionary entry is either a string or a function of its parameters. Counted phrases
 *   ("3 sessions", "3 сессии") need real grammar, not a placeholder and a suffix, and Russian
 *   and English disagree about how many plural forms exist. A function per phrase keeps that
 *   grammar next to the words instead of hiding it in a generic engine.
 * - `createTranslator` never throws and never returns an empty string. A missing key falls
 *   back to Russian and then to the key itself, so a half-finished translation shows a
 *   readable screen with a visible gap rather than an empty message the owner cannot explain.
 *
 * @module
 */

/** The locales the bot can speak. */
export const LOCALES = Object.freeze(['ru', 'en'])

/** The locale used when nothing else is configured. */
export const DEFAULT_LOCALE = 'ru'

/**
 * Normalise a configured locale.
 *
 * Accepts a full tag as well as a bare language (`en-GB`, `ru_RU`), because a value typed
 * into a form field is rarely exactly `en`. Unknown input falls back to the default rather
 * than failing: an unusable language setting should not stop the bridge from answering.
 *
 * @param value - configured value.
 * @returns one of {@link LOCALES}.
 */
export function resolveLocale(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw.length === 0) return DEFAULT_LOCALE
  const base = raw.split(/[-_]/u)[0]
  return LOCALES.includes(base) ? base : DEFAULT_LOCALE
}

/** Russian plural agreement: one / few / many. */
export function pluralRu(count, one, few, many) {
  const value = Math.abs(Number(count) || 0) % 100
  const tail = value % 10
  if (value > 10 && value < 20) return many
  if (tail > 1 && tail < 5) return few
  if (tail === 1) return one
  return many
}

/** English plural agreement: one / other. */
export function pluralEn(count, one, other) {
  return Math.abs(Number(count) || 0) === 1 ? one : other
}

/** Russian dictionary — the source of truth for keys. */
const RU = {
  // ── Shared ────────────────────────────────────────────────────────────────
  'common.folder': 'папка',
  'common.dash': '—',
  'common.on': 'вкл',
  'common.off': 'выкл',
  'common.onTitle': 'Вкл',
  'common.offTitle': 'Выкл',
  'common.currentChat': ({ title }) => `текущий чат: ${title}`,

  // ── Clock ─────────────────────────────────────────────────────────────────
  'time.now': 'только что',
  'time.ago': ' назад',
  'time.min': 'мин',
  'time.hour': 'ч',
  'time.day': 'дн',
  'time.sec': 'с',

  // ── Buttons ───────────────────────────────────────────────────────────────
  'btn.workspaces': '📁 Воркспейсы',
  'btn.settings': '⚙️ Настройки',
  'btn.menu': '🏠 Меню',
  'btn.refresh': '🔄 Обновить',
  'btn.backToWorkspaces': '⬅️ Воркспейсы',
  'btn.backToChats': '⬅️ К чатам',
  'btn.newInFolder': '➕ Новая в этой папке',
  'btn.stop': '⏹ Стоп',
  'btn.lastFive': '📄 Последние 5',
  'btn.lastAnswer': '📄 Последний ответ',
  'btn.open': '📌 Открыть',
  'btn.unpairYes': '✅ Да, отвязать',
  'btn.cancel': '⬅️ Отмена',
  'btn.allow': '✅ Разрешить',
  'btn.deny': '⛔ Отклонить',
  // The settings screen *returns to* the menu rather than offering it, so it carries a back
  // arrow instead of the house. The original literal encoded that distinction, and a single
  // "menu" key would have quietly flattened it.
  'btn.backToMenu': '⬅️ Меню',

  // ── L0 — menu ─────────────────────────────────────────────────────────────
  'menu.title': '🏠 DSH',
  'menu.paired': ({ when, state }) => `Чат привязан: ${when} · уведомления: ${state}`,
  'menu.reach': ({ running, total, folders }) =>
    total > 0
      ? `Сессий в работе: ${running} · доступно: ${total} ${pluralRu(total, 'сессия', 'сессии', 'сессий')} в ${folders} ${pluralRu(folders, 'воркспейсе', 'воркспейсах', 'воркспейсах')}`
      : `Сессий в работе: ${running}`,
  'menu.ask': 'Куда идём?',

  // ── S — settings ──────────────────────────────────────────────────────────
  'settings.title': '⚙️ Настройки',
  'settings.limit': ({ value }) => `Сколько чатов показывать в папке: ${value}`,
  'settings.apply': 'Тап применяет сразу и переживает перезапуск.',
  'settings.sort': ({ value }) => `Сортировка папок: ${value}`,
  'settings.notify': ({ state }) => `Уведомления: ${state}`,
  'settings.sortRegistry': 'Как в сайдбаре',
  'settings.sortActivity': 'По активности',

  // ── L1 — workspaces ───────────────────────────────────────────────────────
  'workspaces.title': '📁 Воркспейсы',
  'workspaces.titleCount': ({ count }) => `📁 Воркспейсы (${count})`,
  'workspaces.empty': 'Нет папок с сессиями.',
  'workspaces.row': ({ title, count, when }) =>
    `${title} · ${count} ${pluralRu(count, 'сессия', 'сессии', 'сессий')} · ${when}`,

  // ── L2 — chats of one folder ──────────────────────────────────────────────
  'chats.header': ({ title, path }) => `📁 ${title} · ${path}`,
  'chats.lastOf': ({ shown, total }) => `Последние ${shown} из ${total}`,
  'chats.empty': 'В этой папке нет чатов.',

  // ── L3 — one session ──────────────────────────────────────────────────────
  'session.unavailableTitle': '📌 Сессия недоступна',
  'session.unavailableBody': 'Она удалена или архивирована. Привязка снята.',
  'session.pendingLine1': 'Сессия ещё не появилась в списке — обычно это значит, что она только что создана.',
  'session.pendingLine2': 'Привязка сохранена: напиши текстом, и сообщение уйдёт в неё.',
  'session.stateRunning': '🟢 выполняется',
  'session.stateWaiting': '⚪ ожидает ввода',
  'session.idLine': ({ id, folder }) => `id: ${id} · папка: ${folder}`,
  'session.stateLine': ({ state, when }) => `состояние: ${state} · обновлено: ${when}`,
  'session.lastAnswer': ({ answer }) => `последний ответ: «${answer}»`,
  'session.lastAnswerNone': 'последний ответ: —',
  'session.hint': 'Пиши текстом — уйдёт в этот чат.',

  // ── Commands ──────────────────────────────────────────────────────────────
  'cmd.start': 'Открыть меню',
  'cmd.menu': 'Открыть меню',
  'cmd.chats': 'Воркспейсы и чаты',
  'cmd.use': 'Привязать чат по номеру или id',
  'cmd.new': 'Новая сессия в папке',
  'cmd.last': 'Последние сообщения сессии',
  'cmd.stop': 'Остановить текущий ход',
  'cmd.status': 'Состояние моста',
  'cmd.settings': 'Настройки экрана',
  'cmd.notify': 'Уведомления: on или off',
  'cmd.limit': 'Сколько чатов показывать в папке',
  'cmd.sort': 'Порядок папок: registry или activity',
  'cmd.unbind': 'Отвязать сессию от чата',
  'cmd.unpair': 'Отвязать чат от бота',
  'cmd.whoami': 'Мой telegram id',
  'cmd.help': 'Справка',

  // ── Help ──────────────────────────────────────────────────────────────────
  'help.online': 'DSH на связи.',
  'help.hint': 'Любой текст = задача в привязанный чат.',

  // ── Pairing ───────────────────────────────────────────────────────────────
  'pair.askForToken': 'Пришли контрольный токен, чтобы привязать этот чат.',
  'pair.paired': '✅ Чат привязан.',
  'pair.menuButton': 'Кнопка «Меню» внизу открывает меню в любой момент.',
  'pair.wrong': 'Неверный токен.',
  'pair.wrongExhausted': 'Неверный токен. Привязка приостановлена на 15 минут.',
  'pair.tooMany': 'Слишком много неверных попыток. Попробуй через 15 минут.',
  'pair.notConfigured': 'На стороне Harness ещё не задан контрольный токен — открой настройки плагина в DSH.',
  'pair.privateOnly': 'Я работаю только в личной переписке.',
  'pair.unpaired': 'Чат отвязан. Пришли контрольный токен, чтобы привязать снова.',
  'pair.unpairQuestion': 'Отвязать этот чат от бота?',
  'pair.unpairAdvice': 'Привязка идёт сама: просто пришли контрольный токен сообщением.',
  'pair.miniAppOff': 'Панель Mini App пока выключена: она ждёт транспорт (свой домен или туннель).',

  // ── Commands: answers ─────────────────────────────────────────────────────
  'answer.tooLong': ({ length, max }) => `Слишком длинно: ${length} символов, максимум ${max}. Файлы слой 1 не принимает — пришли текстом короче.`,
  'answer.noFolderNumber': ({ argument, total }) => `Нет папки с номером ${argument}. Всего папок: ${total}.`,
  'answer.chatNotFound': ({ argument }) => `Не нашёл чат «${argument}».`,
  'answer.chatNotFoundHint': 'Формат: /use <номер|id>. Список — /chats.',
  'answer.notifyState': ({ state }) => `Сейчас уведомления: ${state}. Формат: /notify on|off`,
  'answer.notifySet': ({ state }) => `Уведомления: ${state}.`,
  'answer.limitState': ({ values, value }) => `Формат: /limit ${values}. Сейчас: ${value}.`,
  'answer.limitSet': ({ value }) => `Сколько чатов в папке: ${value}.`,
  'answer.sortState': ({ values, value }) => `Формат: /sort ${values}. Сейчас: ${value}.`,
  'answer.sortSet': ({ value }) => `Сортировка папок: ${value}.`,
  'answer.unknownCommand': ({ command }) => `Не знаю команду /${command}. Справка — /help`,
  'answer.bindFirst': 'Сначала выбери чат.',
  'answer.sessionsUnavailable': ({ error }) => `Сессии недоступны: ${error}`,
  'answer.sessionGone': 'Сессия недоступна: она удалена или архивирована. Привязка снята.',
  'answer.promptFailed': ({ error }) => `Не получилось отправить: ${error}`,
  'answer.sentTo': ({ title, queued }) => `→ отправлено в «${title}»${queued ? ' (в очередь)' : ''}`,
  'answer.historyUnavailable': ({ error }) => `История недоступна: ${error}`,
  'answer.historyEmpty': 'В этой сессии пока нет сообщений.',
  'answer.nothingRunning': 'Сейчас ничего не выполняется.',
  'answer.cancelFailed': ({ error }) => `Не получилось отменить: ${error}`,
  'answer.cancelled': '⏹ Отмена отправлена',
  'answer.newInFolderFailed': 'Не получилось',
  'answer.newInFolderDone': 'Создана',
  'answer.createdIn': ({ where }) => `➕ Новая сессия в «${where}».`,
  'answer.noWorkspace': 'Не вижу ни одной папки, и рабочий каталог не задан. Укажи путь: /new <путь>',
  'answer.noSessionId': 'Harness не вернул id новой сессии.',
  'answer.createFailed': ({ error }) => `Не получилось создать сессию: ${error}`,

  // ── Callback toasts ───────────────────────────────────────────────────────
  'toast.noAccess': 'Нет доступа',
  'toast.stale': 'Уже не актуально',
  'toast.staleButton': 'Кнопка устарела',
  'toast.allowed': 'Разрешено',
  'toast.denied': 'Отклонено',
  'toast.sessionUnavailable': 'Сессия недоступна',
  'toast.selected': ({ title }) => `Выбрано: ${title}`,
  'toast.cancelled': 'Отмена отправлена',
  'toast.nothingRunning': 'Ничего не выполняется',
  'toast.limitSet': ({ value }) => `Чатов в папке: ${value}`,
  'toast.sortSet': ({ value }) => (value === 'activity' ? 'По активности' : 'Как в сайдбаре'),
  'toast.notifyOn': 'Уведомления включены',
  'toast.notifyOff': 'Уведомления выключены',
  'toast.unpaired': 'Чат отвязан',
  'toast.cancel': 'Отменено',

  // ── Status ────────────────────────────────────────────────────────────────
  'status.paired': 'есть',
  'status.unpaired': 'нет',
  'status.sessionNone': 'не выбрана',
  'status.sessionLine': ({ title, id, state }) => `📌 сессия: ${title} · ${id} · ${state}`,
  'status.sessionNoneLine': '📌 сессия: не выбрана',
  'status.chatLine': ({ chatId, when, state }) => `🔐 чат: ${chatId} (привязан: ${when}, уведомления: ${state})`,
  'status.counts': ({ workspaces, sessions, running }) => `🧩 воркспейсов: ${workspaces}, сессий: ${sessions}, выполняются: ${running}`,
  'status.bot': ({ username, harness, plugin }) => `⚙️ бот: ${username} · Harness ${harness} · плагин ${plugin}`,
  'status.binding': ({ value }) => `привязка: ${value}`,
  'status.sessionShort': ({ value }) => `сессия: ${value}`,

  // ── Notifications ─────────────────────────────────────────────────────────
  'notify.finished': ({ title, duration }) => `✅ ${title} · ${duration}`,
  'notify.failed': ({ title, reason }) => `⚠️ ${title}: ${reason}`,

  // ── Approvals ─────────────────────────────────────────────────────────────
  'approval.title': ({ tool, title }) => `🛡️ Разрешение: ${tool} · ${title}`,
  'approval.reason': ({ reason }) => `Причина: ${reason}`,
  'approval.browserOpen': 'Карточка открыта в браузере — ответь там.',
  'approval.deadline': ({ seconds }) => `Ответь в течение ${seconds} с, или карточка уйдёт в браузер.`,
  'approval.allowed': '✅ Разрешено',
  'approval.rejected': '⛔ Отклонено',
  'approval.unknown': 'неизвестно',
  'approval.error': 'ошибка',
}

/** English dictionary — same keys as {@link RU}. */
const EN = {
  // ── Shared ────────────────────────────────────────────────────────────────
  'common.folder': 'folder',
  'common.dash': '—',
  'common.on': 'on',
  'common.off': 'off',
  'common.onTitle': 'On',
  'common.offTitle': 'Off',
  'common.currentChat': ({ title }) => `current chat: ${title}`,

  // ── Clock ─────────────────────────────────────────────────────────────────
  'time.now': 'just now',
  'time.ago': ' ago',
  'time.min': 'min',
  'time.hour': 'h',
  'time.day': 'd',
  'time.sec': 's',

  // ── Buttons ───────────────────────────────────────────────────────────────
  'btn.workspaces': '📁 Workspaces',
  'btn.settings': '⚙️ Settings',
  'btn.menu': '🏠 Menu',
  'btn.refresh': '🔄 Refresh',
  'btn.backToWorkspaces': '⬅️ Workspaces',
  'btn.backToChats': '⬅️ To chats',
  'btn.newInFolder': '➕ New in this folder',
  'btn.stop': '⏹ Stop',
  'btn.lastFive': '📄 Last 5',
  'btn.lastAnswer': '📄 Last answer',
  'btn.open': '📌 Open',
  'btn.unpairYes': '✅ Yes, unpair',
  'btn.cancel': '⬅️ Cancel',
  'btn.allow': '✅ Allow',
  'btn.deny': '⛔ Deny',
  'btn.backToMenu': '⬅️ Menu',

  // ── L0 — menu ─────────────────────────────────────────────────────────────
  'menu.title': '🏠 DSH',
  'menu.paired': ({ when, state }) => `Chat paired: ${when} · notifications: ${state}`,
  'menu.reach': ({ running, total, folders }) =>
    total > 0
      ? `${running} running · ${total} ${pluralEn(total, 'session', 'sessions')} in ${folders} ${pluralEn(folders, 'workspace', 'workspaces')}`
      : `${running} running`,
  'menu.ask': 'Where to?',

  // ── S — settings ──────────────────────────────────────────────────────────
  'settings.title': '⚙️ Settings',
  'settings.limit': ({ value }) => `Chats shown per folder: ${value}`,
  'settings.apply': 'A tap applies at once and survives a restart.',
  'settings.sort': ({ value }) => `Folder order: ${value}`,
  'settings.notify': ({ state }) => `Notifications: ${state}`,
  'settings.sortRegistry': 'As in the sidebar',
  'settings.sortActivity': 'By activity',

  // ── L1 — workspaces ───────────────────────────────────────────────────────
  'workspaces.title': '📁 Workspaces',
  'workspaces.titleCount': ({ count }) => `📁 Workspaces (${count})`,
  'workspaces.empty': 'No folders with sessions.',
  'workspaces.row': ({ title, count, when }) =>
    `${title} · ${count} ${pluralEn(count, 'session', 'sessions')} · ${when}`,

  // ── L2 — chats of one folder ──────────────────────────────────────────────
  'chats.header': ({ title, path }) => `📁 ${title} · ${path}`,
  'chats.lastOf': ({ shown, total }) => `Last ${shown} of ${total}`,
  'chats.empty': 'No chats in this folder.',

  // ── L3 — one session ──────────────────────────────────────────────────────
  'session.unavailableTitle': '📌 Session unavailable',
  'session.unavailableBody': 'It was deleted or archived. The binding has been dropped.',
  'session.pendingLine1': 'The session is not in the list yet — usually because it was just created.',
  'session.pendingLine2': 'The binding is kept: type text and it will go there.',
  'session.stateRunning': '🟢 running',
  'session.stateWaiting': '⚪ waiting for input',
  'session.idLine': ({ id, folder }) => `id: ${id} · folder: ${folder}`,
  'session.stateLine': ({ state, when }) => `state: ${state} · updated ${when}`,
  'session.lastAnswer': ({ answer }) => `last answer: «${answer}»`,
  'session.lastAnswerNone': 'last answer: —',
  'session.hint': 'Type text — it goes to this chat.',

  // ── Commands ──────────────────────────────────────────────────────────────
  'cmd.start': 'Open the menu',
  'cmd.menu': 'Open the menu',
  'cmd.chats': 'Workspaces and chats',
  'cmd.use': 'Bind a chat by number or id',
  'cmd.new': 'New session in a folder',
  'cmd.last': 'Recent messages of the session',
  'cmd.stop': 'Stop the running turn',
  'cmd.status': 'State of the bridge',
  'cmd.settings': 'Screen settings',
  'cmd.notify': 'Notifications: on or off',
  'cmd.limit': 'How many chats a folder shows',
  'cmd.sort': 'Folder order: registry or activity',
  'cmd.unbind': 'Unbind the session from the chat',
  'cmd.unpair': 'Unpair the chat from the bot',
  'cmd.whoami': 'My telegram id',
  'cmd.help': 'Help',

  // ── Help ──────────────────────────────────────────────────────────────────
  'help.online': 'DSH is online.',
  'help.hint': 'Any text = a task in the bound chat.',

  // ── Pairing ───────────────────────────────────────────────────────────────
  'pair.askForToken': 'Send the control token to pair this chat.',
  'pair.paired': '✅ Chat paired.',
  'pair.menuButton': 'The «Menu» button at the bottom opens the menu at any time.',
  'pair.wrong': 'Wrong token.',
  'pair.wrongExhausted': 'Wrong token. Pairing is paused for 15 minutes.',
  'pair.tooMany': 'Too many wrong attempts. Try again in 15 minutes.',
  'pair.notConfigured': 'No control token is set on the Harness side yet — open the plugin settings in DSH.',
  'pair.privateOnly': 'I only work in a private chat.',
  'pair.unpaired': 'Chat unpaired. Send the control token to pair again.',
  'pair.unpairQuestion': 'Unpair this chat from the bot?',
  'pair.unpairAdvice': 'Pairing is simple: just send the control token as a message.',
  'pair.miniAppOff': 'The Mini App panel is off for now: it is waiting for a transport (your own domain or a tunnel).',

  // ── Commands: answers ─────────────────────────────────────────────────────
  'answer.tooLong': ({ length, max }) => `Too long: ${length} characters, ${max} maximum. Layer 1 does not accept files — send shorter text.`,
  'answer.noFolderNumber': ({ argument, total }) => `No folder number ${argument}. Folders in total: ${total}.`,
  'answer.chatNotFound': ({ argument }) => `No chat found for «${argument}».`,
  'answer.chatNotFoundHint': 'Format: /use <number|id>. The list is /chats.',
  'answer.notifyState': ({ state }) => `Notifications are ${state} now. Format: /notify on|off`,
  'answer.notifySet': ({ state }) => `Notifications: ${state}.`,
  'answer.limitState': ({ values, value }) => `Format: /limit ${values}. Currently: ${value}.`,
  'answer.limitSet': ({ value }) => `Chats per folder: ${value}.`,
  'answer.sortState': ({ values, value }) => `Format: /sort ${values}. Currently: ${value}.`,
  'answer.sortSet': ({ value }) => `Folder order: ${value}.`,
  'answer.unknownCommand': ({ command }) => `I do not know the command /${command}. Try /help`,
  'answer.bindFirst': 'Pick a chat first.',
  'answer.sessionsUnavailable': ({ error }) => `Sessions are unavailable: ${error}`,
  'answer.sessionGone': 'The session is unavailable: it was deleted or archived. The binding has been dropped.',
  'answer.promptFailed': ({ error }) => `Could not send: ${error}`,
  'answer.sentTo': ({ title, queued }) => `→ sent to «${title}»${queued ? ' (queued)' : ''}`,
  'answer.historyUnavailable': ({ error }) => `History unavailable: ${error}`,
  'answer.historyEmpty': 'This session has no messages yet.',
  'answer.nothingRunning': 'Nothing is running right now.',
  'answer.cancelFailed': ({ error }) => `Could not cancel: ${error}`,
  'answer.cancelled': '⏹ Cancellation sent',
  'answer.newInFolderFailed': 'It did not work',
  'answer.newInFolderDone': 'Created',
  'answer.createdIn': ({ where }) => `➕ New session in «${where}».`,
  'answer.noWorkspace': 'I see no folder, and no working directory is set. Give a path: /new <path>',
  'answer.noSessionId': 'Harness did not return an id for the new session.',
  'answer.createFailed': ({ error }) => `Could not create the session: ${error}`,

  // ── Callback toasts ───────────────────────────────────────────────────────
  'toast.noAccess': 'No access',
  'toast.stale': 'No longer relevant',
  'toast.staleButton': 'This button is stale',
  'toast.allowed': 'Allowed',
  'toast.denied': 'Denied',
  'toast.sessionUnavailable': 'Session unavailable',
  'toast.selected': ({ title }) => `Selected: ${title}`,
  'toast.cancelled': 'Cancellation sent',
  'toast.nothingRunning': 'Nothing is running',
  'toast.limitSet': ({ value }) => `Chats per folder: ${value}`,
  'toast.sortSet': ({ value }) => (value === 'activity' ? 'By activity' : 'As in the sidebar'),
  'toast.notifyOn': 'Notifications on',
  'toast.notifyOff': 'Notifications off',
  'toast.unpaired': 'Chat unpaired',
  'toast.cancel': 'Cancelled',

  // ── Status ────────────────────────────────────────────────────────────────
  'status.paired': 'yes',
  'status.unpaired': 'no',
  'status.sessionNone': 'none',
  'status.sessionLine': ({ title, id, state }) => `📌 session: ${title} · ${id} · ${state}`,
  'status.sessionNoneLine': '📌 session: none',
  'status.chatLine': ({ chatId, when, state }) => `🔐 chat: ${chatId} (paired ${when}, notifications: ${state})`,
  'status.counts': ({ workspaces, sessions, running }) => `🧩 workspaces: ${workspaces}, sessions: ${sessions}, running: ${running}`,
  'status.bot': ({ username, harness, plugin }) => `⚙️ bot: ${username} · Harness ${harness} · plugin ${plugin}`,
  'status.binding': ({ value }) => `binding: ${value}`,
  'status.sessionShort': ({ value }) => `session: ${value}`,

  // ── Notifications ─────────────────────────────────────────────────────────
  'notify.finished': ({ title, duration }) => `✅ ${title} · ${duration}`,
  'notify.failed': ({ title, reason }) => `⚠️ ${title}: ${reason}`,

  // ── Approvals ─────────────────────────────────────────────────────────────
  'approval.title': ({ tool, title }) => `🛡️ Permission: ${tool} · ${title}`,
  'approval.reason': ({ reason }) => `Reason: ${reason}`,
  'approval.browserOpen': 'The card is open in a browser — answer there.',
  'approval.deadline': ({ seconds }) => `Answer within ${seconds} s, or the card goes to the browser.`,
  'approval.allowed': '✅ Allowed',
  'approval.rejected': '⛔ Rejected',
  'approval.unknown': 'unknown',
  'approval.error': 'error',
}

/** Both dictionaries, keyed by locale. */
export const DICTIONARIES = Object.freeze({ ru: RU, en: EN })

/**
 * Interpolate `{name}` placeholders in a plain string.
 * @param template - the string.
 * @param params - the values.
 * @returns the interpolated string.
 */
function interpolate(template, params) {
  return template.replace(/\{(\w+)\}/gu, (whole, key) => {
    const value = params?.[key]
    return value === undefined || value === null ? whole : String(value)
  })
}

/**
 * Build a translator for one locale.
 *
 * The returned function is callable as `t(key)` or `t(key, params)`, and also carries the
 * locale it was built for as `t.locale`, which the clock helpers read to pick their units.
 *
 * @param locale - a value accepted by {@link resolveLocale}.
 * @returns the translator.
 */
export function createTranslator(locale) {
  const resolved = resolveLocale(locale)
  const dictionary = DICTIONARIES[resolved]
  const fallback = DICTIONARIES[DEFAULT_LOCALE]

  const t = (key, params) => {
    const entry = dictionary[key] ?? fallback[key]
    if (entry === undefined) return key
    return typeof entry === 'function' ? entry(params ?? {}) : interpolate(entry, params)
  }
  t.locale = resolved
  return t
}

/**
 * The translator used where no locale was supplied.
 *
 * The renderers are pure functions that tests call directly, so a missing `t` must mean
 * "the default language", not a crash. This is that default.
 */
export const defaultTranslator = createTranslator(DEFAULT_LOCALE)

/**
 * Every key a dictionary must define.
 *
 * Used by the tests to guarantee that neither language silently falls back to the other.
 * @returns the sorted key list.
 */
export function dictionaryKeys() {
  return Object.keys(RU).sort()
}
