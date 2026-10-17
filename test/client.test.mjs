/**
 * The browser half, executed without a browser.
 *
 * This file cannot be covered by an import: it is written in the client module
 * loader's own dialect (`window.__ModuleLoader__.load` with a `require`), so a
 * plain `import` would either fail outright or, worse, pass while proving
 * nothing about what the loader will do with it.
 *
 * The test therefore stands up the loader's contract — a `window` carrying
 * `__ModuleLoader__.load`, a `require` answering the modules the file asks for,
 * React shims that build inspectable trees and re-render on a state change — and
 * then makes the assertions the DSH UI depends on:
 *
 * - the file registers into `plugins.row.config` under exactly
 *   `<bundle>#<rowId>`, the key the Plugins page dispatches, because a different
 *   key is a row with no configure control;
 * - `summary` answers the row's description fallback and `page` renders a usable
 *   form, or states why it cannot;
 * - a save sends a path-addressed mutation carrying only the fields the reader
 *   edited, which is what keeps one save from clearing the other value.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const CLIENT_SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8')

/**
 * Record one JSX element.
 *
 * The JSX runtime hands children inside `props.children` (and, for keyed static
 * children, as a trailing argument) rather than as a third parameter — the first
 * version of this shim got that wrong and silently produced childless trees.
 */
function element(type, props, extra) {
  const { children, ...rest } = props ?? {}
  const collected = [children, extra].flat(Number.POSITIVE_INFINITY)
  return {
    type,
    props: rest,
    children: collected.filter((value) => value !== null && value !== undefined && value !== false),
  }
}

/** Collect every node matching a predicate anywhere in a recorded tree. */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  findAll(node.children, predicate, found)
  return found
}

/** Every string rendered anywhere in a tree. */
function texts(node, found = []) {
  if (typeof node === 'string') {
    found.push(node)
    return found
  }
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) texts(child, found)
    return found
  }
  texts(node.children, found)
  return found
}

/** Find one node by predicate, failing loudly when it is absent. */
function findOne(node, predicate, what) {
  const [first] = findAll(node, predicate)
  assert.notEqual(first, undefined, `expected to find ${what}`)
  return first
}

const BOT_INPUT = (node) => node.type === 'input' && node.props?.id === 'dsh-telegram-app-bot-token'
const CONTROL_INPUT = (node) => node.type === 'input' && node.props?.id === 'dsh-telegram-app-control-token'
const FIRST_BUTTON = (node) => node.type === 'button'

/** Load the client half the way the browser loader does. */
function loadClientHalf(options = {}) {
  const slots = { registrations: [], injections: [] }
  const locale = { namespaces: [], bound: [] }
  const effects = []

  // One mounted instance at a time: the shim serves the component under test.
  let mounted = null

  const reactRuntime = {
    jsx: (type, props, key) => element(type, props, [key]),
    jsxs: (type, props, key) => element(type, props, [key]),
    Fragment: 'Fragment',
  }

  const react = {
    useState: (initial) => mounted.useState(initial),
    useEffect: (callback, deps) => mounted.useEffect(callback, deps),
  }

  // A configuration-forms service as the entry sees it. Without explicit
  // options it reports no namespaces, which is the "nothing matches" case.
  //
  // `secrets` is part of the same wire view (`SettingsNamespaceView.secrets`): the host
  // strips `role('secret')` values from everything the client receives but does say
  // whether each slot is set, and that flag is the only way to tell a stored token from
  // an empty one.
  const configForms = {
    describe: () => ({
      getSnapshot: () => ({
        status: 'ready',
        view: {
          namespaces: (options.namespaces ?? []).map((entry) => ({
            ...entry,
            secrets: entry.secrets ?? [],
          })),
        },
        error: null,
      }),
      subscribe: () => () => {},
    }),
    get: (id) => {
      if (options.form === undefined) throw new Error(`no form for ${id}`)
      return options.form
    },
  }

  const modules = {
    'react/jsx-runtime': reactRuntime,
    react,
    '@deepseek-ai/dsh-client-ui-primitives': {},
  }

  let registered = null
  const window = {
    __ModuleLoader__: {
      load: (definition) => {
        registered = definition
      },
    },
  }

  // Run the file with the loader's globals in scope. `new Function` rather than
  // `import`, precisely because the file is not an ES module.
  const run = new Function('window', 'require', 'module', 'exports', CLIENT_SOURCE)
  const require = (name) => {
    if (!(name in modules)) throw new Error(`the client half required an unexpected module: ${name}`)
    return modules[name]
  }
  run(window, require, { exports: {} }, {})

  assert.notEqual(registered, null, 'the file must call window.__ModuleLoader__.load')
  assert.equal(registered.id, 'dsh-telegram-app', 'the loader id is the bundle name')

  const ctx = {
    locale: {
      register: (ns, dicts) => {
        locale.namespaces.push({ ns, dicts })
        return () => {}
      },
      bind: (ns) => {
        locale.bound.push(ns)
        const dict = locale.namespaces.find((entry) => entry.ns === ns)?.dicts?.en ?? {}
        return (key) => dict[key] ?? key
      },
    },
    slots: {
      inject: (name, callback) => {
        slots.injections.push(name)
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      register: (options, component) => {
        slots.registrations.push({ options, component })
        return () => {}
      },
    },
    effect: (callback) => {
      effects.push(callback())
    },
    configForms,
  }

  const exported = registered.factory(require)
  exported.apply(ctx)

  /** The single registration the page depends on. */
  const registration = slots.registrations.find((entry) => entry.options.name === 'plugins.row.config')

  /** What the slot's own injection supplies, as the framework would merge it. */
  const injected = typeof registration.options.inject === 'function' ? registration.options.inject() : {}
  const EMPTY = { form: undefined, diagnostics: 'no settings entry' }

  /**
   * Mount the page component and follow its re-renders.
   *
   * Effects run *after* the render that scheduled them, as React does: running
   * them inline made a `setState` inside an effect re-enter the render and blow
   * the stack, which is a property of the shim rather than of the component.
   *
   * @param props - the slot's owner props.
   * @returns `{ react, tree }` where `tree` is always the latest settled render.
   */
  function mount(props) {
    // The framework merges the entry's injected face onto the owner props.
    const merged = { ...props, ...injected }
    if (merged.resolveForm === undefined) merged.resolveForm = () => EMPTY
    const hooks = []
    let cursor = 0
    let tree = null
    let pendingEffects = []
    let dirty = false

    /** React's dependency rule: an effect re-runs unless every dep is unchanged. */
    const sameDeps = (previous, next) => {
      if (previous === undefined || next === undefined) return false
      if (previous === null || next === null) return false
      if (previous.length !== next.length) return false
      return previous.every((value, index) => Object.is(value, next[index]))
    }

    const expand = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node
      if (Array.isArray(node)) return node.map(expand)
      if (typeof node.type === 'function') {
        return expand(node.type({ ...node.props, ...(node.children.length > 0 ? { children: node.children } : {}) }))
      }
      return { ...node, children: expand(node.children) }
    }

    const render = () => {
      cursor = 0
      pendingEffects = []
      dirty = false
      tree = expand(registration.component(merged))
    }

    /** Run whatever the render scheduled, until nothing is left to settle. */
    const flush = () => {
      let rounds = 0
      do {
        const effects = pendingEffects
        pendingEffects = []
        dirty = false
        for (const effect of effects) effect()
        rounds += 1
        if (rounds > 20) throw new Error('the component never settled')
      } while (dirty || pendingEffects.length > 0)
    }

    mounted = {
      useState: (initial) => {
        const index = cursor
        cursor += 1
        if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
        return [hooks[index], (next) => {
          const value = typeof next === 'function' ? next(hooks[index]) : next
          if (value === hooks[index]) return
          hooks[index] = value
          dirty = true
          render()
          flush()
        }]
      },
      useEffect: (callback, deps) => {
        const slot = cursor
        cursor += 1
        const previous = hooks[slot]
        if (previous !== undefined && Array.isArray(deps) && sameDeps(previous, deps)) return
        hooks[slot] = deps
        pendingEffects.push(callback)
      },
    }

    render()
    flush()
    return {
      react,
      get tree() {
        return tree
      },
    }
  }

  return { exports: exported, slots, locale, effects, registration, injected, mount }
}

test('the client half registers into plugins.row.config under the bundle#row key', () => {
  const { slots, registration } = loadClientHalf()
  assert.ok(slots.injections.includes('plugins.row.config'), 'the row configuration slot is filled')
  assert.notEqual(registration, undefined, 'the row configuration slot must be occupied')

  // The Plugins page dispatches `rowConfigKey(pkg.name, row.rowId)`; a different
  // key leaves the row without its configure control.
  assert.equal(registration.options.key, 'dsh-telegram-app#telegram-app')
  assert.equal(typeof registration.options.label, 'function')
  assert.equal(registration.options.locale, 'telegram-app.config')
  assert.equal(typeof registration.component, 'function')
})

test('the client half declares the services it needs', () => {
  const { exports } = loadClientHalf()
  assert.deepEqual(exports.inject, ['slots', 'locale', 'configForms'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.NS, 'telegram-app.config')
})

test('the dictionaries are installed under the namespace the entry declares', () => {
  const { locale, registration } = loadClientHalf()
  assert.deepEqual(locale.namespaces.map((entry) => entry.ns), ['telegram-app.config'])
  assert.equal(registration.options.locale, 'telegram-app.config', 'the t seat reads the same namespace')
})

test('the summary view answers with the row one-liner', () => {
  const { mount, locale } = loadClientHalf()
  const { tree } = mount({ view: 'summary', t: (key) => key })
  assert.deepEqual(locale.bound, ['telegram-app.config'])
  assert.deepEqual(texts(tree), ['summary'], 'the description fallback is a single line of copy')
})

test('the page view renders both fields, their state, and the save control', () => {
  const { mount } = loadClientHalf({
    namespaces: [{ ns: 'include:telegram-app' }],
    form: undefined,
  })
  const form = {
    state: { status: 'ready', value: { botToken: '', controlToken: '' }, writable: true, revision: 7 },
    mutate: async () => true,
  }
  const { tree } = mount({ view: 'page', t: (key) => key, form })

  const inputs = findAll(tree, (node) => node.type === 'input')
  assert.equal(inputs.length, 2, 'one input per configurable field')
  assert.deepEqual(inputs.map((node) => node.props.id), [
    'dsh-telegram-app-bot-token',
    'dsh-telegram-app-control-token',
  ])
  // The accepted values seed the drafts. A secret arrives stripped, so they are empty.
  assert.deepEqual(inputs.map((node) => node.props.value), ['', ''])
  assert.equal(inputs.every((node) => node.props.disabled === false), true)

  const button = findOne(tree, FIRST_BUTTON, 'the save button')
  assert.equal(button.props.disabled, true, 'an untouched form has nothing to save')

  const rendered = texts(tree)
  assert.ok(rendered.includes('intro'), 'the page explains what it edits')
  // The mirror did not report this namespace's secret slots, so the state is unknown and
  // the neutral wording is the honest one — never a claim that nothing is stored.
  assert.ok(
    rendered.some((value) => value.includes('tokenUnknown')),
    'an unreported secret slot is not presented as an empty one',
  )
})

test('a stored secret is reported as configured even though its value is stripped', () => {
  // The complaint this answers: the owner set both tokens, saved, came back, and found
  // two empty fields — a page that looks like the save never happened. The values cannot
  // be shown (the host redacts them), but "something is stored" can.
  //
  // The form is left to the entry's own resolver, because that resolver is what the
  // merged props actually carry: an owner-provided `form` is only one of the two paths.
  const { mount } = loadClientHalf({
    namespaces: [{
      ns: 'include:telegram-app',
      secrets: [
        { path: ['botToken'], set: true },
        { path: ['controlToken'], set: true },
      ],
    }],
    form: {
      getSnapshot: () => ({ status: 'ready', value: { botToken: '', controlToken: '' }, writable: true, revision: 4 }),
      subscribe: () => () => {},
      mutate: async () => true,
    },
  })
  const { tree } = mount({ view: 'page', t: (key) => key, form: undefined })

  const rendered = texts(tree)
  assert.ok(rendered.some((value) => value.includes('botTokenSet')), 'the stored bot token is reported')
  assert.ok(rendered.some((value) => value.includes('controlTokenSet')), 'the stored control token is reported')
  assert.equal(
    rendered.some((value) => value.includes('botTokenUnset') || value.includes('controlTokenUnset')),
    false,
    'nothing claims a token is missing while one is stored',
  )
})

test('a secret the host reports as unset says so', () => {
  const { mount } = loadClientHalf({
    namespaces: [{
      ns: 'include:telegram-app',
      secrets: [
        { path: ['botToken'], set: false },
        { path: ['controlToken'], set: true },
      ],
    }],
    form: {
      getSnapshot: () => ({ status: 'ready', value: { botToken: '', controlToken: '' }, writable: true, revision: 4 }),
      subscribe: () => () => {},
      mutate: async () => true,
    },
  })
  const { tree } = mount({ view: 'page', t: (key) => key, form: undefined })

  const rendered = texts(tree)
  assert.ok(rendered.some((value) => value.includes('botTokenUnset')), 'the missing bot token is reported')
  assert.ok(rendered.some((value) => value.includes('controlTokenSet')), 'the stored control token is reported')
})

test('the page states its reason when the host serves no matching settings entry', () => {
  const { mount, injected } = loadClientHalf()

  // This is the situation found in the live UI: the Plugins page passes no form
  // (its lookup uses the row id) and the entry's own lookup finds nothing either.
  // The page must say so rather than render a blank box.
  const missing = mount({ view: 'page', t: (key) => key, form: undefined })
  const [notice] = texts(missing.tree)
  assert.ok(String(notice).includes('unavailable'), 'the unavailable copy is shown')
  assert.ok(String(notice).includes('no settings entry matches'), 'the diagnostics travel with the notice')

  assert.equal(typeof injected.resolveForm, 'function', 'the entry injects its own resolver')
})

test('the page falls back to the mirror when the Plugins page passes no form', async () => {
  // The entry's resolver is what the merged props carry, so the scenario is
  // staged the way the framework stages it: the host serves a namespace whose id
  // carries the `include:` prefix, and the owner prop is absent.
  const mutationCalls = []
  const { mount } = loadClientHalf({
    namespaces: [{ ns: 'include:telegram-app' }],
    form: {
      getSnapshot: () => ({ status: 'ready', value: { botToken: 'token-a', controlToken: '' }, writable: true, revision: 4 }),
      subscribe: () => () => {},
      mutate: async (ops, revision) => {
        mutationCalls.push({ ops, revision })
        return true
      },
    },
  })
  const page = mount({ view: 'page', t: (key) => key, form: undefined })

  const inputs = findAll(page.tree, (node) => node.type === 'input')
  assert.deepEqual(inputs.map((node) => node.props.value), ['token-a', ''])
  findOne(page.tree, CONTROL_INPUT, 'the control token input').props.onChange({ target: { value: 'typed' } })
  await findOne(page.tree, FIRST_BUTTON, 'the save button').props.onClick()
  assert.deepEqual(mutationCalls[0], { ops: [{ op: 'set', path: ['controlToken'], value: 'typed' }], revision: 4 })
})

test('a save writes only the field the reader edited', async () => {
  const { mount } = loadClientHalf()
  const calls = []
  const form = {
    state: { status: 'ready', value: { botToken: '', controlToken: '' }, writable: true, revision: 3 },
    mutate: async (ops, revision) => {
      calls.push({ ops, revision })
      return true
    },
  }

  const page = mount({ view: 'page', t: (key) => key, form })
  findOne(page.tree, BOT_INPUT, 'the bot token input').props.onChange({ target: { value: '123456:AA-token' } })

  // The state change re-rendered, so the live tree now carries the draft and an
  // enabled save.
  const button = findOne(page.tree, FIRST_BUTTON, 'the save button')
  assert.equal(button.props.disabled, false, 'an edited form becomes saveable')
  await button.props.onClick()

  assert.equal(calls.length, 1, 'one mutation per save')
  assert.deepEqual(calls[0].ops, [{ op: 'set', path: ['botToken'], value: '123456:AA-token' }])
  assert.equal(calls[0].revision, 3, 'the write is fenced by the revision the drafts were read at')
})

test('editing both fields sends both ops in one write', async () => {
  const { mount } = loadClientHalf()
  const calls = []
  const form = {
    state: { status: 'ready', value: { botToken: '', controlToken: '' }, writable: true, revision: 5 },
    mutate: async (ops, revision) => {
      calls.push({ ops, revision })
      return true
    },
  }

  const page = mount({ view: 'page', t: (key) => key, form })
  findOne(page.tree, BOT_INPUT, 'the bot token input').props.onChange({ target: { value: 'token-a' } })
  findOne(page.tree, CONTROL_INPUT, 'the control token input').props.onChange({ target: { value: 'secret-b' } })
  await findOne(page.tree, FIRST_BUTTON, 'the save button').props.onClick()

  assert.equal(calls.length, 1, 'both edits ride one revision-fenced mutation')
  assert.deepEqual(calls[0].ops, [
    { op: 'set', path: ['botToken'], value: 'token-a' },
    { op: 'set', path: ['controlToken'], value: 'secret-b' },
  ])
})

test('a refused save keeps the drafts and says so', async () => {
  const { mount } = loadClientHalf()
  const form = {
    state: { status: 'ready', value: { botToken: '', controlToken: '' }, writable: true, revision: 1 },
    mutate: async () => false,
  }

  const page = mount({ view: 'page', t: (key) => key, form })
  findOne(page.tree, BOT_INPUT, 'the bot token input').props.onChange({ target: { value: 'bad' } })
  await findOne(page.tree, FIRST_BUTTON, 'the save button').props.onClick()

  assert.equal(findOne(page.tree, BOT_INPUT, 'the bot token input').props.value, 'bad', 'the draft survives a refusal so it can be corrected')
  assert.ok(texts(page.tree).includes('saveFailed'), 'the refusal is reported')
})

test('an accepted save clears the drafts and confirms', async () => {
  const { mount } = loadClientHalf()
  const form = {
    state: { status: 'ready', value: { botToken: '', controlToken: '' }, writable: true, revision: 2 },
    mutate: async () => true,
  }

  const page = mount({ view: 'page', t: (key) => key, form })
  findOne(page.tree, BOT_INPUT, 'the bot token input').props.onChange({ target: { value: 'token-a' } })
  await findOne(page.tree, FIRST_BUTTON, 'the save button').props.onClick()

  assert.ok(texts(page.tree).includes('saved'), 'acceptance is confirmed')
  assert.equal(findOne(page.tree, FIRST_BUTTON, 'the save button').props.disabled, true, 'nothing is left to save')
})

test('a read-only deployment disables the controls', () => {
  const { mount } = loadClientHalf()
  const page = mount({
    view: 'page',
    t: (key) => key,
    form: { state: { status: 'ready', value: {}, writable: false, revision: 1 }, mutate: async () => true },
  })
  assert.equal(findAll(page.tree, (node) => node.type === 'input').every((node) => node.props.disabled === true), true)
  assert.ok(texts(page.tree).includes('notWritable'))
})

test('the file is a client bundle, not an ES module', () => {
  // The loader hands the file to a factory with its own `require`; an ESM export
  // would never run, and DSH would report the plugin as having no client half.
  assert.ok(CLIENT_SOURCE.startsWith('window.__ModuleLoader__.load({'), 'uses the client module loader dialect')
  assert.equal(/^\s*export\s/mu.test(CLIENT_SOURCE), false, 'declares no ESM exports')
  assert.equal(CLIENT_SOURCE.includes('require("react/jsx-runtime")'), true)
})

test('the manifest satisfies the client-module scanner', () => {
  // The scanner reads `dsh.client`, requires `platform: 'web'`, and resolves
  // `exports['./client']`, which must be a string or an object with a string
  // `default` — anything else throws at startup and the whole page fails to
  // build its module graph. This mirrors that check.
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(CLIENT_PATH), '..', 'package.json'), 'utf8'))
  assert.equal(manifest.dsh.client.platform, 'web')

  const client = manifest.exports['./client']
  const relative = typeof client === 'string' ? client : client?.default
  assert.equal(typeof relative, 'string', 'exports["./client"] must be a string or expose a string default')
  assert.equal(fs.existsSync(path.join(path.dirname(CLIENT_PATH), '..', relative)), true, 'the declared client bundle exists')

  // A bare specifier inside the file must be served by the shell: a client half
  // may only require React and the modules it declares here.
  const required = [...CLIENT_SOURCE.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1])
  const allowed = new Set(['react', 'react/jsx-runtime'])
  for (const name of required) assert.equal(allowed.has(name), true, `unexpected require: ${name}`)

  // Packages whose services the file uses must be loaded before it.
  const inject = manifest.dsh.client.inject
  assert.ok(inject.includes('@deepseek-ai/dsh-client-locale'), 'ctx.locale comes from the locale entry')
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-slots'), 'ctx.slots comes from the slots entry')
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'), 'the slot it fills is declared there')
})
