/**
 * Durable state of the chat layer: `<DSH_HOME>/telegram-app/state.json`, schema v1.
 *
 * One file carries everything the bot must remember across restarts — which
 * chats passed the control token, which Session each chat is aimed at, each
 * chat's screen settings, and which Sessions the bot itself created (so their
 * rows can carry the 📱 mark). It supersedes the narrower pairing file the Mini
 * App layer used, and still reads that older shape without losing a pairing.
 *
 * Two invariants matter and are enforced here rather than at the call sites:
 *
 * 1. The control token itself is never written. Only its SHA-256 digest is,
 *    which is enough to detect "the operator rotated the token" without putting
 *    the secret on disk (§9, §11).
 * 2. Every write is atomic — a temporary file in the same directory renamed
 *    over the target — so a crash mid-write cannot truncate the state.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Selectable values for "how many chats to show in a folder" (§5). */
export const SESSION_LIMITS = Object.freeze([3, 5, 10, 15])

/** Selectable values for the workspace ordering on L1 (§4). */
export const WORKSPACE_SORTS = Object.freeze(['registry', 'activity'])

/** Built-in defaults, used when neither the chat nor the plugin config says otherwise. */
export const DEFAULT_SETTINGS = Object.freeze({
  sessionLimit: 5,
  workspaceSort: 'registry',
  notify: true,
})

/** SHA-256 digest of a token, as stored in `controlTokenHash`. */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

/**
 * Coerce any id-ish value to a finite integer, or `null`.
 *
 * `null`, `undefined`, `''` and booleans are rejected explicitly rather than
 * through `Number()`, because `Number(null)` is `0` and `Number(true)` is `1` —
 * a corrupt file must not be able to invent chat 0 or chat 1 out of an absent
 * field. Telegram user and chat ids are positive, so a negative value is
 * rejected too.
 */
function asId(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
    const parsed = Number(value.trim())
    return parsed > 0 ? parsed : null
  }
  return null
}

/** Keep only finite numbers, de-duplicated, order preserved. */
function idList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    const id = asId(item)
    if (id === null || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** Keep only non-empty strings, de-duplicated, order preserved. */
function stringList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** Whether a plain-object value (not an array) carries at least one field. */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate one chat's settings block, falling back per field.
 *
 * The fallbacks are the plugin-config defaults, so a chat that never opened the
 * settings screen keeps following the DSH-side form when the operator changes
 * it there (§5, "приоритет значений").
 *
 * @param raw - stored value, possibly partial or corrupt.
 * @param fallback - plugin-config defaults.
 * @returns a complete settings record.
 */
export function normalizeSettings(raw, fallback = DEFAULT_SETTINGS) {
  const source = isPlainObject(raw) ? raw : {}
  const limit = Number(source.sessionLimit)
  const sort = typeof source.workspaceSort === 'string' ? source.workspaceSort : ''
  const notify = typeof source.notify === 'boolean' ? source.notify : undefined
  return {
    sessionLimit: SESSION_LIMITS.includes(limit) ? limit : fallback.sessionLimit,
    workspaceSort: WORKSPACE_SORTS.includes(sort) ? sort : fallback.workspaceSort,
    notify: notify ?? fallback.notify,
  }
}

/**
 * The bot's durable state.
 *
 * A single instance owns the file. Every mutating method persists immediately,
 * so durability is never left to a caller remembering to `save()`.
 */
export class StateStore {
  /**
   * @param options.file - absolute path of `state.json`.
   * @param options.logger - optional logger.
   * @param options.defaults - plugin-config defaults for per-chat settings.
   */
  constructor({ file, logger, defaults = DEFAULT_SETTINGS } = {}) {
    this.file = file
    this.logger = logger
    this.defaults = { ...DEFAULT_SETTINGS, ...defaults }
    this.state = StateStore.empty()
  }

  /** A fresh, empty schema-v1 state. */
  static empty() {
    return {
      version: 1,
      controlTokenHash: null,
      users: [],
      chats: [],
      bindings: {},
      settings: {},
      pairedAtByChat: {},
      pairedAtLegacy: 0,
      createdByBot: [],
      updatedAt: 0,
    }
  }

  /**
   * Read the file, tolerating both the current schema and the older
   * pairing-only shape written by the Mini App layer.
   * @returns the loaded state.
   */
  load() {
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger?.warn?.('state file is unreadable', { error: String(error) })
      this.state = StateStore.empty()
      return this.state
    }
    this.state = this.toState(parsed)
    return this.state
  }

  /** Normalize one parsed document into a complete state object. */
  toState(parsed) {
    const source = isPlainObject(parsed) ? parsed : {}
    const state = StateStore.empty()

    state.controlTokenHash = typeof source.controlTokenHash === 'string' ? source.controlTokenHash : null
    state.users = idList(source.users)
    state.chats = idList(source.chats)
    state.createdByBot = stringList(source.createdByBot)
    state.updatedAt = Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : 0

    if (isPlainObject(source.bindings)) {
      for (const [key, value] of Object.entries(source.bindings)) {
        const chatId = asId(key)
        const sessionId = typeof value?.sessionId === 'string' && value.sessionId.length > 0 ? value.sessionId : null
        if (chatId === null || sessionId === null) continue
        state.bindings[chatId] = {
          sessionId,
          workspaceId: typeof value?.workspaceId === 'string' && value.workspaceId.length > 0 ? value.workspaceId : null,
          boundAt: Number.isFinite(Number(value?.boundAt)) ? Number(value.boundAt) : 0,
        }
      }
    }

    // A file written before per-chat settings existed carries only the flat
    // `notify` map; fold it into the settings block so the switch survives.
    const notifyMap = isPlainObject(source.notify) ? source.notify : {}
    if (isPlainObject(source.settings)) {
      for (const [key, value] of Object.entries(source.settings)) {
        const chatId = asId(key)
        if (chatId === null) continue
        const needsFold = isPlainObject(value) && typeof value.notify !== 'boolean' && typeof notifyMap[key] === 'boolean'
        state.settings[chatId] = normalizeSettings(needsFold ? { ...value, notify: notifyMap[key] } : value, this.defaults)
      }
    }
    for (const [key, value] of Object.entries(notifyMap)) {
      const chatId = asId(key)
      if (chatId === null || state.settings[chatId] !== undefined || typeof value !== 'boolean') continue
      state.settings[chatId] = normalizeSettings({ notify: value }, this.defaults)
    }

    // Per-chat authorization instants. The older file carried a single
    // `pairedAt` for the whole store, which becomes the fallback for every chat.
    state.pairedAtLegacy = Number.isFinite(Number(source.pairedAt)) && Number(source.pairedAt) > 0 ? Number(source.pairedAt) : 0
    if (isPlainObject(source.pairedAtByChat)) {
      for (const [key, value] of Object.entries(source.pairedAtByChat)) {
        const chatId = asId(key)
        const at = Number(value)
        if (chatId === null || !Number.isFinite(at) || at <= 0) continue
        state.pairedAtByChat[chatId] = at
      }
    }
    return state
  }

  /** Write the state atomically with owner-only permissions. */
  save() {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true })
    this.state.updatedAt = Date.now()
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    try {
      fs.chmodSync(this.file, 0o600)
    } catch {
      /* Windows has no POSIX bits; the ACL of the profile directory applies. */
    }
  }

  // ── Pairing (§6, §11) ─────────────────────────────────────────────────────

  /** Whether this chat passed the control token. */
  hasChat(chatId) {
    return this.state.chats.includes(Number(chatId))
  }

  /** Whether this user id is on the allow-list. */
  hasUser(userId) {
    return this.state.users.includes(Number(userId))
  }

  /** Every paired chat id. */
  chats() {
    return [...this.state.chats]
  }

  /** Whether a control token has ever been recorded. */
  hasControlToken() {
    return typeof this.state.controlTokenHash === 'string' && this.state.controlTokenHash.length > 0
  }

  /** Whether the stored digest matches this control token. */
  matchesControlToken(token) {
    if (typeof this.state.controlTokenHash !== 'string' || this.state.controlTokenHash.length === 0) return false
    return this.state.controlTokenHash === hashToken(token)
  }

  /**
   * Record the control token's digest without touching chat bindings.
   *
   * Called on first run (the token is generated, not configured) and whenever
   * the operator rotates it in the DSH form. Rotating must not un-pair the
   * chats that already proved knowledge of the old one (§9).
   *
   * @param token - the control token.
   * @returns whether the digest changed.
   */
  setControlToken(token) {
    const digest = hashToken(token)
    if (this.state.controlTokenHash === digest) return false
    this.state.controlTokenHash = digest
    this.save()
    return true
  }

  /**
   * Authorize one chat.
   * @param identity - `{ userId, chatId, pairedAt }`.
   * @returns whether the state changed.
   */
  pair({ userId, chatId, pairedAt = Date.now() }) {
    const chat = asId(chatId)
    const user = asId(userId)
    if (chat === null) return false
    let changed = false
    if (user !== null && !this.state.users.includes(user)) {
      this.state.users.push(user)
      changed = true
    }
    if (!this.state.chats.includes(chat)) {
      this.state.chats.push(chat)
      changed = true
    }
    if (this.state.pairedAtByChat[chat] === undefined) {
      this.state.pairedAtByChat[chat] = pairedAt
      changed = true
    }
    if (changed) this.save()
    return changed
  }

  /** When this chat was authorized, for the L0 line. */
  pairedAt(chatId) {
    const chat = asId(chatId)
    if (chat !== null && this.state.pairedAtByChat[chat] !== undefined) return this.state.pairedAtByChat[chat]
    return this.state.pairedAtLegacy ?? 0
  }

  /**
   * Revoke one chat's authorization and forget everything tied to it.
   * @param chatId - the chat to drop.
   * @returns whether the state changed.
   */
  unpair(chatId) {
    const chat = asId(chatId)
    if (chat === null || !this.state.chats.includes(chat)) return false
    this.state.chats = this.state.chats.filter((id) => id !== chat)
    delete this.state.bindings[chat]
    delete this.state.settings[chat]
    delete this.state.pairedAtByChat[chat]
    // A user id is kept only while some chat still belongs to it.
    const boundOwners = Object.keys(this.state.bindings).map(Number)
    this.state.users = this.state.users.filter((user) => this.state.chats.includes(user) || boundOwners.includes(user))
    this.save()
    return true
  }

  // ── Session binding (§5, §14) ─────────────────────────────────────────────

  /** The Session this chat currently writes into, or `null`. */
  binding(chatId) {
    const chat = asId(chatId)
    return chat === null ? null : (this.state.bindings[chat] ?? null)
  }

  /** The bound Session id, or `null`. */
  boundSessionId(chatId) {
    return this.binding(chatId)?.sessionId ?? null
  }

  /**
   * Aim one chat at a Session.
   * @param chatId - the Telegram chat.
   * @param sessionId - the Harness Session.
   * @param options.workspaceId - the folder `[⬅️ К чатам]` returns to.
   * @returns whether the binding changed.
   */
  bindSession(chatId, sessionId, { workspaceId = null, boundAt = Date.now() } = {}) {
    const chat = asId(chatId)
    if (chat === null || typeof sessionId !== 'string' || sessionId.length === 0) return false
    const current = this.state.bindings[chat]
    const next = {
      sessionId,
      workspaceId: typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : null,
      boundAt,
    }
    if (current && current.sessionId === next.sessionId && current.workspaceId === next.workspaceId) return false
    this.state.bindings[chat] = next
    this.save()
    return true
  }

  /** Drop one chat's Session binding; the Session itself is untouched (§6). */
  unbindSession(chatId) {
    const chat = asId(chatId)
    if (chat === null || this.state.bindings[chat] === undefined) return false
    delete this.state.bindings[chat]
    this.save()
    return true
  }

  // ── Per-chat settings (§5) ────────────────────────────────────────────────

  /** This chat's effective settings: chat override → plugin config → built-in. */
  settings(chatId) {
    const chat = asId(chatId)
    const stored = chat === null ? undefined : this.state.settings[chat]
    return normalizeSettings(stored, this.defaults)
  }

  /**
   * Apply one settings field for one chat; unknown values are refused rather
   * than stored, so a raw `callback_data` can never widen a limit.
   *
   * @param chatId - the Telegram chat.
   * @param key - `sessionLimit`, `workspaceSort`, or `notify`.
   * @param value - the new value.
   * @returns whether the state changed.
   */
  setSetting(chatId, key, value) {
    const chat = asId(chatId)
    if (chat === null) return false
    const current = this.settings(chat)
    const next = { ...current }
    if (key === 'sessionLimit') {
      const limit = Number(value)
      if (!SESSION_LIMITS.includes(limit)) return false
      next.sessionLimit = limit
    } else if (key === 'workspaceSort') {
      if (!WORKSPACE_SORTS.includes(value)) return false
      next.workspaceSort = value
    } else if (key === 'notify') {
      if (typeof value !== 'boolean') return false
      next.notify = value
    } else {
      return false
    }
    if (next.sessionLimit === current.sessionLimit && next.workspaceSort === current.workspaceSort && next.notify === current.notify) return false
    this.state.settings[chat] = next
    this.save()
    return true
  }

  /** Whether idle notifications go to this chat. */
  notifyEnabled(chatId) {
    return this.settings(chatId).notify === true
  }

  // ── Sessions created by the bot (§5, 📱 mark) ─────────────────────────────

  /** Remember that the bot created this Session. */
  markCreatedByBot(sessionId) {
    const id = String(sessionId ?? '')
    if (id.length === 0 || this.state.createdByBot.includes(id)) return false
    this.state.createdByBot.push(id)
    this.save()
    return true
  }

  /** Whether the bot created this Session. */
  isCreatedByBot(sessionId) {
    return this.state.createdByBot.includes(String(sessionId ?? ''))
  }

  /** Forget a Session the bot created, once it is gone from the registry. */
  forgetCreatedByBot(sessionId) {
    const id = String(sessionId ?? '')
    const before = this.state.createdByBot.length
    this.state.createdByBot = this.state.createdByBot.filter((value) => value !== id)
    if (this.state.createdByBot.length === before) return false
    this.save()
    return true
  }
}
