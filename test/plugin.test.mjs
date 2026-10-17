/**
 * The plugin entry point: mounting, the control token's first run, and when the
 * Mini App route exists at all.
 *
 * `apply` is called against a fake Cordis context, which is the only way to
 * cover the wiring without installing the plugin into a live profile. The two
 * facts worth pinning here are easy to get wrong and invisible until late:
 *
 * - the auto-generated control token must reach `state.json` *before* the
 *   settings write, so a failing form write cannot leave the bridge unarmed;
 * - the layer-2 route must not exist without a public HTTPS origin, because
 *   Telegram cannot open a `webapp` page any other way.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { apply, shouldServeApp } from '../index.js'
import * as plugin from '../index.js'
import { SCHEMA_PACKAGE, buildConfigSchema } from '../lib/schema.mjs'
import { StateStore } from '../lib/state.mjs'
import { fakeLogger, tempDir } from './fixtures.mjs'

test('the plugin exports a real Config schema, not a wrapper around one', () => {
  // This is the regression that matters most in this file. The host reads the
  // `Config` export to generate the settings page, so exporting anything but the
  // schema itself — a promise, a `{ schema, loaded }` record — makes the form
  // silently disappear while the plugin still looks installed.
  const schema = plugin.Config
  assert.notEqual(schema, undefined, 'Config must be exported')
  assert.equal(typeof schema.toJSON, 'function', 'Config must be a schemastery schema object')

  const json = schema.toJSON()
  const fields = Object.values(json.refs ?? {}).filter((entry) => entry?.type !== undefined)
  assert.ok(fields.length >= 15, `the schema should declare the whole config; got ${fields.length} nodes`)

  // Both secrets must carry `role: 'secret'`, which is what makes the settings
  // service render them write-only instead of echoing them back to a browser.
  const secretNodes = fields.filter((entry) => entry?.meta?.role === 'secret')
  assert.equal(secretNodes.length, 2, 'exactly botToken and controlToken are secret')
  for (const node of secretNodes) assert.equal(node.type, 'string')
})

test('the schema survives the host’s volatility filter', () => {
  // This is the difference between a schema that merely loads and one that is
  // configurable. `dsh-settings` describes a plugin through `volatileForm`, which
  // walks the schema and keeps only fields whose nearest volatile ancestor marks
  // them as editable without a remount:
  //
  //   function volatileForm(schema) {
  //     if (schema.meta.volatile) return plainSchema(schema)
  //     if (schema.type === 'object') { …recurse; undefined when no field qualifies }
  //   }
  //
  // A schema with no volatile field yields `undefined`, the entry is dropped from
  // `describe()`, and the Plugins page then has no form to render — the plugin
  // looks installed and healthy while offering nothing to configure.
  const json = plugin.Config.toJSON()

  /**
   * Mirror the host's walk over the **live** schema.
   *
   * `toJSON()` emits an index table of refs, so walking it would compare numbers
   * to nodes and collect nothing; the host walks the schema objects themselves,
   * and so does this.
   */
  const collectVolatile = (node, name, found) => {
    if (node === undefined || node === null) return found
    if (node.meta?.volatile === true) {
      found.push(name)
      return found
    }
    for (const [key, child] of Object.entries(node.dict ?? {})) collectVolatile(child, key, found)
    return found
  }

  // `json` stays in scope to prove the two views agree about the secrets.
  assert.equal(Object.values(json.refs ?? {}).filter((entry) => entry?.meta?.volatile === true).length >= 1, true)
  const volatileFields = collectVolatile(plugin.Config, '<root>', [])
  assert.ok(volatileFields.length > 0, 'without a volatile field the host exposes no settings namespace')

  // The fields the owner actually needs from the UI must be among them.
  for (const required of ['botToken', 'controlToken', 'notifyOnIdle']) {
    assert.ok(volatileFields.includes(required), `${required} must be editable live`)
  }

  // And the fields that would need a remount stay non-volatile, so the form never
  // promises a change it cannot deliver.
  for (const mountOnly of ['appPath', 'apiBase', 'proxy', 'statePath']) {
    assert.equal(volatileFields.includes(mountOnly), false, `${mountOnly} is bound at mount time`)
  }
})

test('buildConfigSchema yields the same schema as the module export', () => {
  const rebuilt = buildConfigSchema()
  assert.equal(typeof rebuilt.toJSON, 'function')
  assert.deepEqual(Object.keys(rebuilt({})).sort(), Object.keys(plugin.Config({})).sort())
})

test('the schema package is declared as both a dependency and an optional peer', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // A dependency, because `link:` installs resolve bare specifiers from the
  // package's own path; a peer as well, so a manager warns when a host pins a
  // different builder.
  assert.equal(typeof manifest.dependencies[SCHEMA_PACKAGE], 'string')
  assert.equal(typeof manifest.peerDependencies[SCHEMA_PACKAGE], 'string')
  assert.equal(manifest.peerDependenciesMeta[SCHEMA_PACKAGE].optional, true)
})

/**
 * A minimal Cordis-like context.
 *
 * `services` stands in for `ctx.get(name)`, `handlers` records every `ctx.on`
 * subscription, and `effects` records the effect callbacks so a test can watch
 * what `apply` registered without running a poll loop.
 */
function fakeContext(services = {}) {
  const logger = fakeLogger()
  const registrations = []
  const effects = []
  const handlers = new Map()
  return {
    logger,
    registrations,
    effects,
    handlers,
    loggerFactory: () => logger,
    get: (name) => services[name],
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    effect(callback, label) {
      effects.push({ label, dispose: callback() })
    },
    services,
    _services: services,
    set registration(value) {
      registrations.push(value)
    },
  }
}

/** Build a context whose web server records what was registered. */
function contextWithWebServer(services = {}) {
  const registrations = []
  const webServer = {
    register(route) {
      registrations.push(route)
      return () => {
        route.disposed = true
      }
    },
  }
  const ctx = fakeContext({ webServer, ...services })
  ctx.registrations = registrations
  // A context as the real loader hands one over: the fiber starts LOADING during
  // `apply`, and the token publish waits for ACTIVE. Advancing it here keeps every
  // test on the same path the plugin takes in production, rather than on the
  // no-fiber fallback.
  attachFiber(ctx, 1)
  ctx.activate = () => {
    ctx.advanceTo(2)
    return new Promise((resolve) => setImmediate(resolve))
  }
  return ctx
}

/**
 * Give a fake context a fiber whose state can be advanced, plus the
 * `internal/status` plumbing the plugin subscribes to.
 */
function attachFiber(ctx, state = 1) {
  const handlers = new Map()
  const fiber = { state }
  ctx.fiber = fiber
  ctx.off = (event, listener) => {
    const list = handlers.get(event) ?? []
    handlers.set(event, list.filter((entry) => entry !== listener))
  }
  const baseOn = ctx.on
  ctx.on = (event, handler) => {
    const list = handlers.get(event) ?? []
    list.push(handler)
    handlers.set(event, list)
    baseOn(event, handler)
  }
  /** Move the fiber to a new state and notify, as the real loader does. */
  ctx.advanceTo = (next) => {
    const previous = fiber.state
    fiber.state = next
    for (const listener of handlers.get('internal/status') ?? []) listener(fiber, previous)
  }
  /** Land activation and let whatever it scheduled settle. */
  ctx.activate = async () => {
    ctx.advanceTo(2)
    await new Promise((resolve) => setImmediate(resolve))
  }
  return ctx
}

/** Path of a state file inside a fresh temp directory. */
function statePath() {
  return path.join(tempDir(), 'state.json')
}

test('a stored digest with no readable plaintext is not treated as armed', async () => {
  // The exact failure the owner hit: `state.json` holds a digest from an earlier
  // run whose plaintext was never published, so the bot would refuse every
  // pairing forever. Startup must issue a fresh, readable token instead of
  // assuming the stored digest is usable.
  const file = statePath()
  const previous = new StateStore({ file })
  previous.load()
  previous.setControlToken('a-token-whose-plaintext-is-gone')
  assert.equal(previous.hasControlToken(), true, 'the stale digest is on disk')

  const published = []
  const settings = {
    describe: () => [{ ns: 'include:telegram-app' }],
    mutate: async (ns, ops) => {
      published.push({ ns, value: ops[0].value })
    },
  }
  const ctx = contextWithWebServer({ settings })
  await apply(ctx, { botToken: 'token', statePath: file })
  await ctx.activate()

  assert.equal(published.length, 1, 'a replacement is published so it can be read')
  const fresh = published[0].value
  assert.notEqual(fresh, 'a-token-whose-plaintext-is-gone')

  const store = new StateStore({ file })
  store.load()
  assert.equal(store.matchesControlToken(fresh), true, 'the digest now stands for the readable token')
  assert.equal(store.matchesControlToken('a-token-whose-plaintext-is-gone'), false)
})

test('a digest is never written for a token that could not be published', async () => {
  // Ordering matters: writing the digest first would leave an armed token nobody
  // can present, which is unrecoverable because only the hash is persisted.
  const file = statePath()
  const settings = {
    describe: () => [{ ns: 'include:telegram-app' }],
    mutate: async () => {
      throw new Error('profile is read-only')
    },
  }
  const ctx = contextWithWebServer({ settings })
  await apply(ctx, { botToken: 'token', statePath: file })
  await ctx.activate()

  const store = new StateStore({ file })
  store.load()
  assert.equal(store.hasControlToken(), false, 'a failed publish leaves the bridge unarmed, not half-armed')
  assert.equal(ctx.logger.entries.warn.some((args) => String(args[0]).includes('not arming it')), true)
})

/** A Cordis-like context carrying a fiber, so activation gating can be staged. */
function contextWithFiber(services = {}, state = 1) {
  const webServer = {
    register() {
      return () => {}
    },
  }
  const ctx = fakeContext({ webServer, ...services })
  attachFiber(ctx, state)
  return ctx
}

test('the control token is published only after the fiber is active', async () => {
  // `settings.write` resolves the entry through `describe()`, which only reports
  // entries whose fiber is ACTIVE — and `apply` runs while it is still LOADING.
  // Publishing early therefore fails, and a token that is never published is a
  // token the owner can never send to the bot.
  const published = []
  const settings = {
    describe: () => [{ ns: 'include:telegram-app' }],
    mutate: async (ns, ops) => {
      published.push(ops[0].value)
    },
  }
  const ctx = contextWithFiber({ settings }, 1)
  const file = statePath()
  await apply(ctx, { botToken: 'token', statePath: file })
  // Let anything the plugin scheduled eagerly run: with the fiber still LOADING
  // there must be no write, because the host would refuse it.
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(published, [], 'nothing is written while the fiber is still loading')

  await ctx.activate()

  assert.equal(published.length, 1, 'the publish happens once activation lands')
  const store = new StateStore({ file })
  store.load()
  assert.equal(store.matchesControlToken(published[0]), true)
})

test('a fiber that never activates leaves the bridge unarmed, not half-armed', async () => {
  const published = []
  const settings = {
    describe: () => [{ ns: 'include:telegram-app' }],
    mutate: async (ns, ops) => published.push(ops[0].value),
  }
  const ctx = contextWithFiber({ settings }, 1)
  const file = statePath()
  await apply(ctx, { botToken: 'token', statePath: file })

  // Activation never arrives (the plugin failed to load, say), so the publish must
  // not have happened — and, crucially, no digest may stand for the missing value.
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(published, [])
  const store = new StateStore({ file })
  store.load()
  assert.equal(store.hasControlToken(), false, 'no digest without a published plaintext')
})

test('shouldServeApp is true only for a public HTTPS origin', () => {
  assert.equal(shouldServeApp({ publicBaseUrl: 'https://dsh.example.com' }), true)
  assert.equal(shouldServeApp({ publicBaseUrl: 'http://dsh.example.com' }), false, 'Telegram needs https')
  assert.equal(shouldServeApp({ publicBaseUrl: 'https://' }), true, 'the shape is what matters here')
  assert.equal(shouldServeApp({ publicBaseUrl: '' }), false)
  assert.equal(shouldServeApp({}), false)
  assert.equal(shouldServeApp(undefined), false)
})

test('layer 2 stays off without a public origin: no route is registered', async () => {
  const ctx = contextWithWebServer()
  const file = statePath()
  await apply(ctx, { botToken: 'token', statePath: file })
  await ctx.activate()

  assert.deepEqual(ctx.registrations, [], 'no route without a public HTTPS origin')
  assert.equal(ctx.handlers.has('approval/request'), true, 'the chat layer still mounts')
  assert.equal(ctx.handlers.has('agent/status'), true)
  assert.equal(ctx.effects.length, 1, 'the poll effect is registered')
})

test('layer 2 registers its route once a public origin is configured', async () => {
  const ctx = contextWithWebServer()
  await apply(ctx, { botToken: 'token', publicBaseUrl: 'https://dsh.example.com', statePath: statePath() })

  assert.equal(ctx.registrations.length, 1)
  assert.equal(ctx.registrations[0].kind, 'prefix')
  assert.equal(ctx.registrations[0].path, '/tg-app')
})

test('the app path is configurable and normalized', async () => {
  const ctx = contextWithWebServer()
  await apply(ctx, { botToken: 'token', publicBaseUrl: 'https://dsh.example.com', appPath: 'panel/', statePath: statePath() })
  assert.equal(ctx.registrations[0].path, '/panel')
})

test('the first run generates a control token, stores its digest and publishes it', async () => {
  const mutations = []
  const settings = {
    describe: () => [{ ns: 'dsh-telegram-app#telegram-app' }],
    mutate: async (ns, ops) => {
      mutations.push({ ns, ops })
    },
  }
  const ctx = contextWithWebServer({ settings })
  const file = statePath()
  await apply(ctx, { botToken: 'token', statePath: file })
  await ctx.activate()

  assert.equal(mutations.length, 1, 'the token is written into the settings form')
  assert.equal(mutations[0].ns, 'dsh-telegram-app#telegram-app')
  assert.equal(mutations[0].ops[0].op, 'set')
  assert.deepEqual(mutations[0].ops[0].path, ['controlToken'])

  const token = mutations[0].ops[0].value
  assert.equal(typeof token, 'string')
  assert.ok(token.length >= 32, 'the generated token must be long enough to be worth hashing')

  // The digest is on disk, and the token itself never is.
  const raw = fs.readFileSync(file, 'utf8')
  assert.equal(raw.includes(token), false, 'the token must not be on disk in the clear')
  const store = new StateStore({ file })
  store.load()
  assert.equal(store.matchesControlToken(token), true)
  assert.equal(store.chats().length, 0, 'a generated token does not authorize anything by itself')
})

test('the row config is read from the schema-validated form the loader passes', async () => {
  // The regression that broke the live bot, and the reason every earlier test missed
  // it: those tests handed `apply` the RAW row config, but the loader validates the
  // config against the plugin's Config schema first — and a field marked `.volatile()`
  // does not validate to its value. It becomes a `Volatile` cell read through `get()`.
  //
  // So in production `config.controlToken` was an object, `typeof value === 'string'`
  // was false, the token was silently dropped for an empty default, and the plugin ran
  // "successfully" with no credentials: no state file, no reply to any message.
  //
  // This test goes through the schema exactly as the loader does.
  const raw = {
    botToken: 'bot-token-from-the-profile-patch',
    controlToken: 'control-token-from-the-profile-patch',
  }

  const cells = buildConfigSchema()(raw)
  assert.notEqual(typeof cells.controlToken, 'string', 'a volatile field really does arrive wrapped')

  const ctx = contextWithWebServer()
  const file = statePath()
  await apply(ctx, { ...cells, statePath: file })
  await ctx.activate()

  const store = new StateStore({ file })
  store.load()
  assert.equal(
    store.matchesControlToken(raw.controlToken),
    true,
    'the configured control token must be the one that gets armed',
  )
  assert.equal(ctx.logger.entries.info.some((args) => String(args[0]).includes('taken from the configuration')), true)
})

test('a volatile number and boolean survive the schema too', async () => {
  // The same wrapper affects every volatile field, not just the secrets. The values
  // are read back from what the plugin reports at startup, because that is the plugin's
  // own account of what it resolved — a fresh `StateStore` built in a test would fall
  // back to the built-in defaults and prove nothing (an earlier version of this test
  // made exactly that mistake).
  //
  // `10` rather than an arbitrary number: `SESSION_LIMITS` is a closed set
  // ([3, 5, 10, 15]) and the plugin refuses anything outside it.
  const cells = buildConfigSchema()({
    notifyDefault: false,
    notifyOnIdle: false,
    notifyMinRunSeconds: 45,
    sessionLimitDefault: 10,
  })
  assert.equal(typeof cells.notifyOnIdle, 'object', 'a volatile boolean arrives wrapped as well')

  const ctx = contextWithWebServer()
  await apply(ctx, { ...cells, botToken: 'token', statePath: statePath() })
  await ctx.activate()

  const starting = ctx.logger.entries.info.find((args) => String(args[0]).includes('telegram-app starting'))
  assert.notEqual(starting, undefined, 'the plugin reports its resolved configuration')

  // A naive read of a wrapped `false` yields a truthy object and a wrapped number
  // yields NaN, so these assertions catch a plugin silently ignoring its configuration.
  assert.equal(starting[1].settings.sessionLimit, 10, 'the volatile number reached the runtime defaults')
  assert.equal(starting[1].settings.notify, false, 'the volatile boolean did not arrive truthy')
})

test('a stored digest is reissued rather than assumed usable', async () => {
  // `state.json` keeps a hash and never the value, so a digest on disk cannot be
  // presented to the bot. Startup therefore issues and publishes a fresh token
  // instead of leaving the owner with a bot that refuses every pairing.
  const file = statePath()
  const first = new StateStore({ file })
  first.load()
  first.setControlToken('existing-token')

  const mutations = []
  const settings = {
    describe: () => [{ ns: 'dsh-telegram-app#telegram-app' }],
    mutate: async (ns, ops) => mutations.push({ ns, ops }),
  }
  const ctx = contextWithWebServer({ settings })
  await apply(ctx, { botToken: 'token', statePath: file })
  await ctx.activate()

  assert.equal(mutations.length, 1, 'the readable replacement is published')
  const published = mutations[0].ops[0].value
  assert.notEqual(published, 'existing-token', 'the unreadable digest is not what the form shows')

  const store = new StateStore({ file })
  store.load()
  assert.equal(store.matchesControlToken(published), true, 'the digest now matches what the form shows')
})

test('a configured control token wins and is not published anywhere', async () => {
  const mutations = []
  const settings = {
    describe: () => [{ ns: 'dsh-telegram-app#telegram-app' }],
    mutate: async (ns, ops) => mutations.push({ ns, ops }),
  }
  const ctx = contextWithWebServer({ settings })
  const file = statePath()
  await apply(ctx, { botToken: 'token', controlToken: 'from-the-form', statePath: file })

  assert.deepEqual(mutations, [], 'nothing to generate, so nothing to write')
  const store = new StateStore({ file })
  store.load()
  assert.equal(store.matchesControlToken('from-the-form'), true)
})

test('a settings write that fails leaves the bridge unarmed rather than half-armed', async () => {
  const settings = {
    describe: () => [{ ns: 'dsh-telegram-app#telegram-app' }],
    mutate: async () => {
      throw new Error('profile is read-only')
    },
  }
  const ctx = contextWithWebServer({ settings })
  const file = statePath()
  await apply(ctx, { botToken: 'token', statePath: file })
  await ctx.activate()

  const store = new StateStore({ file })
  store.load()
  // Arming here would be the worst outcome: the bot would demand a token whose
  // value nobody can present, because only its hash survives.
  assert.equal(store.hasControlToken(), false, 'no digest is stored for a token that was never published')
  assert.equal(ctx.logger.entries.warn.some((args) => String(args[0]).includes('not arming it')), true)
})

test('without a settings service the generated token is reported, never logged', async () => {
  const ctx = contextWithWebServer()
  await apply(ctx, { botToken: 'token', statePath: statePath() })
  await ctx.activate()

  const warnings = ctx.logger.entries.warn.map((args) => args.map(String).join(' '))
  assert.equal(warnings.some((line) => line.includes('could not be shown in the settings form')), true)
  // A token in the log would leak to every tool that reads logs.
  const all = JSON.stringify(ctx.logger.entries)
  assert.equal(/[A-Za-z0-9_-]{32,}/u.test(all), false, `no long secret-looking string in the log: ${all.slice(0, 200)}`)
})

test('a host without a workspace registry or session controller still mounts', async () => {
  const ctx = contextWithWebServer()
  await apply(ctx, { statePath: statePath() })
  await ctx.activate()

  const info = ctx.logger.entries.info.map((args) => args.map(String).join(' '))
  assert.equal(ctx.effects.length, 1)
  assert.equal(info.some((line) => line.includes('telegram-app ready')), true)
})

test('the approver is asked only when no browser client is attached', async () => {
  const ctx = contextWithWebServer({ typertGateway: { hasLiveClient: () => true } })
  const file = statePath()
  const store = new StateStore({ file })
  store.load()
  store.setControlToken('tok')
  store.pair({ userId: 42, chatId: 42 })
  await apply(ctx, { botToken: 'token', statePath: file })
  await ctx.activate()

  const [handler] = ctx.handlers.get('approval/request')
  let nextCalled = false
  const outcome = handler({ toolName: 'bash', agent: { id: 'session-1' } }, () => {
    nextCalled = true
    return 'from-the-browser'
  })
  // With a live browser client the handler mirrors and defers, so the browser
  // keeps ownership of the card (§8).
  assert.equal(outcome, 'from-the-browser')
  assert.equal(nextCalled, true)
})

test('unloading the plugin disposes the route and the poll loop', async () => {
  const ctx = contextWithWebServer()
  await apply(ctx, { botToken: 'token', publicBaseUrl: 'https://dsh.example.com', statePath: statePath() })

  // Two effects exist in this configuration: the Mini App route (registered by
  // `lib/routes.mjs`) and the poll loop. Both must unwind on unload.
  assert.equal(ctx.effects.length, 2)
  const poll = ctx.effects.find((entry) => entry.label === 'dsh-telegram-app/poll')
  assert.ok(poll, 'the poll effect carries its label')
  for (const entry of ctx.effects) assert.doesNotThrow(() => entry.dispose())
  assert.equal(ctx.registrations[0].disposed, true, 'the route disposer ran')
})
