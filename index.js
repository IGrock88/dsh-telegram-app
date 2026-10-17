/**
 * dsh-telegram-app — a Telegram bridge for DeepSeek Harness.
 *
 * Layer 1 (this file's focus) is a chat: the owner sends the bot a control
 * token once, the chat is remembered, and from then on the phone walks menu →
 * workspaces → the last N chats of a folder → the working screen of one chat,
 * sends prompts as plain text, stops turns, answers approvals with buttons and
 * reads the tail of a conversation. It needs no domain, no tunnel and no open
 * port: the bot only makes outgoing Bot API calls.
 *
 * Layer 2 (the Mini App panel) is written and wired, but its HTTP route is
 * registered *only* when a public HTTPS origin is configured — see
 * {@link shouldServeApp} — because Telegram refuses to open a `web_app` page
 * without one.
 *
 * Everything is registered through `ctx.effect`/`ctx.on`, so unloading the
 * plugin unwinds the poll loop, the watchers and the route.
 */
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { TelegramBot } from './lib/bot.mjs'
import { COMMANDS, createRouter } from './lib/chat.mjs'
import { shortId } from './lib/format.mjs'
import { registerRoutes } from './lib/routes.mjs'
import { buildConfigSchema } from './lib/schema.mjs'
import { SessionTokens, validateInitData } from './lib/auth.mjs'
import { createSessionApi } from './lib/sessions.mjs'
import { DEFAULT_SETTINGS, SESSION_LIMITS, StateStore, WORKSPACE_SORTS } from './lib/state.mjs'

export const name = 'telegram-app'

/**
 * Nothing is a hard dependency.
 *
 * The chat layer needs neither the web server (layer 2 does) nor the session
 * controller (a host without it degrades to "pairing and notifications still
 * work", §12), so injecting either would refuse to mount the plugin on a
 * composition that merely lacks an optional piece. Every seam is looked up
 * lazily through `ctx.get`, and a missing one is reported once at startup.
 */
export const inject = []

/**
 * The config schema, which is what gives this plugin a settings page.
 *
 * It must be the schema object itself: the host reads this export to generate
 * the form, so wrapping it in anything — a promise, a `{ schema, loaded }`
 * record — makes the form silently vanish while the plugin still looks
 * installed. Building it here also means a broken schema fails activation with a
 * clear error instead of producing an unconfigurable plugin.
 */
export const Config = buildConfigSchema()

/** Environment fallbacks, so a token never has to sit in a tracked YAML file. */
const ENV = {
  botToken: 'DSH_TG_BOT_TOKEN',
  controlToken: 'DSH_TG_CONTROL_TOKEN',
  publicBaseUrl: 'DSH_TG_PUBLIC_URL',
  appPath: 'DSH_TG_APP_PATH',
  apiBase: 'DSH_TG_API_BASE',
  proxy: 'DSH_TG_PROXY',
  cwd: 'DSH_TG_CWD',
  statePath: 'DSH_TG_STATE_PATH',
  settingsNamespace: 'DSH_TG_SETTINGS_NS',
}

/**
 * Unwrap a `Volatile` cell down to its plain value.
 *
 * A schema field marked `.volatile()` does not validate to its value: schemastery
 * wraps it in a `Volatile` cell whose payload is read through `get()`. The loader
 * validates the row's config against the schema before `apply` sees it, so a
 * volatile field arrives here as a cell, not a string — `typeof value === 'string'`
 * is then false, the setting is silently dropped and the default takes its place.
 *
 * That silence is what cost hours: with `botToken` and `controlToken` both declared
 * volatile (which they must be, or the settings form has no fields at all), the
 * plugin received empty tokens while looking perfectly configured, so it never
 * answered a single message and never wrote its state file.
 *
 * @param value - a raw config value, possibly a volatile cell.
 * @returns the cell's snapshot, or the value unchanged.
 */
function plainValue(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/** Read one string setting from the row config, then the environment. */
function stringSetting(raw, key) {
  const fromConfig = plainValue(raw?.[key])
  if (typeof fromConfig === 'string' && fromConfig.trim().length > 0) return fromConfig.trim()
  const envName = ENV[key]
  const fromEnv = envName ? process.env[envName] : undefined
  return typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv.trim() : ''
}

/** Read a boolean setting with an explicit default. */
function booleanSetting(raw, key, fallback) {
  const value = plainValue(raw?.[key])
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value === 'true' || value === '1'
  return fallback
}

/** Read a positive number setting with an explicit default. */
function numberSetting(raw, key, fallback) {
  const value = Number(plainValue(raw?.[key]))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** Parse a comma-separated id list out of an environment variable. */
function idsFromEnv(name) {
  const raw = process.env[name]
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value))
}

/** Normalize the loader row config into the shape the runtime uses. */
function normalizeConfig(raw = {}) {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  // Every read below goes through `plainValue`: the loader validates the row config
  // against the schema first, so volatile fields arrive as `Volatile` cells.
  const sessionLimitRaw = Number(plainValue(raw?.sessionLimitDefault))
  const workspaceSortRaw = plainValue(raw?.workspaceSortDefault)
  const allowedUsers = plainValue(raw?.allowedUserIds)
  const defaults = {
    sessionLimit: SESSION_LIMITS.includes(sessionLimitRaw)
      ? sessionLimitRaw
      : DEFAULT_SETTINGS.sessionLimit,
    workspaceSort: WORKSPACE_SORTS.includes(workspaceSortRaw)
      ? workspaceSortRaw
      : DEFAULT_SETTINGS.workspaceSort,
    notify: booleanSetting(raw, 'notifyDefault', DEFAULT_SETTINGS.notify),
  }
  return {
    botToken: stringSetting(raw, 'botToken'),
    controlToken: stringSetting(raw, 'controlToken'),
    publicBaseUrl: stringSetting(raw, 'publicBaseUrl').replace(/\/+$/u, ''),
    appPath: `/${stringSetting(raw, 'appPath').replace(/^\/+|\/+$/gu, '') || 'tg-app'}`,
    apiBase: stringSetting(raw, 'apiBase') || 'https://api.telegram.org',
    proxy: stringSetting(raw, 'proxy'),
    cwd: stringSetting(raw, 'cwd'),
    statePath: stringSetting(raw, 'statePath') || path.join(home, 'telegram-app', 'state.json'),
    settingsNamespace: stringSetting(raw, 'settingsNamespace'),
    allowedUserIds: Array.isArray(allowedUsers) && allowedUsers.length > 0
      ? allowedUsers.map(Number)
      : idsFromEnv('DSH_TG_ALLOWED_USERS'),
    notifyOnIdle: booleanSetting(raw, 'notifyOnIdle', true),
    notifyMinRunSeconds: numberSetting(raw, 'notifyMinRunSeconds', 20),
    approvalMode: ['ask', 'notify', 'off'].includes(stringSetting(raw, 'approvalMode')) ? stringSetting(raw, 'approvalMode') : 'ask',
    approvalTimeoutSec: numberSetting(raw, 'approvalTimeoutSec', 180),
    sessionTokenTtlSec: numberSetting(raw, 'sessionTokenTtlSec', 12 * 60 * 60),
    initDataMaxAgeSec: numberSetting(raw, 'initDataMaxAgeSec', 24 * 60 * 60),
    pollTimeoutSec: Math.min(numberSetting(raw, 'pollTimeoutSec', 30), 50),
    defaults,
  }
}

/**
 * Whether the Mini App route should be served at all.
 *
 * Telegram opens a `web_app` page only over public HTTPS with a valid
 * certificate, while the Harness web server listens on loopback — so without an
 * origin, no client that could use the panel can reach it. Not registering the
 * route keeps the surface honest: there is no half-feature listening for
 * requests nobody can legitimately make.
 *
 * @param config - normalized plugin config.
 * @returns true when a public HTTPS origin is configured.
 */
export function shouldServeApp(config) {
  return /^https:\/\//iu.test(String(config?.publicBaseUrl ?? ''))
}

/** Absolute Mini App URL, or `null` when layer 2 is off. */
function appUrl(config) {
  return shouldServeApp(config) ? `${config.publicBaseUrl}${config.appPath}` : null
}

/**
 * Find the settings namespace of this plugin's own loader row.
 *
 * The namespace is the loader entry id, which the profile composes from the
 * bundle name and the row id; the exact spelling is a host detail, so it is
 * discovered from `settings.describe()` rather than guessed. Without it, the
 * auto-generated control token could not be written back into the form.
 *
 * @param ctx - plugin context.
 * @param config - normalized plugin config; `settingsNamespace` overrides detection.
 * @returns the namespace, or `null` when it cannot be identified.
 */
function findSettingsNamespace(ctx, config) {
  if (config.settingsNamespace) return config.settingsNamespace
  const settings = ctx.get?.('settings')
  if (!settings || typeof settings.describe !== 'function') return null
  let descriptors = []
  try {
    descriptors = settings.describe({ redactSecrets: true }) ?? []
  } catch {
    return null
  }
  const names = descriptors.map((entry) => String(entry?.ns ?? '')).filter((value) => value.length > 0)
  const packageName = 'dsh-telegram-app'
  for (const candidate of [`${packageName}#telegram-app`, `${packageName}:telegram-app`, 'telegram-app', `${packageName}#dsh-telegram-app`]) {
    if (names.includes(candidate)) return candidate
  }
  return names.find((value) => value.includes('telegram-app')) ?? null
}

/**
 * Generate the control token, publish it where the owner can read it, and only
 * then arm it.
 *
 * The ordering here is the whole point, and the first version got it wrong in a
 * way worth recording. It wrote the digest into `state.json` *first* and then
 * tried to publish the plaintext into the settings form. When the publish failed
 * — or when the field was not yet exposed in the form at all — the digest stayed
 * on disk with no way to recover the value it stood for: the token was armed,
 * unfindable and unusable. That is exactly the state the owner hit, with an empty
 * Control token field above a bot that could never be authorized.
 *
 * So the plaintext is published first, and the digest is written only for a token
 * the owner can actually read back. A stored digest whose plaintext is gone is
 * therefore indistinguishable from "nothing is armed", which is what lets a fresh
 * token be issued instead of leaving the bot permanently unable to pair.
 *
 * `mutate` rather than `replace` is used for the publish, so secrets the form
 * never returned are not wiped out by this write.
 *
 * @param ctx - plugin context.
 * @param options.config - normalized plugin config.
 * @param options.state - the state store.
 * @param options.logger - logger.
 * @returns the generated token, or `null` when nothing was generated.
 */
async function ensureControlToken(ctx, { config, state, logger }) {
  const token = randomBytes(24).toString('base64url')

  const settings = ctx.get?.('settings')
  const namespace = findSettingsNamespace(ctx, config)
  if (settings && typeof settings.mutate === 'function' && namespace) {
    try {
      await settings.mutate(namespace, [{ op: 'set', path: ['controlToken'], value: token }])
      state.setControlToken(token)
      logger.info('control token generated and published to the settings form', { namespace })
      return token
    } catch (error) {
      // No publish, so no digest: an unreadable armed token is worse than none,
      // because the bot would refuse every pairing with no way to recover.
      logger.warn('control token generated but the settings write failed; not arming it', {
        namespace,
        error: String(error?.message ?? error),
      })
      return token
    }
  }

  // No form to publish into. The token itself must not go to the log, which other
  // tooling reads, so the owner is told how to recover instead.
  logger.warn(
    'control token generated but could not be shown in the settings form; set DSH_TG_CONTROL_TOKEN yourself, or configure the row and restart',
    { namespace: namespace ?? 'not found', settingsAvailable: Boolean(settings) },
  )
  return token
}

/**
 * Run `task` once this plugin's own fiber is active.
 *
 * A plugin cannot write its own settings from inside `apply`: the host projects
 * settings only for entries whose fiber is `ACTIVE`, and `apply` runs while the
 * fiber is still `LOADING`. `settings.write` resolves the entry through
 * `describe()`, so an early call fails with `No configurable plugin entry "…"` —
 * and a token that is never published is a token nobody can send to the bot.
 *
 * @param ctx - plugin context.
 * @param task - the work to run after activation.
 * @returns a disposer removing the listener, so an unload does not leak it.
 */
function whenActive(ctx, task) {
  const fiber = ctx.fiber
  const ACTIVE = 2
  if (!fiber || typeof ctx.on !== 'function') {
    // No fiber to wait on (a bare test context): the caller decides what to do.
    return false
  }
  if (fiber.state === ACTIVE) {
    void task()
    return true
  }
  const listener = (changed) => {
    if (changed !== fiber || fiber.state !== ACTIVE) return
    if (typeof ctx.off === 'function') ctx.off('internal/status', listener)
    void task()
  }
  ctx.on('internal/status', listener)
  return true
}

/** A Session's display title inside an already-collected view. */
function sessionTitleOf(view, session) {
  const own = typeof session?.title === 'string' ? session.title.trim() : ''
  if (own.length > 0) return own
  const folderTitle = view.folderFor?.(session?.sessionId)?.title ?? ''
  const head = String(session?.sessionId ?? '').slice(0, 8)
  return folderTitle.length > 0 ? `${folderTitle} · ${head}` : head
}

/**
 * Register the plugin.
 * @param ctx - Harness plugin context.
 * @param rawConfig - the loader row's `config`.
 */
export async function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('telegram-app') : (ctx.logger ?? console)

  const state = new StateStore({ file: config.statePath, logger, defaults: config.defaults })
  state.load()
  const sessions = createSessionApi(ctx, { logger })
  const bot = new TelegramBot({ token: config.botToken, apiBase: config.apiBase, logger, proxy: config.proxy || undefined })
  const tokens = new SessionTokens({ ttlSec: config.sessionTokenTtlSec })

  /** Read the Workspace registry lazily; a host without it degrades to "no folders" (§12). */
  const registry = {
    available() {
      return Boolean(ctx.get('workspaceRegistry'))
    },
    workspaces() {
      const value = ctx.get('workspaceRegistry')
      if (!value || typeof value.list !== 'function') return []
      try {
        return value.list() ?? []
      } catch (error) {
        logger.warn('workspace registry read failed', { error: String(error?.message ?? error) })
        return []
      }
    },
    archivedSessionIds() {
      try {
        return ctx.get('workspaceRegistry')?.archivedSessionIds ?? []
      } catch {
        return []
      }
    },
  }

  const router = createRouter({ config, state, bot, sessions, registry, logger })

  /** Turn start times, for the idle notification's duration (§8). */
  const runStartedAt = new Map()
  /** Session each Mini App client last looked at, so the panel and the chat agree. */
  const chatSession = new Map()

  // ── Control token: use the readable one, generate only what is missing ────
  //
  // A configured token is authoritative: record its digest so the state file
  // knows which token is current, without dropping the chats that already proved
  // knowledge of an older one (§9).
  //
  // Otherwise a token has to be issued and published. `state.json` keeps only a
  // hash, never the value, so a stored digest whose plaintext is gone is
  // indistinguishable from "nothing is armed" — and treating it as armed would
  // leave a bot that demands a token nobody can present. Both cases are therefore
  // repaired the same way, and the repair waits for activation because the write
  // cannot land before it (see `whenActive`).
  if (config.controlToken) {
    if (state.setControlToken(config.controlToken)) logger.info('control token taken from the configuration')
  } else {
    const publish = async () => {
      const issued = await ensureControlToken(ctx, { config, state, logger })
      if (issued && state.hasControlToken()) logger.info('control token ready; read it from the plugin settings form')
    }
    if (!whenActive(ctx, publish)) void publish()
  }

  logger.info('telegram-app starting', {
    token: bot.configured ? 'configured' : 'MISSING',
    controlToken: state.hasControlToken() ? 'ready' : 'MISSING',
    pairedChats: state.chats().length,
    publicBaseUrl: shouldServeApp(config) ? config.publicBaseUrl : 'MISSING (layer 2 stays off)',
    statePath: config.statePath,
    sessions: ctx.get('sessionController') ? 'available' : 'MISSING (lists degrade)',
    workspaces: registry.available() ? 'available' : 'MISSING (no folders)',
    // The plugin-config defaults for chats that never opened screen S. Reported here
    // because a silently dropped setting is otherwise invisible: volatile fields
    // arrive as cells, and reading one without unwrapping yields NaN or a truthy
    // object rather than an error.
    settings: config.defaults,
  })

  // ── Layer 2: the Mini App route, only with a public origin ───────────────
  if (shouldServeApp(config)) {
    const webServer = ctx.get('webServer')
    if (webServer && typeof webServer.register === 'function') {
      registerRoutes(ctx, {
        config,
        logger,
        pairing: state,
        tokens,
        sessions,
        validateInitData,
        onChatSession: (chatId, sessionId) => chatSession.set(Number(chatId), String(sessionId)),
      })
    } else {
      logger.warn('a public origin is configured but this host exposes no webServer: the panel is not served')
    }
  } else {
    logger.info('Mini App route not registered (no public HTTPS origin configured)')
  }

  // ── Turn-finished and error notifications (§8) ───────────────────────────
  ctx.on('agent/status', (payload) => {
    const sessionId = String(payload?.agent?.id ?? '')
    if (!sessionId) return
    if (payload.status === 'running') {
      runStartedAt.set(sessionId, Date.now())
      return
    }
    if (payload.status !== 'idle') return
    const startedAt = runStartedAt.get(sessionId)
    runStartedAt.delete(sessionId)
    if (!config.notifyOnIdle || startedAt === undefined) return
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    if (seconds < config.notifyMinRunSeconds) return
    void router.notifyIdle(sessionId, seconds).catch((error) => {
      logger.warn('idle notification failed', { sessionId: shortId(sessionId), error: String(error?.message ?? error) })
    })
  })

  ctx.on('agent/error', (payload) => {
    const sessionId = String(payload?.agent?.id ?? payload?.sessionId ?? '')
    if (!sessionId) return
    const reason = String(payload?.error?.message ?? payload?.reason ?? payload?.error ?? 'ошибка')
    void router.notifyError(sessionId, reason).catch((error) => {
      logger.warn('error notification failed', { sessionId: shortId(sessionId), error: String(error?.message ?? error) })
    })
  })

  // ── Approvals from the phone (§8) ────────────────────────────────────────
  ctx.on('approval/request', (req, next) => {
    if (config.approvalMode === 'off' || state.chats().length === 0) return next()

    /** Build the question text once per approval. */
    const questionText = async () => {
      const { view } = await router.collect(state.chats()[0])
      const session = view.sessions.find((entry) => entry.sessionId === String(req?.agent?.id ?? ''))
      const title = session ? sessionTitleOf(view, session) : shortId(req?.agent?.id)
      const lines = [`🛡️ Разрешение: ${req?.toolName ?? 'неизвестно'} · ${title}`]
      if (req?.reason) lines.push(`Причина: ${req.reason}`)
      return { lines, title }
    }

    // A browser client already shows the card, so only mirror the question.
    const liveClient = ctx.get('typertGateway')?.hasLiveClient?.() === true
    if (config.approvalMode === 'notify' || liveClient) {
      void (async () => {
        const { lines } = await questionText()
        if (liveClient) lines.push('', 'Карточка открыта в браузере — ответь там.')
        for (const chatId of state.chats()) await bot.sendMessage(chatId, lines.join('\n'))
      })().catch((error) => logger.warn('approval mirror failed', { error: String(error?.message ?? error) }))
      return next()
    }

    if (req?.signal?.aborted) return next()
    return new Promise((resolve) => {
      const nonce = randomBytes(4).toString('hex')
      let settled = false
      const settle = (outcome, note) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        req?.signal?.removeEventListener?.('abort', onAbort)
        router.pendingApprovals.delete(nonce)
        if (note) for (const chatId of state.chats()) void bot.sendMessage(chatId, note)
        resolve(outcome)
      }
      const timer = setTimeout(() => {
        settle(null, null)
        logger.warn('approval question timed out on Telegram', { tool: req?.toolName })
      }, config.approvalTimeoutSec * 1000)
      const onAbort = () => settle(null, null)
      req?.signal?.addEventListener?.('abort', onAbort, { once: true })

      router.pendingApprovals.set(nonce, {
        decide: (allowed, chatId, messageId) => {
          settle(allowed ? 'allowed-once' : 'rejected', allowed ? '✅ Разрешено' : '⛔ Отклонено')
          if (messageId) void bot.clearKeyboard(chatId, messageId)
        },
      })

      void (async () => {
        const { lines } = await questionText()
        lines.push('', `Ответь в течение ${config.approvalTimeoutSec} с, иначе карточка уйдёт в браузер.`)
        for (const chatId of state.chats()) {
          await bot.sendMessage(chatId, lines.join('\n'), { keyboard: router.approvalKeyboard(nonce) })
        }
      })().catch((error) => logger.warn('approval question failed', { error: String(error?.message ?? error) }))

      // A late `next()` still lets the other answerers run, so a timeout never
      // turns into a silent denial.
      return undefined
    }).then((outcome) => (outcome === null ? next() : outcome))
  })

  // ── The poll loop ────────────────────────────────────────────────────────
  ctx.effect(() => {
    const controller = new AbortController()
    const loop = async () => {
      if (!bot.configured) {
        logger.warn('no bot token configured: Telegram features are idle')
        return
      }
      const me = await bot.whoami()
      if (!me) {
        logger.warn('bot token rejected by Telegram: check the token and the network')
        return
      }
      logger.info('telegram bot listening', { username: me.username })
      await bot.setCommands(COMMANDS.map(([command, description]) => ({ command, description })))

      let offset
      while (!controller.signal.aborted) {
        await bot.poll({
          get offset() {
            return offset
          },
          timeoutSec: config.pollTimeoutSec,
          signal: controller.signal,
          onUpdate: async (update) => {
            offset = update.update_id + 1
            try {
              if (update.message) await router.handleMessage(update.message)
              else if (update.callback_query) await router.handleCallback(update.callback_query)
            } catch (error) {
              logger.warn('update handler failed', { error: String(error?.message ?? error) })
            }
          },
        })
      }
    }
    void loop().catch((error) => logger.warn('telegram loop failed', { error: String(error) }))
    return () => {
      controller.abort(new Error('plugin unloaded'))
      sessions.hub.closeAll()
    }
  }, 'dsh-telegram-app/poll')

  logger.info('telegram-app ready', { appUrl: appUrl(config) ?? 'layer 2 off' })
}
