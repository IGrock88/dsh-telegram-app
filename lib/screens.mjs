/**
 * The screens of §5, rendered as plain text plus an inline keyboard.
 *
 * Every function here is pure: it takes an already-collected view of the
 * Harness registry and of the bot's own state, and returns `{ text, keyboard }`.
 * Nothing in this file performs I/O, reads a clock, or talks to Telegram, which
 * is what lets the exact screen texts be covered by offline tests.
 *
 * Wording comes from `view.t`, a translator from `lib/i18n.mjs`; when a caller supplies
 * none, the default language is used. That default keeps the renderers callable directly
 * from a test or a REPL without threading a locale through every call, while the router
 * always passes the configured one.
 *
 * The layouts follow the specification literally — the `·` separators, the
 * `• ` active-value prefix on the settings screen, the wording of the state
 * line — because the owner reads these strings as UI copy, not as diagnostics.
 */
import { MAX_LAST_ANSWER, MAX_TITLE, cut, joinLines, oneLine, relativeTime, shortId, truncate } from './format.mjs'
import { defaultTranslator } from './i18n.mjs'
import { CB, assemble, button, cbLimit, cbNotify, cbSession, cbSort, cbWorkspace, row, sessionRows } from './markup.mjs'
import { SESSION_LIMITS } from './state.mjs'

/**
 * Russian plural agreement, kept exported for callers that count things outside a screen.
 *
 * Inside the screens the agreement lives in the dictionaries instead, because Russian and
 * English disagree about how many plural forms exist and a generic helper cannot serve both.
 */
export { pluralRu as plural } from './i18n.mjs'

/** The translator a renderer uses when the view carries none. */
function translatorOf(view) {
  return view?.t ?? defaultTranslator
}

/** Fallback label for a Workspace whose stored title is empty. */
export function workspaceTitle(workspace, t = defaultTranslator) {
  const title = typeof workspace?.title === 'string' ? workspace.title.trim() : ''
  if (title.length > 0) return title
  const segments = String(workspace?.path ?? '')
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? t('common.folder')
}

/**
 * A Session's display title: its own title, else `<folder> · <id8>` (§5).
 * @param session - collected session view.
 * @param options.folderTitle - the owning Workspace's title.
 */
export function sessionTitle(session, { folderTitle = '' } = {}) {
  const own = typeof session?.title === 'string' ? session.title.trim() : ''
  if (own.length > 0) return truncate(own, MAX_TITLE)
  const id = String(session?.sessionId ?? '')
  const head = id.length > 8 ? id.slice(0, 8) : id
  return folderTitle.length > 0 ? truncate(`${folderTitle} · ${head}`, MAX_TITLE) : truncate(shortId(id), MAX_TITLE)
}

/** The status mark of a session row: running, or waiting for input (§5). */
export function stateMark(session) {
  return session?.running === true ? '🟢' : '⚪'
}

/** The bot-created mark (📱), shown for Sessions this bridge started. */
function createdMark(session, state) {
  return state?.isCreatedByBot?.(session?.sessionId) === true ? ' 📱' : ''
}

/**
 * The line naming the current binding, so plain text never disappears into an
 * unnamed Session (§2).
 * @returns the line, or `undefined` when nothing is bound — an absent block
 *   must leave no gap in the screen.
 */
export function currentChatLine(binding, title, t = defaultTranslator) {
  return binding ? t('common.currentChat', { title }) : undefined
}

/** A row of value buttons where the active value carries the `• ` prefix (§5). */
function valueRow(values, active, toData, label = (value) => String(value)) {
  return row(values.map((value) => button(`${value === active ? '• ' : ''}${label(value)}`, toData(value))))
}

/**
 * L0 — the menu.
 * @param view.pairedAt - when this chat passed the control token.
 * @param view.notify - whether notifications go to this chat.
 * @param view.runningCount - how many turns are in flight right now.
 * @param view.sessionCount - how many sessions the bot can reach at all.
 * @param view.workspaceCount - how many folders those sessions sit in.
 * @param view.now - injectable clock.
 * @param view.t - translator.
 */
export function renderMenu(view) {
  const t = translatorOf(view)
  const running = Number(view?.runningCount ?? 0)
  // "0 in flight" on its own reads as "you have no sessions", which is the opposite of what
  // it means: it counts turns executing right now. On a quiet harness it is always 0, so the
  // reachable totals are what show the owner the bot can see their work. The agreement on
  // those counts is the dictionary's business, not this function's.
  const text = joinLines([
    t('menu.title'),
    '',
    t('menu.paired', {
      when: relativeTime(view?.pairedAt, { now: view?.now, t }),
      state: view?.notify ? t('common.on') : t('common.off'),
    }),
    t('menu.reach', {
      running,
      total: Number(view?.sessionCount ?? 0),
      folders: Number(view?.workspaceCount ?? 0),
    }),
    '',
    t('menu.ask'),
  ])
  return {
    text,
    keyboard: assemble([row([button(t('btn.workspaces'), CB.workspaces), button(t('btn.settings'), CB.settings)])]),
    screen: { level: 'L0' },
  }
}

/**
 * S — settings. Each row applies its value on tap; there is no Save button (§5).
 * @param view.settings - effective per-chat settings.
 * @param view.t - translator.
 */
export function renderSettings(view) {
  const t = translatorOf(view)
  const settings = view?.settings ?? { sessionLimit: 5, workspaceSort: 'registry', notify: true }
  const sortLabel = (value) => t(value === 'activity' ? 'settings.sortActivity' : 'settings.sortRegistry')
  const text = joinLines([
    t('settings.title'),
    '',
    t('settings.limit', { value: settings.sessionLimit }),
    t('settings.apply'),
    '',
    t('settings.sort', { value: sortLabel(settings.workspaceSort).toLowerCase() }),
    '',
    t('settings.notify', { state: settings.notify ? t('common.on') : t('common.off') }),
  ])
  return {
    text,
    keyboard: assemble([
      valueRow(SESSION_LIMITS, settings.sessionLimit, cbLimit),
      valueRow(['registry', 'activity'], settings.workspaceSort, cbSort, sortLabel),
      valueRow([true, false], settings.notify, cbNotify, (value) => t(value ? 'common.onTitle' : 'common.offTitle')),
      row([button(t('btn.backToMenu'), CB.menu)]),
    ]),
    screen: { level: 'S' },
  }
}

/**
 * L1 — the workspaces that currently hold at least one suitable Session (§3.4).
 * @param view.workspaces - `[{ id, title, path, sessionCount, lastActivityAt }]`, already ordered.
 * @param view.binding - whether a Session is bound.
 * @param view.bindingTitle - the bound Session's title.
 * @param view.t - translator.
 */
export function renderWorkspaces(view) {
  const t = translatorOf(view)
  const workspaces = Array.isArray(view?.workspaces) ? view.workspaces : []
  if (workspaces.length === 0) {
    return {
      text: joinLines([t('workspaces.title'), '', t('workspaces.empty')]),
      keyboard: assemble([row([button(t('btn.menu'), CB.menu)])]),
      screen: { level: 'L1', empty: true },
    }
  }
  const text = joinLines([
    t('workspaces.titleCount', { count: workspaces.length }),
    '',
    ...workspaces.map((workspace) =>
      t('workspaces.row', {
        title: workspaceTitle(workspace, t),
        count: Number(workspace.sessionCount ?? 0),
        when: relativeTime(workspace.lastActivityAt, { now: view?.now, suffix: true, t }),
      }),
    ),
    '',
    currentChatLine(view?.binding, view?.bindingTitle, t),
  ])
  return {
    text,
    keyboard: assemble([
      ...workspaces.map((workspace) =>
        row([
          button(
            `📁 ${truncate(workspaceTitle(workspace, t), 26)} · ${workspace.sessionCount}`,
            cbWorkspace(workspace.id),
          ),
        ]),
      ),
      row([button(t('btn.refresh'), CB.workspaces), button(t('btn.settings'), CB.settings), button(t('btn.menu'), CB.menu)]),
    ]),
    screen: { level: 'L1', count: workspaces.length },
  }
}

/**
 * The `➕ Новая в этой папке` payload. It reuses the folder route's argument but
 * with its own prefix, because §7 predates `/new` and overloading `w:` would
 * make "open the folder" and "start a chat in it" indistinguishable.
 */
export function cbNewFor(workspace) {
  return `n:${workspace?.id ?? ''}`
}

/**
 * L2 — the last N chats of one folder.
 * @param view.workspace - the folder being shown.
 * @param view.sessions - `[{ sessionId, title, running, updatedAt }]`, already cut to N.
 * @param view.total - how many suitable sessions the folder holds in total.
 * @param view.limit - the effective per-chat limit.
 * @param view.bindingSessionId - the bound Session, marked with 📌.
 * @param view.t - translator.
 */
export function renderChats(view) {
  const t = translatorOf(view)
  const workspace = view?.workspace
  const sessions = Array.isArray(view?.sessions) ? view.sessions : []
  const limit = Number(view?.limit ?? sessions.length)
  const total = Number(view?.total ?? sessions.length)
  const folderTitle = workspaceTitle(workspace, t)
  const shown = Math.min(limit, sessions.length)
  const header = joinLines([
    t('chats.header', { title: folderTitle, path: workspace?.path ?? '' }),
    t('chats.lastOf', { shown, total }),
  ])

  if (sessions.length === 0) {
    return {
      text: joinLines([header, '', t('chats.empty')]),
      keyboard: assemble([
        row([button(t('btn.newInFolder'), cbNewFor(workspace))]),
        row([button(t('btn.refresh'), cbWorkspace(workspace?.id ?? '')), button(t('btn.backToWorkspaces'), CB.backToL1)]),
        row([button(t('btn.settings'), CB.settings), button(t('btn.menu'), CB.menu)]),
      ]),
      screen: { level: 'L2', workspaceId: workspace?.id ?? null, empty: true },
    }
  }

  const text = joinLines([
    header,
    '',
    ...sessions.map((session, index) => {
      const title = sessionTitle(session, { folderTitle })
      const pinned = session.sessionId === view?.bindingSessionId ? '📌 ' : ''
      const when = relativeTime(session.updatedAt, { now: view?.now, t })
      return `${index + 1}. ${stateMark(session)} ${pinned}${title}${createdMark(session, view?.state)} · ${when}`
    }),
    '',
    currentChatLine(view?.binding, view?.bindingTitle, t),
  ])

  const entries = sessions.map((session, index) =>
    button(`${index + 1}. ${stateMark(session)} ${truncate(sessionTitle(session, { folderTitle }), 24)}`, cbSession(session.sessionId)),
  )

  return {
    text,
    keyboard: assemble([
      ...sessionRows(entries),
      row([button(t('btn.newInFolder'), cbNewFor(workspace)), button(t('btn.refresh'), cbWorkspace(workspace?.id ?? ''))]),
      // §2 requires `[⚙️]` beside `[⬅️]`/`[🏠]` on L1–L3, and acceptance
      // criterion 12 repeats it — so the settings entry is here as well, even
      // though §5's L2 line in the layout sketch lists only four buttons.
      row([button(t('btn.backToWorkspaces'), CB.backToL1), button(t('btn.settings'), CB.settings), button(t('btn.menu'), CB.menu)]),
    ]),
    screen: { level: 'L2', workspaceId: workspace?.id ?? null, count: sessions.length, total, limit },
  }
}

/**
 * L3 — the working screen of one chat. Text sent from here, or from L1/L2 while
 * this binding stands, becomes a prompt in this Session (§2, §5, §14).
 *
 * @param view.session - the bound Session's current summary, or `null` when it vanished.
 * @param view.folderTitle - the owning folder's title.
 * @param view.lastAnswer - the last assistant text, already fetched, or `null`.
 * @param view.stale - force the "session unavailable" wording (§12).
 * @param view.unknown - the binding is intact but the Session is not in the list yet.
 * @param view.t - translator.
 */
export function renderSession(view) {
  const t = translatorOf(view)
  if (!view?.session || view?.stale === true) {
    return {
      text: joinLines([t('session.unavailableTitle'), '', t('session.unavailableBody')]),
      keyboard: assemble([row([button(t('btn.workspaces'), CB.workspaces), button(t('btn.menu'), CB.menu)])]),
      screen: { level: 'L3', unavailable: true },
    }
  }

  // A Session the bridge is bound to but the list does not (yet) show. Calling that "deleted"
  // would be a guess, and an expensive one: the binding is intact and a refresh usually finds
  // it. The screen states the uncertainty instead and keeps the controls, because the owner
  // needs to be able to write into the Session they just created.
  if (view?.unknown === true) {
    return {
      text: joinLines([
        `📌 ${sessionTitle(view.session, { folderTitle: view?.folderTitle })}`,
        `id: ${shortId(view.session.sessionId)}`,
        '',
        t('session.pendingLine1'),
        t('session.pendingLine2'),
      ]),
      keyboard: assemble([
        row([
          button(t('btn.refresh'), CB.refreshSession),
          button(t('btn.workspaces'), CB.workspaces),
          button(t('btn.menu'), CB.menu),
        ]),
      ]),
      screen: { level: 'L3', sessionId: view.session.sessionId, pending: true },
    }
  }

  const session = view.session
  const title = sessionTitle(session, { folderTitle: view?.folderTitle })
  const state = session.running === true ? t('session.stateRunning') : t('session.stateWaiting')
  const answer = cut(oneLine(view?.lastAnswer ?? ''), MAX_LAST_ANSWER)
  const text = joinLines([
    `📌 ${title}`,
    t('session.idLine', { id: shortId(session.sessionId), folder: view?.folderTitle ?? t('common.dash') }),
    t('session.stateLine', {
      state,
      when: relativeTime(session.updatedAt, { now: view?.now, suffix: true, t }),
    }),
    answer.length > 0 ? t('session.lastAnswer', { answer }) : t('session.lastAnswerNone'),
    '',
    t('session.hint'),
  ])
  // `⬅️ К чатам` returns to the folder this Session lives in; the binding's
  // stored workspace is what makes that folder known.
  const backToChats = view?.workspaceId ? cbWorkspace(view.workspaceId) : CB.backToL1
  return {
    text,
    keyboard: assemble([
      row([button(t('btn.stop'), CB.stop), button(t('btn.lastFive'), CB.lastFive), button(t('btn.refresh'), CB.refreshSession)]),
      row([
        button(t('btn.backToChats'), backToChats),
        button(t('btn.settings'), CB.settings),
        button(t('btn.menu'), CB.menu),
      ]),
    ]),
    screen: { level: 'L3', sessionId: session.sessionId, running: session.running === true },
  }
}

/** A one-line answer, used for command replies that are not screens (§6). */
export function confirm(text) {
  return { text, keyboard: undefined, screen: { level: 'text' } }
}
