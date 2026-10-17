/**
 * HTTP surface of the plugin: the Mini App page and its JSON API.
 *
 * Everything lives under one prefix route (`appPath`, `/tg-app` by default) so
 * the whole feature is a single, greppable entry in the Harness web server. The
 * route is intentionally *outside* the Host's own `/api` guard: Telegram cannot
 * carry a Harness cookie, so admission is decided here instead, by the signed
 * Mini App payload plus the control token.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeEqual, validateInitData } from './auth.mjs'
import { frameToWire } from './sessions.mjs'

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web')
const MAX_BODY_BYTES = 128 * 1024

/** Static assets this route serves, with their content types. */
const ASSETS = new Map([
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
])

/** Send one JSON response. */
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Send one text response. */
function text(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(body)
}

/** Read a JSON request body with a hard size cap. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** A tiny fixed-window throttle for the pairing endpoint. */
class AttemptThrottle {
  constructor({ limit = 20, windowMs = 10 * 60 * 1000 } = {}) {
    this.limit = limit
    this.windowMs = windowMs
    this.hits = new Map()
  }

  /** Record one attempt and report whether it is still allowed. */
  allow(key) {
    const now = Date.now()
    const entry = this.hits.get(key)
    if (!entry || now - entry.start > this.windowMs) {
      this.hits.set(key, { start: now, count: 1 })
      return true
    }
    entry.count += 1
    return entry.count <= this.limit
  }

  /** Forget an attempt history after a success. */
  reset(key) {
    this.hits.delete(key)
  }
}

/**
 * Serve the Mini App shell.
 *
 * The page is static and secret-free: it derives every path from its own
 * location, so the origin it was reached through needs no injection. The policy
 * allows exactly two script origins — this bridge and the Telegram WebApp SDK —
 * and no inline script at all.
 */
function serveShell(res) {
  let html
  try {
    html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8')
  } catch (error) {
    text(res, 500, `Mini App shell is missing: ${String(error)}`)
    return
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self' https://telegram.org",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
  })
  res.end(html)
}

/** Serve one static asset. */
function serveAsset(res, assetPath) {
  const asset = ASSETS.get(assetPath)
  if (!asset) return false
  const [file, contentType] = asset
  try {
    const body = fs.readFileSync(path.join(WEB_DIR, file))
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    text(res, 404, 'not found')
  }
  return true
}

/**
 * Register the Mini App route.
 *
 * @param ctx - plugin context with `webServer`.
 * @param options.config - normalized plugin config.
 * @param options.logger - logger.
 * @param options.pairing - the durable state store (its pairing half).
 * @param options.tokens - Mini App session tokens.
 * @param options.sessions - session API.
 * @param options.validateInitData - Telegram payload verifier, injectable for tests.
 * @param options.onChatSession - called when a Mini App client selects a Session.
 * @returns the route disposer.
 */
export function registerRoutes(ctx, { config, logger, pairing, tokens, sessions, onChatSession, validateInitData: verifyInitData = validateInitData }) {
  const throttle = new AttemptThrottle()
  const appPath = config.appPath

  /** Resolve the bearer token of a Mini App request. */
  const claimOf = (req, url) => {
    const header = req.headers['x-tg-token']
    const token = typeof header === 'string' && header.length > 0 ? header : url.searchParams.get('token')
    const claim = tokens.verify(token)
    if (!claim) return null
    if (!pairing.hasChat(claim.chatId)) return null
    return claim
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const sub = url.pathname.slice(appPath.length) || '/'
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && (sub === '/' || sub === '')) {
        serveShell(res)
        return
      }
      if (method === 'GET' && serveAsset(res, sub)) return
      if (method === 'GET' && sub === '/api/health') {
        json(res, 200, { ok: true, paired: pairing.chats().length > 0, appPath })
        return
      }

      if (!sub.startsWith('/api/')) {
        text(res, 404, 'not found')
        return
      }

      const body = method === 'POST' ? await readJson(req) : {}

      if (sub === '/api/auth') {
        const key = req.socket?.remoteAddress ?? 'unknown'
        if (!throttle.allow(key)) {
          logger?.warn?.('pairing throttled', { key })
          json(res, 429, { ok: false, error: 'too many attempts, try again later' })
          return
        }
        const verdict = verifyInitData(body.initData, config.botToken, { maxAgeSec: config.initDataMaxAgeSec })
        if (!verdict.ok) {
          logger?.warn?.('mini app payload refused', { error: verdict.error })
          json(res, 401, { ok: false, error: `Telegram payload refused: ${verdict.error}` })
          return
        }
        if (!config.controlToken) {
          json(res, 503, { ok: false, error: 'no control token is configured on the Harness side' })
          return
        }
        if (!safeEqual(body.controlToken ?? '', config.controlToken)) {
          logger?.warn?.('control token mismatch', { userId: verdict.userId })
          json(res, 401, { ok: false, error: 'control token is wrong' })
          return
        }
        throttle.reset(key)
        const changed = pairing.pair({ userId: verdict.userId, chatId: verdict.chatId })
        const token = tokens.issue({ userId: verdict.userId, chatId: verdict.chatId })
        logger?.info?.('mini app paired', { userId: verdict.userId, chatId: verdict.chatId, changed })
        json(res, 200, {
          ok: true,
          token,
          me: {
            userId: verdict.userId,
            chatId: verdict.chatId,
            username: verdict.username ?? null,
            firstName: verdict.firstName ?? null,
          },
        })
        return
      }

      const claim = claimOf(req, url)
      if (!claim) {
        json(res, 401, { ok: false, error: 'not authorized' })
        return
      }

      const abort = new AbortController()
      req.on('close', () => abort.abort(new Error('client closed')))

      switch (sub) {
        case '/api/list': {
          const items = await sessions.list(abort.signal)
          json(res, 200, { ok: true, items, paired: { userId: claim.userId, chatId: claim.chatId } })
          return
        }
        case '/api/session': {
          const sessionId = String(body.sessionId ?? '')
          if (!sessionId) {
            json(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          onChatSession?.(claim.chatId, sessionId)
          const page = await sessions.history(sessionId, { beforeSeq: body.beforeSeq, maxMessages: body.maxMessages ?? 60, signal: abort.signal })
          json(res, 200, { ok: true, page: page ?? null })
          return
        }
        case '/api/prompt': {
          const sessionId = String(body.sessionId ?? '')
          const value = String(body.text ?? '')
          if (!sessionId || value.trim().length === 0) {
            json(res, 400, { ok: false, error: 'sessionId and text are required' })
            return
          }
          onChatSession?.(claim.chatId, sessionId)
          const receipt = await sessions.prompt(sessionId, value, { mode: body.mode === 'steer' ? 'steer' : 'queue', signal: abort.signal })
          json(res, 200, { ok: true, receipt: receipt ?? null })
          return
        }
        case '/api/cancel': {
          const sessionId = String(body.sessionId ?? '')
          if (!sessionId) {
            json(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          json(res, 200, { ok: true, receipt: await sessions.cancel(sessionId) })
          return
        }
        case '/api/create': {
          json(res, 200, { ok: true, value: await sessions.create({ workspaceId: body.workspaceId }) })
          return
        }
        case '/api/stream': {
          const sessionId = String(body.sessionId ?? '')
          if (!sessionId) {
            json(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          const result = await sessions.stream(sessionId, { since: Number(body.since ?? 0), timeoutMs: body.timeoutMs ?? 20_000 })
          json(res, 200, {
            ok: true,
            next: result.next,
            closed: result.closed === true,
            frames: result.frames.map(frameToWire).filter(Boolean),
          })
          return
        }
        default:
          json(res, 404, { ok: false, error: 'unknown endpoint' })
      }
    } catch (error) {
      logger?.warn?.('mini app request failed', { path: sub, error: String(error?.message ?? error) })
      if (!res.headersSent) json(res, 500, { ok: false, error: String(error?.message ?? error) })
      else res.end()
    }
  }

  return ctx.effect(() => {
    // The web server is looked up lazily rather than injected, because layer 2
    // is optional: a composition that mounts this plugin without one must not
    // fail to load (§12). The caller only reaches here after checking the origin
    // and the service, so a missing one at this point is a real fault.
    const webServer = ctx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      logger?.warn?.('mini app route not registered: this host exposes no webServer')
      return () => {}
    }
    const dispose = webServer.register({ kind: 'prefix', path: appPath, handler })
    logger?.info?.('mini app route registered', { appPath })
    return () => {
      dispose()
      logger?.info?.('mini app route removed', { appPath })
    }
  })
}

export { AttemptThrottle }
