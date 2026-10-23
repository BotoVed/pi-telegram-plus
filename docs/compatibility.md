# Compatibility

Everything in this document is either a measured fact or a direct consequence of one. The
version matrix, the range, and the release gate are kept in sync mechanically — see
[Keeping this honest](#keeping-this-honest) at the end.

- **Supported range:** `@earendil-works/pi-coding-agent >=0.80.7 <1.4.0` (declared in
  `package.json`; that file is the single source of truth).
- **Requires:** Node.js `>=22.19.0`.
- **Unsupported:** pi `0.74.x`, and anything older than `0.80.7` — their public TypeScript
  surface is incompatible with this extension.
- **Unverified:** any pi minor version newer than the matrix. Treat a new minor as
  untested until the matrix passes on it.

## Why the extension survives upstream breakage

Every `@earendil-works/pi-coding-agent` reference in this package is either an `import type`
or a guarded dynamic `import()`. The three optional symbols — `FooterComponent`,
`AgentSession`, `SessionManager` — are resolved once at module scope via top-level `await`
and degrade to a logged no-op when unresolvable, instead of failing extension load.

Two details are load-bearing:

- **Synchronous registration.** pi rejects extension API calls made after an `await` inside
  the extension factory (`Extension runtime not initialized. Action methods cannot be
  called during extension loading.`). The resolution therefore happens at module scope,
  which pi awaits *before* invoking the factory, so `installTelegramStatusAlignment()` stays
  synchronous.
- **The guard, not deferral, is what saves us.** Resolution still happens at load time.
  What prevents a hard failure is the `try`/`catch` around the dynamic `import()`.

This is why the extension tolerates the upstream defects below. It is robustness work
that protects non-CLI consumers (bundlers, test harnesses, our own matrix) and future
upstream changes — **not** a fix for a user-reported failure, because inside the pi CLI both
defects were masked anyway (see each section).

## OMP (`@oh-my-pi/pi-coding-agent`)

OMP is a pi fork with a rewritten session core, so it does not share pi's attach point: its
`AgentSession` has no `bindExtensions()`. The extension runner is built *before* the session
and handed to `new AgentSession(...)`, so the patched prototype never fires and capture used
to log `AgentSession has no bindExtensions(); session capture disabled`, leaving every
Telegram message answered with "π session is not ready yet." A `/pair <code>` reply still
succeeded — pairing is resolved before a session is needed — which made the failure look
like a pairing bug.

Capture now resolves OMP's process-global agent registry on every lookup:

```ts
AgentRegistry.global().get(MAIN_AGENT_ID)?.session        // "Main"
  ?? AgentRegistry.global().list().find(ref => ref.kind === "main")?.session
```

`get(mainId)` is the fast path; the `list()` scan only covers embedded hosts that pass a
custom root `agentId`. The ref's session is re-attached on `/new` and session switches and
detached to `null` on dispose, and resolution happens per call rather than once at load —
so capture also works when the extension loads after the session already exists (`/reload`).

Measured on OMP `18.12.2` (bun-installed, `omp --print`, isolated project plugin root):

- inside an extension, `import("@earendil-works/pi-coding-agent")` is aliased to the host
  module: 746 exports, `AgentRegistry=function`, `MAIN_AGENT_ID="Main"`,
  `AgentSession.prototype.bindExtensions === undefined`;
- `AgentRegistry.global().get("Main").session` is the live top-level session — `prompt`,
  `extensionRunner` and `extensionRunner.createCommandContext().cwd` all present;
- the extension's capture module resolves that same object (`captured=true`,
  `sameAsRegistry=true`).

Two pi-specific behaviors are **not** carried over to OMP, both because OMP has no public
seam for them:

- **Runner UI-context swap.** `runner.setUIContext()` does not exist and `#uiContext` is
  private. The plugin installs a per-runner override of `getUIContext()` / `createContext()`
  that consults the active Telegram UI stack: while a Telegram turn is active those methods
  return the routed UI, and with no active turn they return the host TUI, so local turns are
  untouched. That covers command prompts, tool approvals, session-level selects, extension
  hooks, and extension tools (including pi-goal dialogs). Built-in `ask` and eval-prelude
  contexts (`computer` control) are routed by wrapping the tool execution context and
  `ToolSession.getToolContext`, since they receive `ui` from OMP's private `ToolContextStore`
  rather than the runner. The bash PTY overlay is not a dialog — it is a capability gate on
  `ctx.ui` — and remains local to the terminal.
- **Shutdown-handler replacement.** OMP's runner keeps its shutdown handler private, so
  `/quit` issued from Telegram shuts the host down instead of only notifying.

The **command context API** diverges too: pi exposes `ctx.fork` and a programmatic auth
API (`ModelRuntime.login` / legacy `AuthStorage.getOAuthProviders`); OMP exposes neither —
auth lives in its own credential store and forking goes through `session.fork` /
`ctx.branch`. The Telegram `/login`, `/logout`, `/fork` and `/clone` handlers call those
pi-only surfaces, so on OMP they threw `TypeError: ... is not a function`. Dispatch now
probes the capability before invoking the handler (`hasNativeAuthApi(session)` plus an
OMP host-family check) and, when it is missing, routes the command to the host's own TUI
through the bridge — OMP serves `/login` and `/fork` there and the dialog mirrors back to
Telegram — or returns an explicit run-it-in-the-terminal notice when the bridge is off.
The bridge E2E suite pins both sides: `/login` must open the host login dialog on OMP and
the native Telegram auth menu on pi.

## pi `0.85.0`: the `pi-server` packaging defect

pi `0.85.0`'s published tarball statically imports a package it never declares:

```
dist/index.js → dist/main.js → dist/experimental/server.js
                                    ↓ lines 10–11 (static top-level import)
                             @earendil-works/pi-server  (+ /unix)
```

`@earendil-works/pi-server` appears in **none** of pi `0.85.0`'s dependency fields —
`dependencies`, `optionalDependencies`, `peerDependencies`, `peerDependenciesMeta`, and
`devDependencies` are all empty of it. The package itself does exist on npm at `0.85.0`; the
problem is purely the missing declaration.

A plain Node `import()` of the pi package root therefore throws:

```console
$ node -e "import('@earendil-works/pi-coding-agent/dist/index.js')"
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@earendil-works/pi-server'
imported from .../node_modules/@earendil-works/pi-coding-agent/dist/experimental/server.js
```

**This extension is unaffected**, and the guard is demonstrably what carries it: reverting
just `lib/status-footer.ts` to its `v0.0.10` static value import is enough to turn
`lib/__tests__/status-footer.test.ts` into a hard suite error on `0.85.0`, with exactly the
message above. One file, not six.

**The pi CLI masked this either way.** The CLI serves `@earendil-works/pi-coding-agent` from
its own bundle through a virtual-module alias table, so `dist/experimental/server.js` is
never loaded. A probe confirmed the CLI's dynamic import of the package root returns
`FooterComponent=function / AgentSession=function / SessionManager=function` on both `0.85.0`
and `0.85.1`. The version was excluded in an earlier release primarily because it broke
plain-Node consumers — including this project's own test matrix.

`0.85.1` dropped the reference entirely: zero `.js` files in it mention `pi-server`.

## pi `1.0.1`–`1.1.0`: the `pi-codemode` pin window

pi `0.99.0` and later declare `@earendil-works/pi-codemode` through a **caret range** and
statically import `MCP_TYPESCRIPT_PREAMBLE` from it. That export was removed in
`pi-codemode 1.2.0`, so a lockfile-less `npm install` can float `pi-codemode` forward past
what the pi release expects. `import("@earendil-works/pi-coding-agent")` then fails with
`does not provide an export named 'MCP_TYPESCRIPT_PREAMBLE'`.

Three conditions must line up, and only part of the range satisfies all three:

| pi | ships `npm-shrinkwrap.json` | `pi-codemode` resolves to | bundle imports the symbol | plain Node `import()` |
|---|---|---|---|---|
| `0.80.7`–`0.87.1` | yes | not a dependency | — | ok |
| `0.99.0`–`0.99.2` | yes | `0.99.x` (pinned) | yes | ok |
| `1.0.0` | yes | `1.0.0` (pinned) | yes | ok |
| `1.0.1`–`1.1.0` | no | `1.3.0` | yes | **throws** |
| `1.2.0`–`1.3.0` | no | `1.3.0` | no | ok |

`0.80.7`–`0.87.1` predate the dependency entirely. `0.99.0`–`1.0.0` pin it through a
shrinkwrap, which `1.0.1` dropped — so `1.0.0` is immune by accident, not by design.
`1.2.0` and `1.3.0` escape because their bundles stopped referencing the removed symbol. The
exposed window is therefore exactly pi `1.0.1`–`1.1.0`.

Two independent reasons this extension is unaffected:

1. **No static value imports** (see the section above).
2. **The pi CLI masks the drift anyway** — it resolves the package through its alias table
   rather than the on-disk `pi-codemode`.

The drift is still real and still breaks **plain Node imports** of the pi package root,
which is exactly what a test harness or bundler does:

```console
$ node -e "import('@earendil-works/pi-coding-agent/dist/index.js')"
Error: The requested module '@earendil-works/pi-codemode/declarations'
does not provide an export named 'MCP_TYPESCRIPT_PREAMBLE'
```

The pi **CLI** is unaffected — `pi --print …` runs a full turn normally on a drifted `1.0.4`
install. That asymmetry is why the matrix keeps a mode that exposes it.

### Matrix modes

`npm run test:pi-versions` runs two modes, and **both pass every supported version**:

- **default** — pins each pi version to its contemporaneous `pi-codemode` release,
  reproducing the environment that pi release was built against. This is the mode that
  measures *plugin* compatibility.
- **`--strict-upstream`** — skips the pin, so raw upstream drift is visible. This passes
  too, precisely because the extension never statically imports the pi package root. A
  failure here means a static package-root import was reintroduced, which is why the mode is
  kept: it is a regression sentinel.

## Verification suites

| Suite | What it does | Command |
|---|---|---|
| `typecheck` | `tsc --noEmit` over the package | `npm run typecheck` |
| Unit / regression | 38 files, 542 tests | `npm test` |
| Version matrix | Installs each pi version into a fresh temp tree, runs `typecheck` + tests | `npm run test:pi-versions` |
| E2E acceptance | Real pi in `tmux` + mock Telegram Bot API + mock OpenAI provider | `npm run test:e2e` |
| TUI bridge E2E matrix | Every pi version recorded E2E-passed plus OMP; local mirror, dynamic menu, selector mirrors incl. per-option buttons and Prev/Next paging, all key/type callbacks, bash streaming/exit/context policy | `npm run test:e2e:tui-bridge` |
| OMP E2E acceptance | Real OMP `18.12.x` in `tmux` + the same mocks; asserts round trip, `/new` Telegram confirmation, post-`/new` capture, cursor rewind | `npm run test:e2e:omp` |
| Command acceptance | Real pi + OMP in isolated `tmux` with the same mocks: dispatches every command the bot advertises (plus the hidden `/tg-*` management commands), walks `/tg` levels 1-4 (Bots → list → detail, Project → bind, Config → every flow, Commands → entry, Switch instance), covers `/model`, `/scoped-models`, `/login`, `/logout`, `/settings`, `/reload`, `/quit`, `/exit`, `/tg-cwd-disconnect`, and drives a real `ask` tool call end-to-end (mock provider emits the tool_call; the prompt is mirrored and answered through Telegram). The mock Bot API enforces the real payload contract (400 on violations), every recorded call is re-validated independently, and TUI mirrors are cross-checked against the host's `tmux` pane | `npm run test:e2e:commands` |
| Interaction parity | Boots a fresh isolated host for *every* advertised command (OMP 92, pi 28), records the host screen and the Telegram surface side by side, and fails when a host dialog reached Telegram as plain text or dead buttons. Re-run with `npm run test:e2e:parity` (`--host pi|omp|both`, `PITG_PARITY_COMMANDS=/model,/settings`) | `npm run test:e2e:parity` |
| Real Bot API smoke | Round-trips one temporary message through api.telegram.org (send → edit → delete) with the configured bot, and asserts the real API rejects an unsupported HTML tag while the local validator agrees | `npm run test:e2e:real` |

The **E2E run asserts the whole round trip, not just startup**: the plugin authenticates
against the mock Bot API (`getMe`), enters its `getUpdates` polling loop, picks up an
injected Telegram message, drives a real pi turn into the mock provider, and sends the
assistant reply back through `sendMessage`/`editMessageText`. It then restarts pi with a
`lastUpdateId` planted above the bot's whole id space and a queued message below it, and
asserts that the message is still delivered exactly once, that both cursors are rewound to
it, and that the rewind is logged — a step the mock's contract-conformant
drop-out-of-range behaviour makes impossible to pass without the backlog probe. Assertion
counts per version are recorded, not hardcoded here.

**What the mocks cannot prove.** The Bot API is mocked, so the suite observes neither real
rate limits (`429`), network retries, nor the `409` Conflict of two pollers on one token;
`npm run test:e2e:real` covers the payload contract against the real service, not those
runtime behaviours. The provider is scripted, so model output is fixed — streaming
cadence, 4096-character splitting and varied tool arguments only come from real runs.
Media paths (`sendDocument` for `tg_attach`) are checked against the mock's file surface,
not against a real upload.

The TUI bridge suite derives its pi versions from `docs/compat-results.json`; it does not
silently fall back to the development dependency. Each version and OMP runs in its own
`tmux` session with isolated agent/project state while sharing only the mock Telegram API
and mock provider. `--pi /path/to/pi` is the explicit single-version escape hatch for a
targeted local run.

Routing parity note: OMP's advertised command catalog over-reports — entries such as
`/theme`, `/undo`, `/help`, `/cost` are not dispatched by its input handler, so typing
them falls through to the model as prompt text. The bridge mirrors that terminal
behavior exactly; it is a host catalog quirk, not a routing bug.

### TUI bridge failure record

- `snapshot()` asked `isInteractiveFocus()`, which called `snapshot()` again. Selector
  polling stalled before Telegram could render controls. Focus is now read only from the
  host focus owner and structural overlay fields.
- Telegram Type sent arbitrary text through the named-key API, and key injection could
  write to terminal output instead of the host input pipeline. Text and named keys now use
  separate adapter methods backed by pi's input handler or OMP's `injectDebugInput`.
- A single cached submit handler survived editor/session replacement. Submit wrappers are
  now keyed by editor instance, so reload/new-session capture cannot call an old closure.
- Dynamic menu entries were represented by fallback names rather than the live host
  catalog. pi now contributes its live autocomplete/session commands; OMP contributes its
  built-in registry plus live session commands.
- Selector cursor recognition initially matched only the default `❯` glyph. Under
  `symbolPreset: nerd` the same cursor renders as a private-area chevron (U+F054), so the
  mirrored login selector degraded to untrimmed full-screen text without option buttons.
  The marker class now covers the private-use range; both presets are verified end-to-end.
- Selector paging sliced the parsed rows instead of the host list. OMP renders only a
  window of its selector (ten rows) and scrolls it with the cursor, so a 100+ provider
  login catalog looked like a single page and the rest was unreachable from Telegram.
  Paging now drives the host itself (PageUp/PageDown), re-parses the new window, and
  learns the end of the list from a no-op page; picks resolve against the live window.
- pi renders its selectors without side borders, so the box parser never matched them and
  `/login` stayed an arrow-keyboard mirror. Two shapes are now recognized: a `→` cursor
  row closed by a key legend (extension selector, rendered in full) and a provider window
  with an `(n/total)` scroll indicator (windowed; paged by arrow steps because pi ignores
  PageUp/PageDown). pi parks the hardware cursor with an APC string inside its search
  field, which the old SGR-only stripper left in the text and broke title detection;
  control strings (APC/OSC/CSI) are now stripped, not just colors.
- Prompts were answered by a Telegram UI that replaced the host's UI context, so the
  terminal never drew them and the two surfaces could diverge. With the bridge in `full`
  mode the host UI keeps ownership (a proxy only observes prompt methods) and the mirror
  attaches to the overlay the host renders; answers are injected keystrokes. A probe
  extension raising `ui.select` on `turn_start` verified on pi 0.81.1 and OMP that the
  host draws mid-turn prompts, that injected keys complete them, and that the turn then
  finishes with the Telegram reply.
- Bash confirmation awaited the Telegram callback inside the serial polling handler, so
  the callback could never be fetched. Bash workflows now detach after accepting the
  update; the poll loop remains free to receive the approval or rejection.
- Menu single-flight and delayed refresh state was process-global. Keys now include bot
  token, API base, and delay, preventing cross-bot suppression and preserving both the
  300ms and 1000ms captures.
- The old acceptance check read the mock response id of `editMessageText` instead of the
  edited Telegram message id in the request body, and local OMP `/status` autocomplete
  opened an unrelated overlay. The driver now uses the request id and a side-effect-free
  local `!true` command.
- Full-screen mirrors over Telegram's chunk limit rendered as a bare title: the edit
  transport delivers only the first split chunk. Snapshots are now tail-truncated to
  one message, keeping the bottom of the screen.
- `/status` threw on hosts whose session omits `thinkingLevel` or stats fields;
  missing values now render as `off`/`-`/`0`.

### What is in the publish gate, and what is not

`prepublishOnly` (mirrored by the publish workflow) runs `npm test`, `npm run typecheck`,
`npm run compat:check`, and `npm run changelog:check`. `compat:check` is what stops a stale
table or a mismatched range from shipping; `changelog:check` is what stops a release whose
`CHANGELOG.md` does not describe the version being published.

The matrix and E2E are **not** in the gate. E2E installs pi and starts `tmux` for every
version, so making it mandatory would slow releases enough to encourage bypassing it. They
are run manually before a release and recorded:

```console
$ npm run test:pi-versions -- --record   # both modes
$ npm run test:e2e -- --record
$ npm run test:e2e:tui-bridge
$ npm run compat:gen                     # refresh the README table
```

## Keeping this honest

The README matrix used to be hand-maintained prose, and it went stale: after the
drift-proofing refactor, the `0.85.0` row still claimed the version was excluded and its E2E
was never run, while the matrix script and the actual behaviour said otherwise.

It is now generated. `docs/compat-results.json` holds **recorded results only** — no prose,
no policy — written by `--record` runs. `scripts/gen-compat-matrix.mjs` renders the README
table from it and, under `--check`, fails if:

- the README table and `docs/compat-results.json` disagree;
- the matrix script tests a version with no recorded result, or records a version the
  script no longer tests;
- the E2E script drives a version by default with no recorded E2E result;
- the peer range in `package.json` excludes any version the matrix claims to pass.

That last check is the important one: it makes "the range and the evidence disagree"
impossible to ship.

This document is prose about *why*. The *what* is generated. Keeping them separate is
deliberate — the generated half cannot rot, and the prose half is not doing double duty as a
changelog.
