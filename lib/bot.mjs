/**
 * Minimal Telegram Bot API client: long polling, message sending and callback
 * answers over `fetch`, with no third-party dependency.
 *
 * Every outbound call is wrapped so a transport failure can never reject into
 * the Harness host: callers get `{ ok: false }` and a logged warning instead.
 */

/** Telegram's own limit for one text message. */
export const MAX_MESSAGE_LENGTH = 4096

/**
 * Split text so every part fits the Telegram limit, preferring a line break.
 * Lossless: joining the parts returns the original text.
 * @param text - source text.
 * @param limit - maximum code units per part.
 * @returns one or more parts.
 */
export function splitMessage(text, limit = MAX_MESSAGE_LENGTH) {
  if (text.length <= limit) return [text]
  const parts = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '))
    const end = cut > limit * 0.5 ? cut + 1 : limit
    parts.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest.length > 0) parts.push(rest)
  return parts
}

/** The Telegram Bot API transport for one bot token. */
export class TelegramBot {
  /**
   * @param options.token - BotFather token.
   * @param options.apiBase - Bot API origin, replaceable for a local reverse proxy.
   * @param options.logger - optional logger.
   * @param options.proxy - optional HTTP proxy URL for deployments without direct access.
   */
  constructor({ token, apiBase = 'https://api.telegram.org', logger, proxy } = {}) {
    this.token = token
    this.apiBase = apiBase.replace(/\/+$/, '')
    this.logger = logger
    this.proxy = proxy ?? process.env.DSH_TG_PROXY ?? process.env.HTTPS_PROXY ?? null
    this.me = null
  }

  /** Whether a token was configured at all. */
  get configured() {
    return typeof this.token === 'string' && this.token.length > 0
  }

  /** Absolute URL of one Bot API method. */
  url(method) {
    return `${this.apiBase}/bot${this.token}/${method}`
  }

  /**
   * Call one Bot API method.
   * @param method - Bot API method name.
   * @param payload - JSON body.
   * @param options.signal - cancellation.
   * @param options.timeoutMs - additional request timeout.
   * @returns the `result` field, or `undefined` on any failure.
   */
  async call(method, payload = {}, { signal, timeoutMs } = {}) {
    if (!this.configured) return undefined
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) return undefined
      signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = timeoutMs ? setTimeout(() => controller.abort(new Error('timeout')), timeoutMs) : undefined
    try {
      const response = await fetch(this.url(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.ok !== true) {
        this.logger?.warn?.(`telegram ${method} failed`, { status: response.status, description: body?.description })
        return undefined
      }
      return body.result
    } catch (error) {
      if (!controller.signal.aborted) this.logger?.warn?.(`telegram ${method} error`, { error: String(error) })
      return undefined
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Resolve and cache the bot identity; `null` when the token is unusable. */
  async whoami() {
    if (this.me) return this.me
    const me = await this.call('getMe')
    if (me) this.me = me
    return this.me
  }

  /**
   * Register the slash-command hint list shown by Telegram clients.
   * @param commands - `[{ command, description }]`.
   */
  async setCommands(commands) {
    return this.call('setMyCommands', { commands })
  }

  /**
   * Send one text message, split to the Telegram limit.
   *
   * `keyboard` and `replyKeyboard` address different slots of the same message and
   * **cannot be combined**: Telegram takes exactly one `reply_markup`, so a message
   * carries either inline buttons or a custom reply keyboard. When both were passed,
   * the second assignment silently overwrote the first and every screen lost its
   * buttons — the bot answered and the owner had nothing to tap. The reply keyboard is
   * therefore sent on its own (once, at pairing) and screens carry only inline buttons.
   *
   * @param chatId - target chat.
   * @param text - message body.
   * @param options.keyboard - inline keyboard rows.
   * @param options.replyKeyboard - reply keyboard rows; wins over `keyboard` by design.
   * @returns the first sent message, or `undefined`.
   */
  async sendMessage(chatId, text, { keyboard, replyKeyboard, disablePreview = true } = {}) {
    if (!this.configured) return undefined
    let first
    for (const part of splitMessage(text)) {
      const payload = {
        chat_id: chatId,
        text: part,
        link_preview_options: { is_disabled: disablePreview },
      }
      // One slot, one occupant — hence `else if`.
      if (replyKeyboard) {
        payload.reply_markup = { keyboard: replyKeyboard, resize_keyboard: true, is_persistent: true }
      } else if (keyboard) {
        payload.reply_markup = { inline_keyboard: keyboard }
      }
      const sent = await this.call('sendMessage', payload)
      first ??= sent
    }
    return first
  }

  /** Acknowledge a button press so the client stops its spinner. */
  async answerCallbackQuery(callbackQueryId, text) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) })
  }

  /** Remove the buttons of a message once its question is settled. */
  async clearKeyboard(chatId, messageId) {
    return this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
  }

  /**
   * Replace the text of a message this bot sent.
   *
   * Screens live in one message that is rewritten in place (§2), so a failure
   * here is ordinary rather than exceptional: Telegram refuses the call when the
   * text is unchanged ("message is not modified") and when the message is gone.
   * The caller responds by sending a fresh screen (§12).
   *
   * @param chatId - target chat.
   * @param messageId - the message to rewrite.
   * @param text - new body.
   * @param options.keyboard - inline keyboard rows; omitted keeps the old markup.
   * @returns the edited message, or `undefined` when the edit was refused.
   */
  async editMessageText(chatId, messageId, text, { keyboard, disablePreview = true } = {}) {
    if (!this.configured) return undefined
    const body = String(text ?? '')
    // A multi-part body cannot be edited into a single message, so let the
    // caller take its fallback instead of sending Telegram a doomed request.
    if (body.length > MAX_MESSAGE_LENGTH) return undefined
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: body,
      link_preview_options: { is_disabled: disablePreview },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    })
  }

  /**
   * Long-poll for updates until the signal aborts.
   * @param options.offset - next update id.
   * @param options.timeoutSec - long-poll timeout handed to Telegram.
   * @param options.signal - cancellation.
   * @param options.onUpdate - called once per update.
   */
  async poll({ offset, timeoutSec = 30, signal, onUpdate }) {
    while (!signal.aborted) {
      const updates = await this.call(
        'getUpdates',
        { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
        { signal, timeoutMs: (timeoutSec + 15) * 1000 },
      )
      if (signal.aborted) return
      if (!Array.isArray(updates)) {
        await sleep(1500, signal)
        continue
      }
      for (const update of updates) {
        offset = update.update_id + 1
        try {
          await onUpdate(update, offset)
        } catch (error) {
          this.logger?.warn?.('telegram update handler failed', { error: String(error) })
        }
      }
    }
  }
}

/** Sleep that resolves early when the signal aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
