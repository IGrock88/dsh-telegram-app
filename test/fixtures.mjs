/**
 * Shared fixtures for the offline tests.
 *
 * The navigation layer canonicalizes paths with `fs.realpath`, so fixtures use
 * real directories in the OS temp area rather than invented strings — otherwise
 * the tests would exercise the "directory is gone" fallback everywhere and never
 * the comparison that actually runs in production.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Create one real temporary directory and return it. */
export function tempDir(prefix = 'dsh-tg-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** A Workspace record as `workspaceRegistry.list()` returns it. */
export function workspace(id, dir, title) {
  return {
    id,
    path: dir,
    title: title ?? path.basename(dir),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: [],
  }
}

/**
 * A `SessionSummary` as `sessionController.list()` returns it.
 *
 * `blank` rides inside the persisted list metadata projection, which is where
 * the real host puts it, so the fixture exercises the same read path.
 */
export function summary(sessionId, options = {}) {
  const {
    cwd,
    updatedAt = 1_700_000_000_000,
    running = false,
    title = null,
    blank = false,
    origin,
    parentSessionId,
  } = options
  const values = { sessionListMetadata: { blank, lastPromptAt: null } }
  if (title !== null) values.title = title
  const record = {
    sessionId,
    updatedAt,
    running,
    agentAvailable: true,
    blank,
    projections: { kind: 'sequenced', asOfSeq: 1, values },
  }
  if (cwd !== undefined) record.cwd = cwd
  if (origin !== undefined) record.origin = origin
  if (parentSessionId !== undefined) record.parentSessionId = parentSessionId
  return record
}

/**
 * A fake Telegram transport that records every call.
 *
 * Two properties make the assertions honest.
 *
 * First, screens are *edits* of one message rather than new messages (§2), so
 * the fake keeps one chronological journal of sends and edits. `lastTo` reads
 * that journal backwards, which is what the user's screen actually shows — an
 * assertion on `sendMessage` calls alone would miss every screen.
 *
 * Second, `editFails` reproduces the two ordinary Telegram refusals ("message is
 * not modified", "message to edit not found"), so the caller's fallback to a
 * fresh message is covered rather than assumed.
 */
export function fakeBot(options = {}) {
  const editFails = options.editFails === true
  const journal = []
  const sent = []
  const edits = []
  const answers = []
  let nextId = 100

  /** The newest journal entry for a chat, or `null`. */
  function visible(chatId) {
    for (let index = journal.length - 1; index >= 0; index -= 1) {
      if (Number(journal[index].chatId) === Number(chatId)) return journal[index]
    }
    return null
  }

  return {
    /** Chronological sends and edits, which is the order the chat saw them. */
    journal,
    sent,
    edits,
    answers,
    me: { id: 7, username: 'dsh_test_bot' },
    configured: true,
    /** The text this chat is showing now, after any edits. */
    lastTo: (chatId) => visible(chatId)?.text ?? null,
    /** Every text actually *sent* to a chat, in order; screens do not appear. */
    textsTo: (chatId) => sent.filter((entry) => Number(entry.chatId) === Number(chatId)).map((entry) => entry.text),
    /** The keyboard of the message the chat is showing now. */
    lastKeyboard: (chatId) => visible(chatId)?.keyboard ?? null,
    /** The text a message id currently shows, after any edits. */
    screenText(messageId) {
      for (let index = journal.length - 1; index >= 0; index -= 1) {
        if (journal[index].messageId === messageId && journal[index].kind === 'edit') return journal[index].text
      }
      return sent.find((entry) => entry.messageId === messageId)?.text ?? null
    },
    async sendMessage(chatId, text, sendOptions = {}) {
      nextId += 1
      const entry = { kind: 'send', chatId, text, messageId: nextId, keyboard: sendOptions.keyboard, replyKeyboard: sendOptions.replyKeyboard }
      journal.push(entry)
      sent.push(entry)
      return { message_id: nextId, chat: { id: chatId } }
    },
    async editMessageText(chatId, messageId, text, editOptions = {}) {
      const entry = { kind: 'edit', chatId, messageId, text, keyboard: editOptions.keyboard }
      journal.push(entry)
      edits.push(entry)
      return editFails ? undefined : { message_id: messageId, chat: { id: chatId } }
    },
    async answerCallbackQuery(id, text) {
      answers.push({ id, text })
      return true
    },
    async clearKeyboard(chatId, messageId) {
      journal.push({ kind: 'edit', chatId, messageId, text: null, cleared: true })
      return true
    },
    async whoami() {
      return this.me
    },
    async setCommands() {
      return true
    },
  }
}

/**
 * A fake `sessionController` face: exactly the calls the chat layer makes.
 *
 * This is the **raw** controller, shaped as the live one is: `list()` answers an envelope
 * with `items` (not a bare array), `prompt(request, signal)` requires a real signal, and
 * `cancel(request)` takes an object. Getting these shapes wrong is not a detail — with a
 * bare array the wrapper silently produced an empty session list, and without a signal
 * guard a `TypeError` reached the owner as the bot's reply, both with every test green.
 *
 * Production never hands this face to the chat layer: `index.js` wraps it in
 * `createSessionApi`, which supplies the signal and normalizes the shapes. Tests wrap it
 * too, so they exercise the call pattern the Host actually performs.
 *
 * @param options.summaries - what `list()` returns; the array is read live, so a
 *   test that creates a Session can push into it and see the new row.
 * @param options.history - per-session history pages.
 * @param options.onCreate - the create result, or a function of `(request, publish)`
 *   where `publish(summary)` adds the new Session to the live list.
 */
export function fakeSessions(options = {}) {
  const summaries = options.summaries ?? []
  const history = options.history ?? {}
  const onCreate = options.onCreate
  const calls = { list: 0, prompt: [], cancel: [], create: [] }

  /** Add a freshly created Session to the live list, newest first. */
  function publish(summaryRecord) {
    summaries.unshift(summaryRecord)
    return summaryRecord
  }

  /**
   * Reject a signal the real Host would dereference.
   *
   * The live `SessionController.prompt` opens with `signal.throwIfAborted()` — no optional
   * chaining — so passing nothing is not a soft failure: it throws a TypeError whose text
   * ("Cannot read properties of undefined") reached the owner as the bot's reply. This
   * fake enforced nothing, so the plugin shipped that bug with every test green.
   */
  const requireSignal = (signal, method) => {
    if (signal === undefined || signal === null) {
      throw new TypeError(`Cannot read properties of ${String(signal)} (reading 'throwIfAborted') [fake ${method} guard]`)
    }
    if (typeof signal.throwIfAborted !== 'function') {
      throw new TypeError(`signal.throwIfAborted is not a function [fake ${method} guard]`)
    }
    signal.throwIfAborted()
  }

  return {
    calls,
    publish,
    // The live `list` answers an envelope carrying **raw** `SessionSummary` records —
    // `projections` included, because the view builder reads `sessionListMetadata.blank`
    // from them. A bare array here silently became an empty session list with no error,
    // and dropping `projections` cost every session its title.
    async list(_request, signal) {
      // `SessionController.list` guards with `signal?.`, so a missing signal is legal
      // here; a signal that is present must still be the real thing.
      if (signal !== undefined) requireSignal(signal, 'list')
      calls.list += 1
      return { items: summaries }
    },
    /**
     * The `follow` opening snapshot, which is the documented source of a log cut.
     *
     * `cursor` is the last event seq of the Session, or `-1` for an empty log — the Host's
     * own value. The plugin reads it to build `throughSeq`, so a fake without this iterator
     * cannot exercise the history path at all.
     */
    follow(request, signal) {
      requireSignal(signal, 'follow')
      const key = request?.address?.sessionId
      const records = history[key]?.records ?? []
      const cursor = records.length > 0 ? records.length - 1 : -1
      let done = false
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              if (done) return { done: true, value: undefined }
              done = true
              return { done: false, value: { type: 'snapshot', cursor, records } }
            },
            return: async () => ({ done: true, value: undefined }),
          }
        },
      }
    },
    async page(request, signal) {
      // The live `SessionHistoryController.page` dereferences its signal unguarded, so
      // this fake must too — that guard is the whole reason the plugin passes one.
      requireSignal(signal, 'page')
      // And it validates `throughSeq` against the real log cursor, refusing anything past
      // it. Without this the fake accepted `Number.MAX_SAFE_INTEGER`, which production
      // rejects with "session page through seq … is past cursor …".
      const all = history[request?.address?.sessionId]?.records ?? []
      const cursor = all.length > 0 ? all.length - 1 : -1
      const through = request?.throughSeq
      if (!Number.isSafeInteger(through) || through < -1) {
        throw new Error('throughSeq must be an integer greater than or equal to -1 [fake guard]')
      }
      if (through > cursor) {
        throw new Error(`session page through seq ${String(through)} is past cursor ${String(cursor)} [fake guard]`)
      }
      // The window arithmetic of `paginate`, which is what made `throughSeq: -1` answer an
      // empty page instead of failing: `end = min(throughSeq + 1, beforeSeq ?? throughSeq + 1)`.
      // Without this the fake returned the records regardless and could not observe that bug.
      const before = request?.beforeSeq
      const end = Math.max(0, Math.trunc(Math.min(through + 1, before ?? through + 1)))
      const maxMessages = Number.isSafeInteger(request?.maxMessages) ? request.maxMessages : 60
      const start = Math.max(0, end - maxMessages)
      return { records: all.slice(start, end), hasMore: start > 0 }
    },
    async history(sessionId) {
      return history[sessionId] ?? { records: [], hasMore: false }
    },
    // The raw shapes: `prompt(request, signal)` as the Host declares it, and
    // `cancel(request)`.
    async prompt(request, signal) {
      requireSignal(signal, 'prompt')
      calls.prompt.push({ request, sessionId: request?.sessionId, text: request?.content?.[0]?.text })
      return { accepted: true }
    },
    async cancel(request) {
      calls.cancel.push(request?.sessionId)
      return { accepted: true }
    },
    async create(request) {
      calls.create.push(request)
      return onCreate ? onCreate(request, publish) : { sessionId: 'session-new' }
    },
    hub: { closeAll() {} },
  }
}

/** A fake workspace registry reader, shaped like the one `index.js` builds. */
export function fakeRegistry(options = {}) {
  const workspaces = options.workspaces ?? []
  const archived = options.archived ?? []
  return {
    available: () => true,
    workspaces: () => workspaces,
    archivedSessionIds: () => archived,
  }
}

/** Build a Telegram message update body for a private, single-user chat. */
export function message(chatId, text, options = {}) {
  return {
    message_id: options.messageId ?? 1,
    chat: { id: chatId, type: options.type ?? 'private' },
    from: { id: options.userId ?? chatId, is_bot: false },
    text,
  }
}

/** Build a Telegram callback-query update body. */
export function callback(chatId, data, options = {}) {
  return {
    id: `cb-${data}`,
    data,
    from: { id: options.userId ?? chatId, is_bot: false },
    message: { message_id: options.messageId ?? 55, chat: { id: chatId, type: 'private' } },
  }
}

/** Collect `{ warn, info, debug }` calls so tests can assert on logging. */
export function fakeLogger() {
  const entries = { warn: [], info: [], debug: [] }
  return {
    entries,
    warn: (...args) => entries.warn.push(args),
    info: (...args) => entries.info.push(args),
    debug: (...args) => entries.debug.push(args),
  }
}
