/**
 * The `callback_data` vocabulary of §7 and the inline markup builders.
 *
 * Payloads are kept deliberately tiny: Telegram caps `callback_data` at 64
 * bytes, and a Harness Session id alone is 44 characters, so the prefix budget
 * is what keeps `c:<sessionId>` inside the limit. {@link button} refuses to
 * build a button whose payload would not fit, rather than discovering that as a
 * rejected press at runtime.
 *
 * Button labels are their own concern: Telegram truncates a long label on the
 * client, but the label is also what a screen reader reads out, so it is cut
 * here, where the cut is visible in the source.
 */
import { MAX_BUTTONS_PER_MESSAGE, MAX_BUTTON_TEXT, callbackFits, truncate } from './format.mjs'
import { defaultTranslator } from './i18n.mjs'

/** Callback payloads, exactly as §7 tabulates them. */
export const CB = Object.freeze({
  menu: 'm',
  settings: 'st',
  workspaces: 'wl',
  backToL1: 'b:l1',
  backToL3: 'b:l3',
  /**
   * `🔄 Обновить` **on the session screen**.
   *
   * `b:l3` means "go back to the chat list" (`backChats`), so using it for a refresh made the
   * button leave the Session instead of redrawing it. The two intents need two payloads.
   */
  refreshSession: 'r:s',
  stop: 's:s',
  lastFive: 'l:5',
  unpairYes: 'u:y',
  unpairNo: 'u:n',
})

/** `st:lim:<n>` — how many chats a folder shows. */
export function cbLimit(value) {
  return `st:lim:${value}`
}

/** `st:sort:<registry|activity>` — the workspace ordering on L1. */
export function cbSort(value) {
  return `st:sort:${value}`
}

/** `st:not:<on|off>` — per-chat notifications. */
export function cbNotify(on) {
  return `st:not:${on ? 'on' : 'off'}`
}

/** `w:<workspaceId>` — open a folder's last chats. */
export function cbWorkspace(workspaceId) {
  return `w:${workspaceId}`
}

/** `c:<sessionId>` — bind this Session and show its card. */
export function cbSession(sessionId) {
  return `c:${sessionId}`
}

/** `a:<nonce>:<allow|deny>` — answer one approval request. */
export function cbApproval(nonce, allow) {
  return `a:${nonce}:${allow ? 'allow' : 'deny'}`
}

/**
 * Parse one `callback_data` string into an action.
 *
 * Parsing is total: anything unrecognized comes back as `{ kind: 'unknown' }`
 * so a stale or foreign press answers politely instead of throwing inside the
 * update loop.
 *
 * @param data - raw payload from Telegram.
 * @returns a discriminated action, or `{ kind: 'unknown' }`.
 */
export function parseCallback(data) {
  const value = typeof data === 'string' ? data : ''
  if (value.length === 0) return { kind: 'unknown' }
  if (value === CB.menu) return { kind: 'menu' }
  if (value === CB.settings) return { kind: 'settings' }
  if (value === CB.workspaces) return { kind: 'workspaces' }
  if (value === CB.backToL1) return { kind: 'backWorkspaces' }
  if (value === CB.backToL3) return { kind: 'backChats' }
  if (value === CB.refreshSession) return { kind: 'refreshSession' }
  if (value === CB.stop) return { kind: 'stop' }
  if (value === CB.lastFive) return { kind: 'history', count: 5 }
  if (value === CB.unpairYes) return { kind: 'unpairConfirm' }
  if (value === CB.unpairNo) return { kind: 'unpairCancel' }

  if (value.startsWith('st:')) {
    const [, field, argument] = value.split(':')
    if (field === 'lim') return { kind: 'setLimit', value: Number(argument) }
    if (field === 'sort') return { kind: 'setSort', value: argument }
    if (field === 'not') return { kind: 'setNotify', value: argument === 'on' }
    return { kind: 'unknown' }
  }
  // §7 also lists `n:t` as a notification toggle. The settings screen now emits
  // `st:not:<on|off>` so one prefix covers every value row, but a button posted
  // by an older version is still answered rather than reported as stale.
  if (value === 'n:t') return { kind: 'toggleNotify' }
  // `n:<workspaceId>` — `➕ Новая в этой папке`. This branch was missing while
  // `cbNewFor` already emitted the prefix, so the button posted a payload its own parser
  // did not understand and every press answered "кнопка устарела". `n:t` is matched above,
  // so a workspace whose id happens to be `t` still resolves as the toggle.
  if (value.startsWith('n:')) {
    const workspaceId = value.slice(2)
    return workspaceId.length > 0 ? { kind: 'newInFolder', workspaceId } : { kind: 'unknown' }
  }
  if (value.startsWith('w:')) {
    const workspaceId = value.slice(2)
    return workspaceId.length > 0 ? { kind: 'workspace', workspaceId } : { kind: 'unknown' }
  }
  if (value.startsWith('c:')) {
    const sessionId = value.slice(2)
    return sessionId.length > 0 ? { kind: 'session', sessionId } : { kind: 'unknown' }
  }
  if (value.startsWith('l:')) {
    const count = Number(value.slice(2))
    return Number.isFinite(count) && count > 0 ? { kind: 'history', count } : { kind: 'unknown' }
  }
  if (value.startsWith('a:')) {
    const [, nonce, decision] = value.split(':')
    if (!nonce || (decision !== 'allow' && decision !== 'deny')) return { kind: 'unknown' }
    return { kind: 'approval', nonce, allow: decision === 'allow' }
  }
  return { kind: 'unknown' }
}

/** One inline button, or `null` when its payload would break the 64-byte cap. */
export function button(text, data) {
  if (!callbackFits(data)) return null
  return { text: truncate(text, MAX_BUTTON_TEXT), callback_data: data }
}

/** Keep only the buttons that survived the payload check. */
export function row(buttons) {
  return (buttons ?? []).filter((value) => value !== null && value !== undefined)
}

/**
 * Lay session buttons out two per row, which keeps a 15-row list tappable on a
 * phone without turning it into a wall of full-width bars.
 * @param entries - buttons already built.
 */
export function sessionRows(entries) {
  const rows = []
  for (let index = 0; index < entries.length; index += 2) {
    const pair = row(entries.slice(index, index + 2))
    if (pair.length > 0) rows.push(pair)
  }
  return rows
}

/**
 * Assemble a keyboard and refuse to ship one Telegram would reject.
 *
 * Exceeding the per-message button budget means a renderer miscounted, and
 * shipping it would fail the whole `sendMessage` — so the tail is dropped and
 * the navigation row, which is always last and always essential, is kept.
 * @param rows - keyboard rows.
 * @returns the rows, or `undefined` when there is nothing to send.
 */
export function assemble(rows) {
  const filled = (rows ?? []).filter((value) => Array.isArray(value) && value.length > 0)
  if (filled.length === 0) return undefined
  const total = filled.reduce((sum, value) => sum + value.length, 0)
  if (total <= MAX_BUTTONS_PER_MESSAGE) return filled
  const navigation = filled[filled.length - 1]
  const kept = []
  let used = navigation.length
  for (const value of filled.slice(0, -1)) {
    if (used + value.length > MAX_BUTTONS_PER_MESSAGE) break
    kept.push(value)
    used += value.length
  }
  return [...kept, navigation]
}

/**
 * The persistent reply keyboard: one `🏠 Меню` button, always under the thumb (§2).
 *
 * A function rather than a constant, because the label is copy: it is what the owner taps and
 * what comes back as a plain message, so it has to match the language the bot is speaking.
 * @param t - translator.
 * @returns the reply keyboard.
 */
export function menuReplyKeyboard(t = defaultTranslator) {
  return [[{ text: t('btn.menu') }]]
}

/**
 * The label that reply-keyboard button sends back as a plain message, in one language.
 * @param t - translator.
 * @returns the label.
 */
export function menuReplyLabel(t = defaultTranslator) {
  return t('btn.menu')
}
