/**
 * Plain-text rendering helpers for the Telegram screens.
 *
 * Telegram is deliberately treated as a *plain text* surface: no `parse_mode`
 * is ever set, because agent answers are full of `_ * [ ] \`` which would either
 * break the message or silently mangle it. Everything here therefore works on
 * raw characters, and every limit below is a hard platform limit from §10 of
 * the specification.
 */

/** Telegram's own limit for one text message body. */
export const MAX_MESSAGE_LENGTH = 4096

/** Telegram's practical limit for one inline button label. */
export const MAX_BUTTON_TEXT = 40

/** Telegram's limit for one message's inline keyboard, expressed in buttons. */
export const MAX_BUTTONS_PER_MESSAGE = 30

/** Telegram's hard limit for one `callback_data` payload. */
export const MAX_CALLBACK_BYTES = 64

/** Session titles longer than this are cut in list rows (§5). */
export const MAX_TITLE = 48

/** The last answer preview on L3 is cut to this many characters (§5). */
export const MAX_LAST_ANSWER = 200

/**
 * How much of one message the history screen prints.
 *
 * Effectively "all of it": Telegram's own message limit is
 * {@link MAX_MESSAGE_LENGTH}, and the transport splits a longer body losslessly, so the
 * only reason to cut here would be a limit the bridge invents. An earlier value of 400 did
 * exactly that — a long answer arrived with its conclusion replaced by `…`, which reads as
 * a broken answer rather than a shortened one. The owner asked for the whole message, and
 * the transport can already deliver it.
 */
export const MAX_HISTORY_LINE = 4000

/** An id is shown as `first8…last2`, so this is the number of leading characters. */
const ID_HEAD = 8

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Cut a string to `limit` code points, appending an ellipsis when it was cut.
 * Counting code points (not UTF-16 units) keeps an emoji from being sliced in half.
 */
export function truncate(text, limit) {
  const points = [...String(text ?? '')]
  if (points.length <= limit) return String(text ?? '')
  if (limit <= 1) return points.slice(0, Math.max(0, limit)).join('')
  return `${points.slice(0, limit - 1).join('')}…`
}

/**
 * Cut a string to `limit` code points without adding an ellipsis.
 *
 * Some screens already print their own `«…»` decoration, where a second
 * ellipsis would read as part of the agent's answer rather than as our cut.
 */
export function cut(text, limit) {
  const points = [...String(text ?? '')]
  return points.length <= limit ? String(text ?? '') : points.slice(0, Math.max(0, limit)).join('')
}

/**
 * Collapse whitespace so a multi-line agent answer fits on one screen line.
 * @param text - source text, possibly containing code blocks or blank lines.
 * @param limit - maximum code points in the result.
 */
export function oneLine(text, limit = Number.MAX_SAFE_INTEGER) {
  const flat = String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
  return limit === Number.MAX_SAFE_INTEGER ? flat : cut(flat, limit)
}

/**
 * Tidy a message for reading in a chat: keep its paragraphs, drop the noise.
 *
 * `oneLine` is right for a label and wrong for an answer. Flattening a long reply into one
 * paragraph turns headings, lists and code into an unreadable run — and the transport can
 * carry newlines and split a long body losslessly, so there is nothing to gain by removing
 * them. Whitespace inside a line is collapsed; blank runs collapse to one blank line.
 *
 * @param text - source text.
 * @returns the text with paragraph structure intact.
 */
export function asMessage(text) {
  return String(text ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** Two-digit zero-padded month/day rendering shared by the date stamps. */
function stampOf(date, now) {
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  return date.getFullYear() === now.getFullYear() ? `${day}.${month}` : `${day}.${month}.${date.getFullYear()}`
}

/**
 * Relative time in the wording the screens use: `5 мин`, `2 ч`, `3 дн`, `12.10`.
 *
 * Distances under a minute read as `только что` rather than `0 мин`, because a
 * row saying "0 min" looks like a rounding bug to the person reading it.
 *
 * @param timestamp - epoch milliseconds, or a `Date`.
 * @param options.now - injectable clock in milliseconds.
 * @param options.suffix - append ` назад` (list rows) or leave it bare (headers).
 * @returns the relative label.
 */
export function relativeTime(timestamp, { now = Date.now(), suffix = false } = {}) {
  const value = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp)
  if (!Number.isFinite(value) || value <= 0) return '—'
  const tail = suffix ? ' назад' : ''
  const seconds = Math.round((now - value) / 1000)
  if (seconds < MINUTE) return 'только что'
  const minutes = Math.floor(seconds / MINUTE)
  if (minutes < 60) return `${minutes} мин${tail}`
  const hours = Math.floor(seconds / HOUR)
  if (hours < 24) return `${hours} ч${tail}`
  const days = Math.floor(seconds / DAY)
  if (days < 7) return `${days} дн${tail}`
  return stampOf(new Date(value), new Date(now))
}

/**
 * Turn duration as the idle notification prints it: `45 с`, `1 мин 20 с`, `2 ч 5 мин`.
 * @param seconds - whole seconds the turn ran.
 */
export function runDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  if (total < MINUTE) return `${total} с`
  if (total < HOUR) {
    const minutes = Math.floor(total / MINUTE)
    const rest = total % MINUTE
    return rest === 0 ? `${minutes} мин` : `${minutes} мин ${rest} с`
  }
  const hours = Math.floor(total / HOUR)
  const minutes = Math.floor((total % HOUR) / MINUTE)
  return minutes === 0 ? `${hours} ч` : `${hours} ч ${minutes} мин`
}

/** An id as the screens show it: `6f1c…a3`. */
export function shortId(sessionId) {
  const value = String(sessionId ?? '')
  if (value.length <= ID_HEAD + 2) return value
  return `${value.slice(0, ID_HEAD)}…${value.slice(-2)}`
}

/**
 * Split text so every part fits the Telegram limit, preferring a line break.
 * Lossless: joining the parts returns the original text.
 * @param text - source text.
 * @param limit - maximum code units per part.
 * @returns one or more parts.
 */
export function splitMessage(text, limit = MAX_MESSAGE_LENGTH) {
  const value = String(text ?? '')
  if (value.length <= limit) return [value]
  const parts = []
  let rest = value
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const breakAt = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '))
    const end = breakAt > limit * 0.5 ? breakAt + 1 : limit
    parts.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest.length > 0) parts.push(rest)
  return parts
}

/**
 * Whether a `callback_data` payload fits Telegram's byte budget (§7, §10).
 * @param data - candidate payload.
 */
export function callbackFits(data) {
  return Buffer.byteLength(String(data ?? ''), 'utf8') <= MAX_CALLBACK_BYTES
}

/**
 * Join screen lines, dropping the *absent* blocks but keeping an intentional
 * blank line as a paragraph break.
 *
 * The distinction matters: a block that is not there (no current chat binding,
 * no answer yet) must leave no gap behind, while the blank line between a
 * screen's heading and its list is part of the layout in §5. A blank string is
 * therefore kept; only `undefined` and `null` — the shape a conditional block
 * takes — are removed.
 */
export function joinLines(lines) {
  return lines.filter((line) => line !== undefined && line !== null).join('\n')
}

/** Count inline keyboard buttons, for the ≤ 30 budget of §10. */
export function countButtons(rows) {
  return (rows ?? []).reduce((total, row) => total + row.length, 0)
}
