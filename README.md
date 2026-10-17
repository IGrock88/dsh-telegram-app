# dsh-telegram-app

Telegram bridge for [DeepSeek Harness](https://github.com/deepseek-ai): drive your local
agent from a Telegram chat — send tasks as plain text, navigate menus with buttons, answer
permission prompts with a tap, and get notified when a turn finishes.

**No domain, no tunnel, no open port.** The bot polls the Telegram Bot API over outbound
HTTPS, so layer 1 works on a laptop behind NAT. A public HTTPS origin is needed only for
the optional Mini App panel (layer 2), which ships disabled.

Русская версия: [README.ru.md](README.ru.md).

---

## What you get

The agent keeps running where it always runs — in the Harness on your machine. Telegram
becomes a remote control for it:

- an ordinary chat where a message is a task for a Session;
- a menu that walks Workspaces → chats → one chat, all by buttons;
- notifications when a long turn finishes or fails;
- approval requests as buttons, so a dangerous tool call can be allowed or refused from a
  phone;
- a settings screen whose changes survive a restart.

## Features

- **Control-token pairing.** A stranger who finds the bot can neither drive the agent nor
  read what Harness sends. The chat is bound only after the owner sends a generated secret.
- **Browse and bind Sessions.** Workspaces come from the Harness registry, so folders and
  titles match the Web UI sidebar; every Session keeps its real name, not an id.
- **Create Sessions from the chat.** `/new` creates a Session in the bound folder, in a
  named folder, or at an explicit path.
- **Plain text as a prompt.** Anything you type goes to the bound Session; a reply names
  the Session it landed in.
- **Queued and steered prompts.** A prompt into a busy Session is queued rather than lost.
- **Read the tail of a Session.** `/last` or the `📄 Последние 5` button prints recent
  messages in full — tool calls are never presented as an answer.
- **Stop a running turn** with `/stop` or `⏹ Стоп`.
- **Idle and error notifications**, with a per-chat switch and a minimum-runtime filter so
  short turns do not spam.
- **Approval requests by buttons**, with three modes: ask in the chat, mirror only, or stay
  silent.
- **Per-chat settings** — how many chats a folder shows, how folders are ordered, whether
  notifications arrive — applied on tap and survived across restarts.
- **A settings form in the Harness Web UI** (Plugins → card → Configure), so deployment
  values do not have to be edited in YAML by hand.
- **Russian and English chat copy**, switched by one setting. Command *names* are never
  translated, so muscle memory and scripts keep working across a language change.
- **Graceful degradation.** No Session controller, no Workspace registry, no Web server —
  the plugin still mounts and says what is missing instead of failing.
- **Optional Mini App panel** (layer 2), served by the Harness Web server at `/tg-app`.

## Requirements

| | |
| --- | --- |
| Node.js | `>= 22.19` (see `engines` in `package.json`) |
| DeepSeek Harness | a profile whose bundle list can take this package |
| Telegram | a bot created via [@BotFather](https://t.me/BotFather), and a **private** chat with it |
| Optional | a public HTTPS origin, only for the Mini App panel |

Group and channel chats are deliberately ignored: the bridge drives one person's agent, and
authorising a group would mean authorising everyone in it.

## Installation

The package is not published to npm yet, so install it from a checkout. Inside your profile:

```bash
# from a local clone (a link: dependency — edits are picked up on restart)
dsh plugin --profile web add link:/path/to/dsh-telegram-app

# or from a git URL
dsh plugin --profile web add git+https://github.com/IGrock88/dsh-telegram-app.git
```

The bundle's patch inserts one loader row:

```yaml
- insert:
    - id: telegram-app
      name: dsh-telegram-app
```

Configuration is intentionally *not* part of the bundle: secrets and deployment values
belong to your profile, and a later patch replaces the whole `config` object of a row rather
than merging into it.

Restart `dsh web` after installing. On the first start the plugin generates a control token
and publishes it into its own settings entry.

> **Restarting the server from inside an agent session kills that session.** If you drive
> the Harness through this very bot, stop and start the server from your own terminal.
> `tools/restart-server.ps1` does it on Windows and writes the startup log to a file.

## Configuration

Every value has a built-in default, so the plugin works with an empty config once a bot
token is present.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `botToken` | string, secret | `''` | Token from @BotFather. A blank field in the form leaves the stored value untouched. |
| `controlToken` | string, secret | `''` | The secret you send the bot once, in the chat, to authorise it. Generated on first run when empty. |
| `locale` | string | `ru` | The language the bot speaks in the chat: `ru` or `en`. See [Language](#language). |
| `publicBaseUrl` | string | `''` | Public HTTPS origin for the Mini App. Empty keeps layer 2 off entirely. |
| `appPath` | string | `/tg-app` | Path the Mini App owns on the Harness Web server. Read once, at mount. |
| `apiBase` | string | `https://api.telegram.org` | Bot API origin, replaceable by a local reverse proxy. |
| `proxy` | string | `''` | HTTP proxy for the Bot API; falls back to `HTTPS_PROXY`. |
| `allowedUserIds` | number[] | `[]` | Extra Telegram user ids allowed to talk to the bot besides paired chats. |
| `cwd` | string | `''` | Fallback working directory for `/new` when no folder can be inferred. |
| `sessionLimitDefault` | number | `5` | How many chats a folder shows, for chats that never opened the settings screen. One of `3`, `5`, `10`, `15`. |
| `workspaceSortDefault` | string | `registry` | Folder order: `registry` (sidebar order) or `activity`. |
| `notifyDefault` | boolean | `true` | Whether notifications start enabled for a chat. |
| `notifyOnIdle` | boolean | `true` | Send a message when a turn finishes. |
| `notifyMinRunSeconds` | number | `20` | Ignore turns shorter than this, so quick answers do not spam. |
| `approvalMode` | string | `ask` | `ask` — answer from the chat when no browser is attached; `notify` — mirror only; `off` — stay silent. |
| `approvalTimeoutSec` | number | `180` | How long a chat approval question waits before other answerers take over. |
| `sessionTokenTtlSec` | number | `43200` | Lifetime of a Mini App session token (layer 2). |
| `initDataMaxAgeSec` | number | `86400` | How old a Mini App `initData` payload may be (layer 2). |
| `pollTimeoutSec` | number | `30` | Long-poll timeout handed to Telegram. |
| `statePath` | string | `''` | State file; empty means `<DSH_HOME>/telegram-app/state.json`. |

Values are resolved in this order: **the chat's own setting → the plugin config → the
built-in default**.

### The settings form in the Web UI

The form lives in the **Plugins** section of the Harness Web UI — the sidebar entry above
`Workspaces`. Open the `dsh-telegram-app` card and press **Configure**.

Two properties of that form are worth knowing, because both look like faults:

**A secret field is always blank, even when a value is stored.** `role('secret')` fields are
stripped from everything the client receives, so a configured token cannot be displayed. The
form states whether a value is stored instead of pretending the field is empty: *"A token is
configured — leave blank to keep it."* Submitting an untouched field leaves the stored value
alone; only fields you actually edit are written.

**A field that is not `volatile` does not appear.** The Harness projects a plugin's settings
through its volatile fields only, and drops the entry entirely when none qualify. That is why
`botToken`, `controlToken` and the per-chat defaults are declared volatile, while `appPath`,
`apiBase`, `proxy` and `statePath` are not — they are read once, at mount, and the form does
not pretend otherwise.

### Environment variables

Useful for a deployment that keeps secrets out of YAML.

**The environment wins when both are set.** That is the opposite of the usual rule, and it is
deliberate: the Harness resolves a plugin's config through its schema before the plugin starts,
so a field that declares a default always arrives holding it. If the config won, every variable
below whose field has a non-empty default (`locale`, `appPath`, `apiBase`) would be silently
dead — the setting would look applied while the bot kept the old value.

| Variable | Field |
| --- | --- |
| `DSH_TG_BOT_TOKEN` | `botToken` |
| `DSH_TG_CONTROL_TOKEN` | `controlToken` |
| `DSH_TG_PUBLIC_URL` | `publicBaseUrl` |
| `DSH_TG_APP_PATH` | `appPath` |
| `DSH_TG_API_BASE` | `apiBase` |
| `DSH_TG_PROXY` | `proxy` |
| `DSH_TG_CWD` | `cwd` |
| `DSH_TG_STATE_PATH` | `statePath` |
| `DSH_TG_LOCALE` | `locale` |
| `DSH_TG_SETTINGS_NS` | settings namespace override |
| `DSH_TG_ALLOWED_USERS` | comma-separated ids for `allowedUserIds` |

### Language

The bot speaks Russian (`ru`) or English (`en`). Set `locale` in the settings form, in
`cordis.patch.yml`, or through `DSH_TG_LOCALE`; the default is `ru`. The value is normalised,
so `EN`, `en-GB` and `en_GB` all mean English, and anything unrecognised falls back to
Russian rather than leaving the bot mute.

The setting applies to **the whole deployment**, not per chat: one bot, one language. It takes
effect on the next start, which is also when the bot re-publishes its command hints to
Telegram.

What changes and what does not:

| | |
| --- | --- |
| Translated | Screens, buttons, command *descriptions*, notifications, approval cards, error messages, time units (`5 мин` → `5 min`). |
| Not translated | Command *names* — `/menu` stays `/menu`. Data: Session titles, folder names, file paths, and the agent's own answers. |

Counted phrases follow each language's own grammar rather than a shared rule: Russian needs
three plural forms (`1 сессия`, `2 сессии`, `5 сессий`) where English needs two (`1 session`,
`2 sessions`), so the agreement lives with the words instead of in one helper.

A missing translation falls back to Russian and then to the key itself, so a gap in a
dictionary shows up as the wrong language on one line rather than as an empty message.

> **Layer 2 is Russian-only.** The optional Mini App panel (`web/`) has its own interface,
> which so far exists in Russian only. Layer 1 — the entire chat experience — is fully
> bilingual.

### Profile patch

The same values can be written into the profile's `cordis.patch.yml`:

```yaml
- id: telegram-app
  config:
    botToken: '<token from @BotFather>'
```

A patch **replaces** the whole `config` object of the row; it does not deep-merge. When you
override, restate every field you need — otherwise the omitted ones fall back to their
defaults. `controlToken` may be left out: the plugin generates one and publishes it into the
form.

## Pairing a chat

1. Start the bot in Telegram and send it any message. An unpaired chat gets the `whoami`
   answer and an instruction to send the control token; it cannot reach a Session.
2. Read the control token from the plugin's settings form (Plugins → `dsh-telegram-app` →
   Configure → **Control token**). It is generated on the first run.
3. Send that token to the bot as one message. The chat is now paired; the bot confirms and
   prints the menu.

What happens to the token:

- only its **SHA-256 digest** is written to `state.json` — the value itself never touches
  the disk, and never appears in a log;
- changing the token does **not** drop chats that already proved knowledge of an older one,
  so you can rotate it without re-pairing;
- if the plaintext is lost — a failed publish, or a form that did not expose the field yet —
  the plugin treats the stored digest as *not armed* and issues a fresh token on the next
  start, because an armed token nobody can present would make the bot refuse every message.

Unpair with `/unpair` (it asks for confirmation).

## Commands

| Command | Action |
| --- | --- |
| `/start`, `/menu` | Open L0 (the menu). |
| `/chats`, `/chats <n>` | L1 (workspaces); with a number, L2 of that folder directly. |
| `/use <n\|id>` | Bind a Session and show L3. Accepts a row number or an id prefix. |
| `/new [path]` | Create a Session. Directory order: the argument → an explicitly named folder → the bound folder → `cwd` → the first registry folder. |
| `/last [n]` | Recent messages of the bound Session (default 5, at most 10). |
| `/stop` | Cancel the running turn. |
| `/status` | Chat, binding, Session, counters, availability of the Harness services. |
| `/settings` | Open screen S. |
| `/notify on\|off` | Turn notifications on or off for this chat. |
| `/limit <3\|5\|10\|15>` | How many chats a folder shows. |
| `/sort registry\|activity` | Folder order. |
| `/unbind` | Unbind the Session from the chat (the Session itself is untouched). |
| `/unpair` | Revoke the chat's authorisation, with confirmation. |
| `/whoami` | Your `user id`, `chat id` and status. Works without authorisation, rate-limited. |
| `/help` | Command list. |

Any message that is not a command is a task: it is sent to the bound Session. Messages
longer than 8000 characters are refused with a hint rather than truncated.

## Screens and buttons

Screens are edited in place where Telegram allows it, and re-sent when it refuses — so a
long list never leaves a trail of dead messages.

**L0 — the menu.** Pairing age, whether notifications are on, how many turns are running and
how many Sessions are reachable.
Buttons: `📁 Воркспейсы`, `⚙️ Настройки`.

**L1 — workspaces.** One row per folder that actually holds a suitable Session, with its
count. Folders with nothing to show are left out rather than shown empty.
Buttons: `📁 <folder> · <n>` per row, `🔄 Обновить`, `⚙️ Настройки`, `🏠 Меню`.

**L2 — the chats of one folder.** The last N Sessions, newest first, two per row; a bound
one is marked `📌`.
Buttons: the Session rows, `➕ Новая в этой папке`, `🔄 Обновить`, `⬅️ Воркспейсы`,
`⚙️ Настройки`, `🏠 Меню`.

**L3 — one Session.** Title, short id, folder, state (🟢 running / ⚪ waiting for input),
when it last changed, and the last assistant answer.
Buttons: `⏹ Стоп`, `📄 Последние 5`, `🔄 Обновить`, `⬅️ К чатам`, `⚙️ Настройки`, `🏠 Меню`.

**S — settings.** Three rows that apply their value on tap, with the active one marked `•`:
chats per folder, folder order, notifications.
Buttons: the value rows, `⬅️ Меню`.

Which Sessions appear at all: root Sessions only — subagents, their descendants, blank
Sessions (never held a turn), archived ones, and Sessions without a working directory are
filtered out, because a Session without a directory floats outside every folder and would
never be reachable from the Web UI either.

## Notifications

When a turn finishes, every paired chat with notifications on receives one message:

```
✅ <Session title> · 1 мин 11 с
```

with buttons `📄 Последний ответ` and `📌 Открыть`. Turns shorter than
`notifyMinRunSeconds` are skipped, so a quick answer does not buzz a phone.

A failed turn produces a `⚠️` message carrying the reason, throttled to one per Session per
five minutes — an agent that fails in a loop does not become a chat flood.

The bridge also keeps the persistent `🏠 Меню` reply button installed, sent once when the
chat pairs. It is sent as its own message because Telegram accepts exactly one `reply_markup`
per message: attaching it to every screen would silently replace the screen's own buttons.

## Approval requests

When the Harness asks a human to approve a tool call, and no browser client is attached, the
question is mirrored into the chat with two buttons:

- `✅ Разрешить`
- `⛔ Отклонить`

A tap answers the Harness request directly, and the first answer wins: a question that
expires in the chat simply stops accepting taps. `approvalMode` decides whether the chat is
asked at all (`ask`), only informed (`notify`), or left alone (`off`). When a browser is
attached the chat stays out of the way, because someone is already looking at the real
prompt.

## Layer 2: the Mini App panel

A small web panel served by the Harness Web server at `/tg-app`, opened from a Telegram Mini
App button. It talks to the same Sessions through a JSON API.

**It is off unless configured.** The route is registered only when `publicBaseUrl` is an
`https://` origin, because Telegram refuses to open a Mini App over plain HTTP — and a route
Telegram cannot load is worse than no route. Without it the plugin logs
`Mini App route not registered (no public HTTPS origin configured)` and layer 1 is unaffected.

What it adds:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness of the panel route. |
| `POST /api/list` | Workspaces and Sessions. |
| `POST /api/session` | One Session's card and history. |
| `POST /api/prompt` | Send a prompt (`queue` or `steer`). |
| `POST /api/cancel` | Cancel the running turn. |
| `POST /api/create` | Create a Session in a workspace or directory. |
| `GET /api/stream` | Follow a Session's events. |

Security on this path:

- the Telegram `initData` payload is verified with an HMAC over the bot token, and rejected
  when older than `initDataMaxAgeSec`;
- a verified user gets a short-lived session token (`sessionTokenTtlSec`) instead of
  repeating `initData` on every call;
- only users that pass the same authorisation as the chat are served.

## Architecture

```
index.js              plugin entry: config schema, wiring, layer 2 route registration
cordis.patch.yml      bundle layer: inserts the loader row
lib/schema.mjs        the Config schema the Harness reads
lib/state.mjs         state.json: schema v1, atomic writes, per-chat settings
lib/chat.mjs          command router, screens, callbacks, notifications, approvals
lib/screens.mjs       pure renderers for L0/L1/L2/L3/S — no I/O, so they are testable
lib/nav.mjs           Session filtering and Workspace grouping
lib/markup.mjs        the callback vocabulary and the 64-byte payload guard
lib/sessions.mjs      wrapper over ctx.sessionController
lib/bot.mjs           Bot API transport: long polling, splitting, keyboards
lib/auth.mjs          Mini App initData verification and session tokens
lib/routes.mjs        the layer 2 HTTP API
lib/format.mjs        text and number formatting shared by the screens
lib/client.js         the settings form half that runs in the browser
locale/               UI strings for the client half
web/                  Mini App assets (layer 2)
test/                 offline tests, no network and no Harness required
tools/                developer scripts (restart helper, apply-probe)
SPEC-layer1.md        behaviour specification: screen texts, callbacks, acceptance list
```

Two things about the shape of this plugin are unusual and worth stating plainly.

**The settings form is a separate, browser-side half.** A `Config` schema alone does *not*
produce a form: the slot the Plugins page renders is filled by the plugin's own companion
code. `lib/client.js` is that half, and it is **not an ES module** — it is written in the
loader dialect (`window.__ModuleLoader__.load({ id, factory })`) and registers into
`plugins.row.config` under the key `` `${package name}#${row id}` ``.

**Every Harness service is optional.** The plugin declares `inject: []` and looks services up
lazily through `ctx.get`, so a composition without a Session controller, a Workspace
registry or a Web server still mounts — it just reports what is unavailable.

## Security

- **Private chats only.** Group and channel updates are ignored with a one-line hint.
- **The control token is the only way in**, compared as a SHA-256 digest in constant time.
- **Five failed attempts pause the chat for 15 minutes**, so the token cannot be guessed by
  brute force from the chat itself.
- **Only a digest is persisted.** `state.json` holds `controlTokenHash`; neither the control
  token nor the bot token is ever written to disk or to a log by this plugin.
- **An allow-list can widen access deliberately** through `allowedUserIds`, for a second
  person or a second account.
- **Mini App payloads are signature-checked and time-boxed** before any Session is touched.
- The state file is written atomically (temp file + rename) with owner-only permissions where
  the platform supports them. On Windows that POSIX mode is a no-op — access there is
  governed by the file's ACL.

## Tests

```bash
npm test            # node --test test/*.test.mjs
```

213 tests, all offline: no network, no live Telegram, no running Harness. They cover the
transport payloads, the screens' exact wording and buttons, the callback parser, Session
filtering, `state.json` migration and atomic writes, the client half rendered against a fake
plugin loader, and the plugin mounting against a fake host.

The suite is meant to be read as documentation of intent — several tests exist because a
specific production bug got past every screen-level assertion. Two habits keep it honest:

- a fake mirrors the *real* shape of the API it stands in for, including the parts that
  throw, so a call pattern the Host would reject fails here too;
- a fix is only trusted after reverting it makes a test fail.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The plugin shows `Running`, but there is no Configure button | The client half did not load. Check that `lib/client.js` is in the package and that `dsh.client.platform` is `web`, then restart the server. |
| Configure opens, but says the deployment does not expose settings | The plugin's settings entry is missing from the Host's list. It appears only when at least one schema field is `.volatile()`. |
| The token fields look empty after saving | Expected: secrets are never sent back to a browser. The hint under each field says whether a value is stored. |
| The bot ignores every message | The chat is not paired, or the plugin is not running. `/whoami` answers even without authorisation. |
| A button answers "the button is stale" | The callback payload has no route in the parser. This happens when a renderer emits a prefix the parser does not know; both live in this package and must be changed together. |
| `History unavailable: session page through seq … is past cursor …` | The history request asked for a log cut beyond the real one. The cut must come from a `follow` opening snapshot. |
| "This session has no messages yet" while it does | The page was computed from a cut of `-1`, which validates but yields an empty window. |
| A long answer arrives cut short | It is not: a marker `…` is appended only when the text really exceeded the limit. |
| A reply shows tool names like `→ shell` instead of an answer | Should not happen — tool calls carry no user-facing text and are skipped. A turn that ends in tool calls falls back to the prose before it. |
| A message to the Session fails with `Cannot read properties of undefined (reading 'throwIfAborted')` | A Harness method that dereferences its cancellation signal without a guard was called without one. The wrapper always passes a real signal. |
| A newly created Session immediately shows as "unavailable" | The read model had not indexed it yet. The bridge re-reads once and keeps the binding; it unbinds only on positive evidence. |

## Development

```bash
# run the tests
npm test

# watch which branch the plugin takes with a given config, without a live Harness
DSH_TG_BOT_TOKEN=... DSH_TG_CONTROL_TOKEN=... npm run probe
```

`tools/probe-apply.mjs` builds a faithful fake host and runs the plugin's real `apply()`
against it, printing the schema's volatile/secret counts, the config the loader *would* hand
over, the plugin's own log lines and the state it wrote. It is the quickest way to tell a
configuration problem from a code problem. It takes credentials from `DSH_TG_*` and uses
placeholders when none are set.

On Windows, `tools/restart-server.ps1` restarts `dsh web` and writes the startup log to
`dsh-web.log` / `dsh-web.err.log`, because the console window does not keep it:

```powershell
powershell -ExecutionPolicy Bypass -File tools\restart-server.ps1
```

Run it from your own terminal. If you drive the Harness through this bot, asking the agent to
restart the server kills the agent mid-command and the log is never written.

## License

[MIT](LICENSE)
