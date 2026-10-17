/**
 * Pairing and Mini App authentication for dsh-telegram-app.
 *
 * Two independent factors guard every request:
 *
 * 1. Telegram's own signature. `Telegram.WebApp.initData` is signed by Telegram
 *    with a key derived from the bot token, so only somebody who actually opened
 *    the Mini App from this bot can produce a valid payload. The algorithm is the
 *    documented one: the data-check string is every received field except `hash`
 *    (and `signature`) sorted alphabetically as `key=value` joined by "\n",
 *    `secret_key = HMAC_SHA256(<bot_token>, "WebAppData")`, and the payload is
 *    authentic when `hex(HMAC_SHA256(<data_check_string>, secret_key)) === hash`.
 *
 * 2. The control token the operator typed by hand. It is compared in constant
 *    time against the configured value, and only a successful comparison writes
 *    the Telegram chat id into the pairing file.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Mini App payloads older than this are refused, so a leaked payload ages out. */
export const INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60

/** Compare two strings without leaking their common prefix length. */
export function safeEqual(a, b) {
  const left = createHash('sha256').update(String(a)).digest()
  const right = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(left, right)
}

/** Hash a token for storage or for log-safe diagnostics. */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

/**
 * Build the data-check string Telegram signs.
 * @param params - parsed initData query parameters.
 * @param options.excludeSignature - drop the third-party `signature` field as well as `hash`.
 * @returns alphabetically sorted `key=value` pairs joined by "\n".
 */
export function dataCheckString(params, { excludeSignature = true } = {}) {
  const pairs = []
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue
    if (excludeSignature && key === 'signature') continue
    pairs.push(`${key}=${value}`)
  }
  pairs.sort()
  return pairs.join('\n')
}

/**
 * Verify one `Telegram.WebApp.initData` payload.
 *
 * Both accepted spellings of the data-check string are tried: with `signature`
 * excluded (what the Mini Apps documentation describes) and with it included
 * (older payloads that predate the field). A payload passes when either matches.
 *
 * @param initData - raw `Telegram.WebApp.initData` string.
 * @param botToken - BotFather token of the same bot.
 * @param options.maxAgeSec - refuse payloads older than this; `0` disables the check.
 * @param options.now - clock in milliseconds, injectable for tests.
 * @returns `{ ok: true, userId, chatId, chatType, username, firstName, authDate, startParam }`
 *   or `{ ok: false, error }`.
 */
export function validateInitData(initData, botToken, { maxAgeSec = INIT_DATA_MAX_AGE_SEC, now = Date.now() } = {}) {
  if (typeof initData !== 'string' || initData.length === 0) return { ok: false, error: 'initData is empty' }
  if (!botToken) return { ok: false, error: 'bot token is not configured' }

  let params
  try {
    params = new URLSearchParams(initData)
  } catch {
    return { ok: false, error: 'initData is malformed' }
  }

  const hash = params.get('hash')
  if (!hash) return { ok: false, error: 'initData has no hash' }

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
  const signatureOf = (excludeSignature) =>
    createHmac('sha256', secret).update(dataCheckString(params, { excludeSignature })).digest('hex')

  if (signatureOf(true) !== hash && signatureOf(false) !== hash) {
    return { ok: false, error: 'initData signature mismatch' }
  }

  const authDate = Number(params.get('auth_date'))
  if (!Number.isFinite(authDate)) return { ok: false, error: 'initData has no auth_date' }
  if (maxAgeSec > 0 && now / 1000 - authDate > maxAgeSec) return { ok: false, error: 'initData is expired' }

  let user = null
  let chat = null
  try {
    user = params.get('user') ? JSON.parse(params.get('user')) : null
  } catch {
    return { ok: false, error: 'initData user is malformed' }
  }
  try {
    chat = params.get('chat') ? JSON.parse(params.get('chat')) : null
  } catch {
    chat = null
  }

  const userId = Number(user?.id)
  if (!Number.isFinite(userId)) return { ok: false, error: 'initData carries no user' }

  const chatType = params.get('chat_type') ?? chat?.type ?? 'private'
  const chatId = Number.isFinite(Number(chat?.id)) ? Number(chat.id) : userId

  return {
    ok: true,
    userId,
    chatId,
    chatType,
    username: typeof user?.username === 'string' ? user.username : undefined,
    firstName: typeof user?.first_name === 'string' ? user.first_name : undefined,
    authDate,
    startParam: params.get('start_param') ?? null,
  }
}

/**
 * Durable pairing state: which Telegram chats this Harness may talk to.
 *
 * The file is written atomically with mode 0600 and only ever records the
 * control-token digest, never the token itself.
 */
export class PairingStore {
  /**
   * @param options.file - absolute path of the pairing file.
   * @param options.logger - optional logger.
   */
  constructor({ file, logger } = {}) {
    this.file = file
    this.logger = logger
    this.state = { version: 1, controlTokenHash: null, users: [], chats: [], pairedAt: null }
  }

  /** Read the file when present; a missing or unreadable file is an empty pairing. */
  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        this.state = {
          version: 1,
          controlTokenHash: typeof parsed.controlTokenHash === 'string' ? parsed.controlTokenHash : null,
          users: Array.isArray(parsed.users) ? parsed.users.filter(Number.isFinite) : [],
          chats: Array.isArray(parsed.chats) ? parsed.chats.filter(Number.isFinite) : [],
          pairedAt: typeof parsed.pairedAt === 'number' ? parsed.pairedAt : null,
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn?.('pairing file is unreadable', { error: String(error) })
    }
    return this.state
  }

  /** Persist the current state atomically. */
  save() {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    try {
      fs.chmodSync(this.file, 0o600)
    } catch {
      /* Windows has no POSIX bits; the ACL of the profile directory applies. */
    }
  }

  /** Whether a chat id was paired. */
  hasChat(chatId) {
    return this.state.chats.includes(Number(chatId))
  }

  /** Every paired chat id. */
  chats() {
    return [...this.state.chats]
  }

  /**
   * Record one successful pairing.
   * @param controlToken - the token the caller proved knowledge of.
   * @param identity - `{ userId, chatId }` from the validated Mini App payload.
   * @returns true when the state changed.
   */
  pair(controlToken, { userId, chatId }) {
    const digest = hashToken(controlToken)
    let changed = false
    if (this.state.controlTokenHash !== digest) {
      this.state.controlTokenHash = digest
      changed = true
    }
    if (!this.state.users.includes(userId)) {
      this.state.users.push(userId)
      changed = true
    }
    if (!this.state.chats.includes(chatId)) {
      this.state.chats.push(chatId)
      changed = true
    }
    if (changed) {
      this.state.pairedAt = Date.now()
      this.save()
    }
    return changed
  }
}

/**
 * Short-lived bearer tokens handed to an authenticated Mini App session so the
 * client does not have to replay `initData` (and the control token) on every call.
 */
export class SessionTokens {
  /** @param options.ttlSec - lifetime of one issued token. */
  constructor({ ttlSec = 12 * 60 * 60 } = {}) {
    this.ttlSec = ttlSec
    this.byToken = new Map()
  }

  /** Issue a token bound to one Telegram identity. */
  issue(claim) {
    const token = randomBytes(32).toString('base64url')
    this.byToken.set(token, { ...claim, expiresAt: Date.now() + this.ttlSec * 1000 })
    return token
  }

  /** Resolve a token, dropping it once expired. */
  verify(token) {
    if (typeof token !== 'string' || token.length === 0) return null
    const claim = this.byToken.get(token)
    if (!claim) return null
    if (claim.expiresAt <= Date.now()) {
      this.byToken.delete(token)
      return null
    }
    return claim
  }

  /** Forget every issued token, e.g. after the control token changed. */
  clear() {
    this.byToken.clear()
  }
}
