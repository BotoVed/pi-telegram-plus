# Compatibility

- **Supported hosts:** pi coding agent `1.4.0` (`@earendil-works/pi-coding-agent`, pinned in
  `package.json`) and OMP `18.12.x` (`@oh-my-pi/pi-coding-agent`).
- **Requires:** Node.js `>=22.19.0`.
- **Any other version is refused.** At startup the extension reads the host version (pi:
  `VERSION` from `@earendil-works/pi-coding-agent`; OMP: `VERSION` from `@oh-my-pi/pi-utils`).
  If the version does not match, or cannot be read, it installs none of its host hooks, shows
  the reason in the status bar and answers Telegram messages with that reason. There is no
  degraded mode and no fallback path (plan §0.1, decisions 44 and 46).
- **Enabling a new host version** means reading the new host source, updating the adapters
  and the pinned version, and passing the unit, contract and E2E suites on it. Until then it
  stays refused.

The multi-version matrix (`test:pi-versions`, `compat:gen`, `compat:check`,
`docs/compat-results.json`) was removed with the move to a single supported version.

## Why the extension loads without a static host import

Every `@earendil-works/pi-coding-agent` reference in this package is either an `import type`
or a guarded dynamic `import()`. Optional symbols are resolved once at module scope via
top-level `await`, so extension registration stays synchronous: pi rejects extension API
calls made after an `await` inside the extension factory (`Extension runtime not initialized.
Action methods cannot be called during extension loading.`), and it awaits module scope
before invoking the factory.

## OMP (`@oh-my-pi/pi-coding-agent`)

OMP is a pi fork with a rewritten session core, so it does not share pi's attach point: its
`AgentSession` has no `bindExtensions()`. The extension runner is built *before* the session
and handed to `new AgentSession(...)`, so a patched prototype never fires.

Capture therefore resolves OMP's process-global agent registry on every lookup:

```ts
AgentRegistry.global().get(MAIN_AGENT_ID)?.session        // "Main"
  ?? AgentRegistry.global().list().find(ref => ref.kind === "main")?.session
```

`get(mainId)` is the fast path; the `list()` scan covers embedded hosts that pass a custom
root `agentId`. The ref's session is re-attached on `/new` and session switches and detached
to `null` on dispose. Resolution happens per call rather than once at load, so capture also
works when the extension loads after the session already exists (`/reload`).

Inside an OMP extension, `import("@earendil-works/pi-coding-agent")` is aliased to the OMP
module. Host detection therefore checks for the OMP version first and only then treats the
host as pi.

OMP also resolves the package under two module paths, so one process holds two copies of
this extension, each with its own module state. Only the copy whose prototype patch landed
first learns about the captured TUI mode, so the bridge state hangs off a process-wide key in
`lib/tui-bridge.ts`; otherwise the copy serving the chat would conclude there is no bridge.

OMP keeps its runner UI context private (`runner.setUIContext()` does not exist), so the
plugin overrides `getUIContext()` / `createContext()` per runner: during a Telegram turn they
return the routed UI, otherwise the host TUI. Built-in `ask` and eval-prelude contexts receive
`ui` from OMP's private `ToolContextStore` and are routed by wrapping the tool execution
context and `ToolSession.getToolContext`.

OMP's advertised command catalog over-reports: entries such as `/theme`, `/undo`, `/help` and
`/cost` are not dispatched by its input handler, so typing them falls through to the model as
prompt text. Telegram forwards them to the host editor the same way, so both surfaces behave
identically.

## Verification

| Suite | What it checks | Command |
|---|---|---|
| Typecheck | `tsc --noEmit` over the package | `npm run typecheck` |
| Unit / regression | Module and contract tests | `npm test` |
| Round trip | pi in `tmux` + mock Telegram Bot API + mock OpenAI provider: `getMe`, the `getUpdates` loop, a real turn, the reply sent back, and the update-cursor rewind after restart | `npm run test:e2e` |
| OMP round trip | The same for OMP `18.12.x`, plus `/new` confirmation staying on Telegram | `npm run test:e2e:omp` |
| TUI bridge | Host command catalog, dialogs reaching Telegram, `!`/`!!` paths on both hosts | `npm run test:e2e:tui-bridge` |
| Command acceptance | Every advertised command and the `/tg` menu levels on both hosts | `npm run test:e2e:commands` |
| Dialog round trip | Extension `select` / `confirm` / `input` / secret input / `custom` and the `ask` tool, answered from Telegram and from the terminal, asserting the value the host actually resolved | `npm run test:e2e:dialogs` |
| Interaction parity | Host screen and Telegram surface recorded side by side for every advertised command | `npm run test:e2e:parity` |
| Real Bot API smoke | One message through api.telegram.org (send → edit → delete), plus a rejected-tag check | `npm run test:e2e:real` |

The E2E suites use `node_modules/.bin/pi` (`--pi-bin` or `--pi` overrides it). Steps that are
known to fail until a later migration task lands are listed in
`scripts/e2e/pending-migration.json`; only regressions outside that list count as failures.

**What the mocks cannot prove.** The Bot API is mocked, so the suites observe neither real
rate limits (`429`), network retries, nor the `409` Conflict of two pollers on one token. The
provider is scripted, so model output is fixed; streaming cadence, 4096-character splitting
and varied tool arguments only come from real runs.

## Publish gate

`prepublishOnly` (mirrored by the publish workflow) runs `npm test`, `npm run typecheck` and
`npm run changelog:check`. E2E is run manually before a release, because each run starts
isolated `tmux` sessions.
