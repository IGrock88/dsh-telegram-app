/**
 * Thin, defensive wrapper over the Harness Session API (`ctx.sessionController`).
 *
 * The Mini App is a remote control surface for the same Sessions the Web UI
 * shows, so every call here goes through the very service the Web UI uses:
 * cold Sessions are resumed by the controller itself, and prompts are admitted
 * with the same queue semantics.
 *
 * The controller is looked up lazily so that a host without it degrades into a
 * clear API error instead of a failed plugin mount.
 */

/**
 * How long a prompt may spend being *admitted* into a Session.
 *
 * The controller requires a live `AbortSignal` on `prompt` and dereferences it without a
 * guard, so this is also what the plugin passes when it has no signal of its own. It
 * bounds admission only — resuming a cold Agent and validating content — never the turn,
 * which runs for as long as it needs.
 */
const PROMPT_ADMISSION_TIMEOUT_MS = 30_000

/**
 * How long one history page may spend being read.
 *
 * `SessionHistoryController.page` also dereferences its signal unguarded — it calls
 * `signal.throwIfAborted()` right after awaiting the log source — so the same rule
 * applies there: never hand it `undefined`.
 */
const HISTORY_READ_TIMEOUT_MS = 15_000

/**
 * A cancellation signal the controller will accept.
 *
 * Two Host methods — `SessionController.prompt` and `SessionHistoryController.page` —
 * call `signal.throwIfAborted()` with no optional chaining, so omitting the signal is not
 * a graceful degradation: it throws a `TypeError` reading "Cannot read properties of
 * undefined", and that developer string is what the owner sees in the chat. The other
 * methods guard with `signal?.`, which is why only these two need care — and why the care
 * belongs in one place rather than at each call site.
 *
 * @param signal - the caller's signal, when it has one.
 * @param timeoutMs - ceiling for this call.
 * @returns the caller's signal, or a fresh timeout signal.
 */
function requestSignal(signal, timeoutMs) {
  return signal ?? AbortSignal.timeout(timeoutMs)
}

/** Short label for a session id, used when no title is available. */
export function shortId(sessionId) {
  const value = String(sessionId ?? '')
  return value.length > 8 ? value.slice(0, 8) : value
}

/** Read the first available title out of a session summary's projections. */
export function titleOf(summary) {
  const values = summary?.projections?.values
  if (values && typeof values === 'object') {
    for (const key of ['title', 'sessionTitle', 'name']) {
      const value = values[key]
      if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    }
  }
  return null
}

/**
 * One live `follow` stream per Session, drained by short HTTP polls.
 *
 * `follow` is the controller's own gap-free event feed: the first frame is a
 * snapshot, later frames are durable events and live assistant chunks. Because
 * it is an async iterator rather than a queue, this hub keeps one iterator per
 * Session and buffers frames so several polls (and a reconnecting phone) can
 * read without restarting the stream.
 */
class StreamHub {
  constructor({ logger, bufferLimit = 5000 }) {
    this.logger = logger
    this.bufferLimit = bufferLimit
    this.streams = new Map()
  }

  /** Start or reuse the stream of one Session. */
  ensure(controller, sessionId) {
    const existing = this.streams.get(sessionId)
    if (existing) return existing

    const abort = new AbortController()
    const entry = { frames: [], waiters: new Set(), abort, closed: false, cursor: 0, snapshotSeen: false }
    let markSnapshotReady
    entry.snapshotReady = new Promise((resolve) => {
      markSnapshotReady = resolve
    })
    this.streams.set(sessionId, entry)

    const pump = async () => {
      try {
        const iterator = controller.follow(
          { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 200 },
          abort.signal,
        )
        for await (const frame of iterator) {
          entry.frames.push(frame)
          if (frame?.type === 'snapshot' && typeof frame.cursor === 'number') {
            entry.cursor = frame.cursor
            entry.snapshotSeen = true
            markSnapshotReady()
          }
          if (entry.frames.length > this.bufferLimit) entry.frames.splice(0, entry.frames.length - this.bufferLimit)
          for (const wake of entry.waiters) wake()
        }
      } catch (error) {
        if (!abort.signal.aborted) this.logger?.warn?.('session stream ended', { sessionId: shortId(sessionId), error: String(error) })
      } finally {
        entry.closed = true
        this.streams.delete(sessionId)
        // A stream that dies before its snapshot must not leave a caller waiting forever.
        markSnapshotReady()
        for (const wake of entry.waiters) wake()
      }
    }
    void pump()
    return entry
  }

  /**
   * Wait for frames newer than `since` (an index into the buffer).
   * @param controller - the session controller.
   * @param sessionId - session to follow.
   * @param options.since - number of frames the caller already consumed.
   * @param options.timeoutMs - how long to wait for something new.
   * @returns `{ frames, next, closed }`.
   */
  async drain(controller, sessionId, { since = 0, timeoutMs = 20_000 } = {}) {
    const entry = this.ensure(controller, sessionId)
    const from = Number.isFinite(since) && since >= 0 ? Math.min(since, entry.frames.length) : 0
    if (entry.frames.length > from) return { frames: entry.frames.slice(from), next: entry.frames.length, closed: false }

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.waiters.delete(wake)
        resolve()
      }, timeoutMs)
      const wake = () => {
        clearTimeout(timer)
        entry.waiters.delete(wake)
        resolve()
      }
      entry.waiters.add(wake)
    })

    return { frames: entry.frames.slice(from), next: entry.frames.length, closed: entry.closed }
  }

  /**
   * The current log cursor of one Session, or `null` when it cannot be read.
   *
   * `SessionPageRequest.throughSeq` is an **inclusive log cut**, validated against the real
   * cursor, and `-1` does *not* mean "everything": `paginate` computes
   * `end = min(throughSeq + 1, beforeSeq ?? throughSeq + 1)`, so `-1` yields `end = 0` and
   * an empty page. The Host's documented source for the cut is the `cursor` of a `follow`
   * opening snapshot, so that is what this reads.
   *
   * The stream is opened only when the hub has not seen this Session yet, and is closed as
   * soon as the snapshot arrives — one frame, not a subscription. An empty Session reports
   * `-1`, which is the Host's own "empty log" value; callers must treat that as "no
   * history" rather than sending it back as a cut.
   *
   * @param controller - the session controller.
   * @param sessionId - Session to read.
   * @returns the cursor, or `null` if the stream produced no snapshot in time.
   */
  async cursorOf(controller, sessionId) {
    const existing = this.streams.get(sessionId)
    if (existing && existing.snapshotSeen) return existing.cursor
    if (existing) await existing.snapshotReady
    const entry = this.streams.get(sessionId)
    if (entry?.snapshotSeen) return entry.cursor

    // No hub stream yet: read exactly one snapshot and let it go.
    const abort = new AbortController()
    try {
      for await (const frame of controller.follow(
        { address: { kind: 'session', sessionId } },
        abort.signal,
      )) {
        if (frame?.type === 'snapshot' && typeof frame.cursor === 'number') return frame.cursor
      }
      return null
    } catch (error) {
      this.logger?.warn?.('could not read the session cursor', { sessionId: shortId(sessionId), error: String(error?.message ?? error) })
      return null
    } finally {
      abort.abort()
    }
  }

  /** Drop the stream of one Session. */
  close(sessionId) {
    const entry = this.streams.get(sessionId)
    if (!entry) return
    entry.abort.abort(new Error('closed by dsh-telegram-app'))
    this.streams.delete(sessionId)
  }

  /** Drop every stream, used when the plugin unloads. */
  closeAll() {
    for (const sessionId of [...this.streams.keys()]) this.close(sessionId)
  }
}

/**
 * Build the session-facing API used by the HTTP routes.
 * @param ctx - plugin context.
 * @param options.logger - optional logger.
 */
export function createSessionApi(ctx, { logger } = {}) {
  const hub = new StreamHub({ logger })
  const controller = () => ctx.get('sessionController')

  /** Fail with a message the Mini App can show verbatim. */
  const requireController = () => {
    const value = controller()
    if (!value) throw new Error('this Harness composition exposes no sessionController')
    return value
  }

  return {
    hub,

    /**
     * Visible sessions ordered by activity.
     *
     * `projections` is passed through deliberately. The view builder reads
     * `projections.values` — `title` for the row label and
     * `sessionListMetadata.blank` for the "never held a turn" filter — so a mapping that
     * drops it leaves every session untitled and only filtered by the weaker
     * `summary.blank`. That is exactly what happened: the wrapper looked tidy, the
     * screen-level tests kept passing because they build views from raw fixtures, and in
     * production every row read "folder · a1b2c3d4".
     */
    async list(signal) {
      const value = await requireController().list({}, signal)
      return (value?.items ?? []).map((summary) => ({
        sessionId: String(summary.sessionId),
        title: titleOf(summary),
        short: shortId(summary.sessionId),
        running: summary.running === true,
        live: summary.agentAvailable === true,
        blank: summary.blank === true,
        updatedAt: summary.updatedAt ?? 0,
        cwd: summary.cwd ?? null,
        origin: summary.origin ?? null,
        parentSessionId: summary.parentSessionId ? String(summary.parentSessionId) : null,
        projections: summary.projections,
      }))
    },

    /**
     * One history page, oldest first, for the opening view of a chat.
     *
     * `throughSeq` is an **inclusive log cut**, validated by the Host against the real
     * cursor, and the cut comes from a `follow` opening snapshot — that is the documented
     * source, and {@link StreamHub.cursorOf} reads it. Two mistakes are ruled out here,
     * both of which produced a working request that answered nothing:
     *
     * - `Number.MAX_SAFE_INTEGER` → `session page through seq … is past cursor 5687`;
     * - `-1` → accepted by validation, but `paginate` computes
     *   `end = min(throughSeq + 1, beforeSeq ?? throughSeq + 1)` = `0`, so the page is
     *   empty and the chat says the Session has no messages.
     *
     * An empty Session reports cursor `-1`, which is not a usable cut: there is nothing to
     * read, so an empty page is returned without asking the Host for one.
     *
     * @param sessionId - Session to read.
     * @param options.beforeSeq - page backwards from this offset.
     * @param options.maxMessages - page size.
     * @param options.throughSeq - explicit log cut; read from the stream when omitted.
     * @param options.signal - caller cancellation.
     */
    async history(sessionId, { beforeSeq, maxMessages = 60, throughSeq, signal } = {}) {
      const controllerValue = requireController()
      let cut = Number.isSafeInteger(throughSeq) && throughSeq >= 0 ? throughSeq : null
      if (cut === null) {
        const cursor = await hub.cursorOf(controllerValue, sessionId)
        if (cursor === null || cursor < 0) return { records: [], hasMore: false }
        cut = cursor
      }
      const page = await controllerValue.page(
        {
          address: { kind: 'session', sessionId },
          throughSeq: cut,
          ...(Number.isFinite(beforeSeq) ? { beforeSeq } : {}),
          maxMessages,
        },
        requestSignal(signal, HISTORY_READ_TIMEOUT_MS),
      )
      return page
    },

    /**
     * Admit one text prompt into a Session, resuming it when cold.
     *
     * Every path that reaches the controller passes a real `AbortSignal`. This is not
     * defensive style: `SessionController.prompt` opens with
     * `signal.throwIfAborted()` — no optional chaining — so an omitted signal does not
     * degrade, it throws `Cannot read properties of undefined (reading 'throwIfAborted')`
     * and the owner's message is lost with that developer-facing string as the reply.
     * The timeout bounds admission only; the turn itself runs for as long as it needs.
     *
     * @param sessionId - target Session.
     * @param text - the prompt text.
     * @param options.mode - `queue` admits behind a running turn.
     * @param options.signal - caller's signal, when it has one.
     */
    async prompt(sessionId, text, options = {}) {
      const { mode = 'queue', signal } = options
      const controllerValue = requireController()
      // A caller-supplied id wins: the chat layer mints `tg-…` ids so its own log line and
      // the Host's acknowledgement can be correlated. Ignoring it here silently renamed
      // every prompt this bridge sent.
      const requestId = typeof options.requestId === 'string' && options.requestId.length > 0
        ? options.requestId
        : `tgapp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      return controllerValue.prompt(
        { requestId, sessionId, mode, content: [{ type: 'text', text }] },
        requestSignal(signal, PROMPT_ADMISSION_TIMEOUT_MS),
      )
    },

    /** Cancel the running turn of a Session. */
    async cancel(sessionId) {
      return requireController().cancel({ sessionId })
    },

    /**
     * Create a fresh Session, in a workspace, at a directory, or both.
     *
     * `cwd` is forwarded, not dropped. A Session without a directory floats outside every
     * folder and never appears in the Web UI sidebar (§1), so `/new <path>` for a path
     * that is not a registered workspace depends entirely on this field reaching the
     * controller — and an earlier version of this wrapper forwarded only `workspaceId`
     * and `agentPreset`, which made that case create a Session somewhere unintended.
     */
    async create({ workspaceId, presetId, cwd } = {}) {
      return requireController().create({
        ...(workspaceId ? { workspaceId } : {}),
        ...(presetId ? { agentPreset: presetId } : {}),
        ...(cwd ? { cwd } : {}),
      })
    },

    /** Long-poll the Session stream. */
    async stream(sessionId, { since, timeoutMs } = {}) {
      return hub.drain(requireController(), sessionId, { since, timeoutMs })
    },
  }
}

/**
 * Reduce one `follow` frame to what a phone screen needs.
 * @param frame - raw controller frame.
 * @returns a compact record, or `null` for frames with nothing to render.
 */
export function frameToWire(frame) {
  if (!frame || typeof frame !== 'object') return null
  if (frame.type === 'snapshot') {
    return {
      kind: 'snapshot',
      cursor: frame.cursor ?? null,
      hasMore: frame.hasMore === true,
      cwd: frame.header?.cwd ?? null,
      records: (frame.records ?? []).map(recordToWire).filter(Boolean),
    }
  }
  if (frame.type === 'assistant-stream') {
    const chunk = frame.frame
    return chunk ? { kind: 'chunk', text: chunk.text ?? chunk.delta ?? null, frame: chunk } : null
  }
  if (frame.type === 'event' || frame.event) {
    return { kind: 'event', ...recordToWire(frame) }
  }
  return { kind: 'unknown', frame }
}

/** Reduce one history record or event entry to text plus metadata. */
function recordToWire(record) {
  const event = record?.event ?? record
  if (!event || typeof event !== 'object') return null
  const data = event.data ?? {}
  const type = event.type ?? 'unknown'
  const text = textOfContent(data.message?.content) ?? (typeof data.text === 'string' ? data.text : null)
  const role = data.message?.role ?? (type.startsWith('user/') ? 'user' : type.startsWith('assistant/') ? 'assistant' : null)
  return {
    seq: event.seq ?? record?.seq ?? null,
    type,
    role,
    text,
    toolName: type === 'tool/call' ? (data.name ?? null) : null,
    turn: data.turn ?? null,
    time: event.time ?? null,
  }
}

/**
 * Flatten a message content array into plain text.
 *
 * Text blocks only, for the same reason as the chat layer's `textOfMessage`: a tool call
 * has no user-facing text, and rendering it as `→ <tool>` turns an answer into a transcript
 * of the agent's activity.
 *
 * @param content - a string, or a block array.
 * @returns the joined text, or `null` when there is none.
 */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const joined = parts.join('\n').trim()
  return joined.length > 0 ? joined : null
}
