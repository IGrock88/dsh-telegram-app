/**
 * The plugin's `Config` schema.
 *
 * A real schema is what turns the plugin's row on the DSH Plugins page into a
 * working settings form, so this file is load-bearing rather than decorative:
 * it declares every field the runtime reads, gives each one a default, and marks
 * the two secrets with `.role('secret')` so the settings service renders them
 * write-only and never sends their values back to a browser.
 *
 * The builder is `@deepseek-ai/schemastery`, declared as a dependency **and**
 * installed inside this package. That second part is not optional: the plugin is
 * normally installed with `dsh plugin add link:<path>`, and Node resolves a bare
 * specifier from the package's real path rather than from the profile's
 * `node_modules` — so declaring the dependency without installing it would leave
 * the import unresolved and the settings form impossible to generate.
 */
import z from '@deepseek-ai/schemastery'
import { DEFAULT_LOCALE } from './i18n.mjs'
import { DEFAULT_SETTINGS, SESSION_LIMITS, WORKSPACE_SORTS } from './state.mjs'

/** The schema package the settings form is generated from. */
export const SCHEMA_PACKAGE = '@deepseek-ai/schemastery'

/**
 * Build the config schema.
 *
 * This is exported as a plain schema object, which is what the host reads to
 * generate the plugin's settings page, and it is built eagerly rather than
 * lazily. The earlier lazy version was wrong in a way worth recording: it
 * returned a wrapper (`{ schema, loaded }`), so the host found no schema at all
 * and the settings form silently never appeared — the one outcome the lazy
 * fallback was meant to avoid. Since the dependency is declared, installed and
 * verified to resolve through the profile's `link:`, an eager build is both
 * simpler and honest: if the builder is missing, activation fails loudly instead
 * of producing a plugin that looks installed but cannot be configured.
 *
 * @returns the schema for the plugin's row config.
 */
export function buildConfigSchema() {
  if (!z || typeof z.object !== 'function') {
    throw new Error(`${SCHEMA_PACKAGE} exposes no schema builder`)
  }
  try {
    return z.object({
      /**
       * BotFather token. Secret, so the form is write-only for this field.
       *
       * `.volatile()` is what makes a field *editable at all*. The host projects a
       * plugin's settings through `volatileForm`, which keeps only fields whose
       * nearest volatile ancestor marks them as changeable without remounting —
       * and drops the entry entirely when no field qualifies. A schema with no
       * volatile field therefore produces **no settings namespace**, which is why
       * the Plugins page offered no configuration here even though the schema
       * loaded and the host reported it.
       */
      botToken: z.string().default('').role('secret').volatile(),
      /**
       * The secret the owner sends to the bot once to authorize a chat. Secret as
       * well, because it is the only factor guarding the bridge (§11), and
       * volatile so the generated value can be read from this form.
       */
      controlToken: z.string().default('').role('secret').volatile(),
      /**
       * The language the bot speaks: `ru` or `en`.
       *
       * Volatile, so it can be changed from the settings form and take effect on the next
       * restart, which is also when the bot's own command hints are re-published. Command
       * *names* are never translated — `/menu` stays `/menu` — only the copy around them.
       */
      locale: z.string().default(DEFAULT_LOCALE).volatile(),
      /** Public HTTPS origin for the Mini App (layer 2); empty keeps layer 2 off. */
      publicBaseUrl: z.string().default('').volatile(),
      /**
       * Path the Mini App owns on the Harness web server; used only when layer 2
       * is on. Not volatile: the route is registered once, at mount.
       */
      appPath: z.string().default('/tg-app'),
      /** Bot API origin, replaceable by a local reverse proxy. Not volatile: transport setup is mount-time. */
      apiBase: z.string().default('https://api.telegram.org'),
      /** HTTP proxy for the Bot API; empty falls back to `HTTPS_PROXY`. Not volatile, like the transport above. */
      proxy: z.string().default(''),
      /** Extra Telegram user ids allowed to talk to the bot besides paired chats. */
      allowedUserIds: z.array(z.number()).default([]).volatile(),
      /** Working directory `/new` uses when no folder can be inferred (§6). */
      cwd: z.string().default('').volatile(),
      /** Default for the per-chat "how many chats in a folder" setting (§5). */
      sessionLimitDefault: z.number().default(DEFAULT_SETTINGS.sessionLimit).volatile(),
      /** Default for the per-chat folder ordering (§4). */
      workspaceSortDefault: z.string().default(DEFAULT_SETTINGS.workspaceSort).volatile(),
      /** Default for the per-chat notification switch (§5). */
      notifyDefault: z.boolean().default(DEFAULT_SETTINGS.notify).volatile(),
      /** Send a chat message when a turn finishes (§8). */
      notifyOnIdle: z.boolean().default(true).volatile(),
      /** Ignore turns shorter than this many seconds (§8). */
      notifyMinRunSeconds: z.number().default(20).volatile(),
      /** `ask` answers from the chat when no browser is attached, `notify` only mirrors, `off` stays silent. */
      approvalMode: z.string().default('ask').volatile(),
      /** How long a chat approval question waits before the other answerers take over. */
      approvalTimeoutSec: z.number().default(180).volatile(),
      /** Lifetime of a Mini App session token (layer 2). */
      sessionTokenTtlSec: z.number().default(12 * 60 * 60).volatile(),
      /** How old a Mini App payload may be (layer 2). */
      initDataMaxAgeSec: z.number().default(24 * 60 * 60).volatile(),
      /** Long-poll timeout handed to Telegram. */
      pollTimeoutSec: z.number().default(30).volatile(),
      /** State file path; empty means `<DSH_HOME>/telegram-app/state.json`. Not volatile: it is opened at mount. */
      statePath: z.string().default(''),
    })
  } catch (error) {
    throw new Error(`${SCHEMA_PACKAGE} rejected the schema definition: ${String(error?.message ?? error)}`)
  }
}

/** The values the settings screen offers for the session limit (§5). */
export const LIMIT_VALUES = SESSION_LIMITS

/** The values the settings screen offers for the folder ordering (§4). */
export const SORT_VALUES = WORKSPACE_SORTS
