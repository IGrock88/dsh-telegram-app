/**
 * Run the plugin's real `apply()` against a faithful fake host and report what it did.
 *
 * This exists because live diagnosis stalled: the running server's log could not be captured
 * (restarting it kills the agent that is asking), and it was unclear whether `apply()` was
 * receiving the config at all. Rather than keep reading framework source, this harness answers
 * the one question that matters — which branch does `apply()` take, and does it manage to
 * publish a token — by exercising the actual code with the actual configuration.
 *
 * The plugin is loaded from **this repository**, not from an installed profile: the point is to
 * test the working copy. Point `PLUGIN_PATH` at an installed copy to probe that instead.
 *
 * Usage:
 *     node tools/probe-apply.mjs
 *     PLUGIN_PATH=/path/to/installed/index.js node tools/probe-apply.mjs
 *     DSH_TG_BOT_TOKEN=... DSH_TG_CONTROL_TOKEN=... node tools/probe-apply.mjs
 */

import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

/** Absolute path of this file, so every other location is derived rather than assumed. */
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'))
const REPO = path.dirname(HERE)
const PLUGIN = pathToFileURL(process.env.PLUGIN_PATH ?? path.join(REPO, 'index.js')).href

/** Record every call the plugin makes into the host. */
const calls = { settings: [], logged: [], registered: [], effects: [] }

const logger = {
  info: (message, detail) => calls.logged.push({ level: 'info', message, detail }),
  warn: (message, detail) => calls.logged.push({ level: 'warn', message, detail }),
  error: (message, detail) => calls.logged.push({ level: 'error', message, detail }),
  debug: () => {},
}

/**
 * Describe what the host would report.
 *
 * `namespaces` is the answer the live form depended on: the settings service only
 * exposes an entry once its schema has at least one volatile field, and its `ns` is
 * the loader entry id.
 */
const namespaces = process.argv.includes('--no-namespace')
  ? []
  : [{ ns: 'include:telegram-app' }]

const ctx = {
  logger: () => logger,
  // The fiber is ACTIVE, so `whenActive` publishes immediately instead of waiting.
  fiber: { state: 2 },
  on: () => {},
  off: () => {},
  get(name) {
    if (name === 'settings') {
      return {
        describe: () => namespaces,
        mutate: async (ns, ops) => {
          calls.settings.push({ ns, ops })
          return undefined
        },
      }
    }
    if (name === 'sessionController') {
      return {
        list: () => [],
        page: () => ({ items: [] }),
        prompt: async () => {},
        cancel: async () => {},
        create: async () => ({}),
        follow: () => () => {},
      }
    }
    if (name === 'workspaceRegistry') {
      return { list: () => [], archivedSessionIds: () => [] }
    }
    return undefined
  },
  effect: (fn) => {
    if (typeof fn === 'function') calls.effects.push(fn())
  },
  on: () => {},
}

const statePath = path.join(mkdtempSync(path.join(tmpdir(), 'tg-probe-')), 'state.json')

/**
 * The credentials this probe feeds the plugin.
 *
 * Read from the environment, never hard-coded: this file is published, and an earlier version
 * carried a real bot token and a real control token in plain sight. Nothing here needs a live
 * credential — the point is to watch which branch `apply()` takes, and any non-empty string
 * exercises the same code. A real token is only useful when you want to see the bot actually
 * answer, and then it belongs in the environment:
 *
 *     DSH_TG_BOT_TOKEN=... DSH_TG_CONTROL_TOKEN=... node probe-apply.mjs
 *
 * @returns the config object to hand `apply()`, with placeholders when nothing is set.
 */
function probeConfig() {
  const fromEnv = {
    botToken: process.env.DSH_TG_BOT_TOKEN,
    controlToken: process.env.DSH_TG_CONTROL_TOKEN,
  }
  return {
    botToken: fromEnv.botToken ?? 'probe-bot-token-not-a-real-credential',
    controlToken: fromEnv.controlToken ?? 'probe-control-token-not-a-real-credential',
    usingRealTokens: Boolean(fromEnv.botToken ?? fromEnv.controlToken),
  }
}

const { usingRealTokens, ...patchConfig } = probeConfig()

console.log('statePath for this run:', statePath)
console.log('namespaces the fake host serves:', JSON.stringify(namespaces))
console.log('credentials:', usingRealTokens ? 'from DSH_TG_* environment' : 'placeholders (no DSH_TG_* set)')
console.log('')

const { apply, Config } = await import(PLUGIN)

console.log('--- schema sanity ---')
const json = Config.toJSON()
const nodes = Object.values(json.refs ?? {})
console.log('volatile fields:', nodes.filter((n) => n?.meta?.volatile === true).length)
console.log('secret fields:  ', nodes.filter((n) => n?.meta?.role === 'secret').length)
console.log('')

// The loader validates the row config against the plugin's Config schema BEFORE
// `apply` sees it, and that step is not cosmetic: a `.volatile()` field validates to a
// `Volatile` cell, not to its value. Feeding `apply` the raw config — which is what
// this probe did at first — therefore proved nothing and hid the very bug it was built
// to find. The validated form is what is handed over below.
const validated = Config({ ...patchConfig })

console.log('--- what the loader would hand apply() ---')
for (const key of ['botToken', 'controlToken']) {
  const cell = validated[key]
  const unwrapped = typeof cell?.get === 'function' ? cell.get() : cell
  console.log(`  ${key}: wrapped as ${typeof cell}, unwraps to ${typeof unwrapped}`)
}
console.log('')

try {
  await apply(ctx, { ...validated, statePath })
  console.log('--- apply() completed without throwing ---')
} catch (error) {
  console.log('--- apply() THREW ---')
  console.log(String(error?.stack ?? error))
}

console.log('')
console.log('--- settings.mutate calls ---')
if (calls.settings.length === 0) {
  console.log('  (none - the token was never published)')
} else {
  for (const call of calls.settings) {
    const value = call.ops?.[0]?.value
    console.log(`  ns=${call.ns} path=${JSON.stringify(call.ops?.[0]?.path)} value=${String(value).slice(0, 12)}...`)
  }
}

console.log('')
console.log('--- plugin log lines ---')
for (const entry of calls.logged) {
  console.log(`  [${entry.level}] ${entry.message} ${entry.detail ? JSON.stringify(entry.detail) : ''}`)
}

console.log('')
console.log('--- state.json written by apply() ---')
try {
  const raw = (await import('node:fs')).readFileSync(statePath, 'utf8')
  const parsed = JSON.parse(raw)
  console.log('  controlTokenHash:', parsed.controlTokenHash ? `${parsed.controlTokenHash.slice(0, 16)}...` : 'NONE')
  console.log('  chats:', parsed.chats?.length ?? 0)
} catch (error) {
  console.log('  NOT WRITTEN:', String(error?.message ?? error))
}

// `apply()` starts the bot's long-poll loop, which keeps the process alive forever. The probe
// is a one-shot report, so it ends here rather than making the caller hunt for the right
// Ctrl+C — an earlier version simply hung.
console.log('')
console.log('DONE')
process.exit(0)
