# Changelog

Notable changes to `pi-telegram-plus`. Versions follow the published npm releases;
dates are the publish dates from the npm registry.

This file is a user-facing summary: what changed, and what it means for you. Design
rationale and investigation detail live in the linked docs and in the commit messages,
which are written to stand on their own. Generate a starting draft for a new release with
`npm run changelog:draft`.

Write entries under `## [Unreleased]` as you go. Releasing moves that section under the
new version number automatically — `npm run changelog:roll` locally, or as part of the
publish workflow — and re-points the `[Unreleased]` link. `npm run changelog:check` fails
if this file does not describe the version in `package.json`, so a release whose notes are
missing or mislabelled cannot be published.

## [Unreleased]

### Added

- **Remote selection of mirrored TUI dialogs.** With the TUI bridge in `full` mode,
  selection dialogs mirrored into Telegram (the provider login list, `/settings`, model
  pickers) render like the `/model` command's picker: a bold title, one button per
  option, and `◀ Prev` / `Next ▶` rows. The host only renders a window of a long list
  (OMP: ten rows) and scrolls it with the cursor, so paging drives the host itself with
  PageUp/PageDown and re-renders from the new window instead of slicing the parsed rows
  — the login catalog alone holds 100+ providers, all reachable. `▸` marks where the
  host cursor actually is, and tapping another option sends only the keystrokes needed
  to move there and confirm; no emulated arrow keyboard and no TUI screen dump. `Esc /
  Type / Refresh / Close` stay underneath. Stale taps are never guessed at: if the list
  changed underneath the keyboard, or the current position cannot be read, Telegram says
  so and rebuilds the keyboard instead of firing blind arrows. Cursor detection covers
  both the default `❯` marker and the private-area chevron emitted under
  `symbolPreset: nerd`, verified end-to-end against both presets.
- **The host dialog owns `/login` and `/logout`.** In `full` mode those commands are
  routed to the terminal on every host instead of a Telegram-native re-implementation,
  so both surfaces show the same labels, ordering, status markers and paging; the native
  handlers remain the fallback when the bridge is off or the host catalog lacks the
  command. pi renders its selectors without side borders — a `→` cursor row closed by a
  key legend (complete list) or a provider window with an `(n/total)` indicator — which
  the parser now recognizes; windowed pi lists page by walking arrow steps because pi
  ignores PageUp/PageDown. Mirrored lines strip APC/OSC/CSI control strings, not just
  SGR colors.

### Fixed

- **Every option past the first screen of a mirrored selector was unreachable.** OMP
  renders ten rows of its scrolling selector window over a catalog that holds 100+
  providers; the mirror treated the rendered rows as the whole list, so it always showed
  a single page. Paging now drives the host window and the end of the list is learned
  from a no-op page, so the whole catalog is reachable from Telegram.
- **`/status` crashed on hosts whose session omits fields.** OMP sessions can report
  no `thinkingLevel` (and hosts may omit token/cost stats entirely), and the status
  snapshot fed those straight into string operations — `undefined is not an object`.
  Missing values now render as `off`/`-`/`0` instead of throwing.
- **The TUI mirror collapsed to a bare title on tall terminals.** A full-screen
  snapshot over Telegram's chunk limit was split, and the mirror edit delivered only
  the first chunk — the message showed `TUI` with no screen. The snapshot is now
  tail-truncated to fit one message, keeping the bottom of the screen where dialogs
  and the latest output render.
- **A re-delivered update could replay its side effects forever.** The startup backlog
  probe re-serves the last processed update; the poller mistook it for a foreign cursor,
  rewound below it, and re-handled it on every cycle — for `/reload` that meant a reload
  loop that swallowed later commands. The rewind now fires only for a cursor strictly
  ahead of the stream, and updates at or below the cursor are skipped instead of re-run.
- **The Bot menu's thinking entry fell through to the model on OMP.** OMP has no
  native `/thinking` slash command (its thinking control is a hotkey) and the plugin
  registers no `thinking` handler either, so the static menu entry reached nothing and
  the text went to the provider as a prompt. The static entry is gone: `/thinking`
  appears in the menu only when the host itself provides the command. The thinking
  level is set from `/tg` → Config → **Thinking level**.
- **The Bot menu offered host commands OMP does not serve.** The curated static list is
  pi-based, so on OMP the menu advertised `/clone`, `/import`, `/name` and `/reload` —
  commands absent from OMP's own command surface, where typing them falls through to
  the model as prompt text. Once the TUI bridge has captured the live host catalog,
  static entries missing from it are omitted; plugin-served commands (`/tg`, `/cwd`,
  `/status`, …) stay, and with no captured catalog the curated list is kept unchanged.
  `/scoped-models` left the whitelist: OMP serves it neither natively nor through the
  plugin, so it is no longer menu-visible on OMP. Kept static entries now display the
  host catalog's live description when captured, so menu wording cannot drift from the
  host's own copy.
  The curated list also gained pi's `/trust` (dispatched through the TUI bridge).
- **`/login`, `/logout`, `/fork` and `/clone` crashed or dead-ended on OMP.**
  Their Telegram handlers call pi-only APIs (`ModelRuntime`/legacy `AuthStorage`
  auth, `ctx.fork`) that OMP does not expose — OMP keeps auth in its own store
  and forks through `session.fork`/`ctx.branch` — so the handlers threw
  `TypeError: ... is not a function` or printed a message blaming the pi
  version. Dispatch now checks the capability before running the handler: when
  it is missing and the TUI bridge is on, the command is routed to the host's
  own `/login` / `/fork` (OMP serves both in its TUI, and the dialog is
  mirrored back to Telegram); when the host cannot serve it either, Telegram
  gets an explicit "run it in the terminal" notice instead of a stack trace.
  On pi nothing changes: the native handlers keep running. The fork/clone
  handlers gained the same guard as a last resort, and the legacy-auth failure
  message now names the host and the bridge instead of blaming pi.
- **TUI bridge mirroring and remote controls could stall or target stale state.** Snapshot
  focus detection no longer recurses or guesses from rendered words, submit wrapping is
  isolated per editor/session, and pi/OMP command menus now come from live host registries.
  Telegram `/settings` waits for the real selector, all key/type/refresh/close callbacks
  use the host input pipeline, and local command mirroring no longer times out. Menu refresh
  work is isolated per bot/API endpoint, both delayed refreshes run, and recent commands
  receive their intended priority. Keyboard de-duplication tracks the button layout, not
  just the text, so a rebuilt selector always reaches Telegram. The isolated TUI E2E
  suite now exercises the recorded pi E2E version matrix plus OMP, including streamed
  bash output, exit codes, confirmation, and `!!` context exclusion.
- **The global default bot could not be unset cleanly.** `/tg → Bots → Bot list →
  <bot>` exposed it as a project-aware toggle (`Default: ● on / ○ off`): on an unbound
  project it demanded a confirmation, and after clearing it never re-resolved the running
  routing, so the process kept polling the removed default until restart. The action is now
  a global `Set as default` / `Clear default`, never touches a project binding, and clearing
  applies immediately: an unbound project warns, closes the menu and stops Telegram for that
  process; a bound project stays connected and the menu stays open. `/tg-bot-default clear`
  (also `none` / `off`) provides the same operation without the menu.
- **A polling outage flooded the chat with identical `Telegram polling failed`
  messages.** Every failed `getUpdates` (retried at 1s → 30s backoff) sent its own
  chat notice, and each notice itself retried up to four times on a flaky link.
  Notices are now collapsed: an outage shorter than 30s stays silent, a sustained
  outage produces one message that names the failure class (network, auth,
  conflict, rate limit, server, update processing), repeats only when the class
  changes or after 30 minutes, and emits one "polling restored" message on
  recovery. Notice sends are single-attempt. Update-handler and cursor-persist
  failures are reported as "update processing failed" and now back off instead of
  re-fetching the same update in a tight loop.
- **OMP rendered Telegram command confirmations in the terminal, so `/new` never
  answered over Telegram.** OMP's `ExtensionRunner` keeps its UI context in a private field
  and has no `setUIContext()`, so the runner-level UI swap used during Telegram turns was a
  no-op. `/new`'s `ctx.ui.confirm()` therefore opened in the OMP TUI while Telegram received
  no prompt and no buttons; the command stayed pending until someone answered in the
  terminal. The Telegram dispatcher now overrides `ui` on the per-command context whenever
  the runner cannot accept a UI context, so every command-level prompt (confirm, select,
  input, editor, custom) routes to Telegram. The runner's `getUIContext()` and
  `createContext()` are also overridden per runner to consult the active Telegram UI stack,
  which routes tool approvals, session-level selects, extension hooks, and extension tools
  (including pi-goal dialogs) while a Telegram turn is active and falls back to the TUI
  otherwise. Built-in `ask` and eval-prelude (`computer`) contexts get `ui` from OMP's
  private `ToolContextStore`, so the plugin wraps their execution context and
  `ToolSession.getToolContext` with the same active-turn routing. The bash PTY overlay is a
  capability gate rather than a dialog and stays terminal-local. pi keeps its
  `newSession({ withSession })` post-switch hook; OMP ignores `withSession`, so its
  “New session started.” notification now uses `newSession({ setup })`.
  See [compatibility.md](docs/compatibility.md#omp-oh-my-pi-pi-coding-agent).
- **The Bot menu silently dropped commands past its 100-entry cap.** Telegram's
  `setMyCommands` accepts at most 100 entries and the builder truncated the rest, so on
  hosts with large catalogs the tail — including recently used commands — never appeared.
  When the catalog exceeds the cap the menu now reserves its last slot for `/more`, which
  opens a paged inline keyboard (30 commands per page) of the overflow; tapping a button
  runs that command immediately.

### Removed

- **The flat `/tg-thinking`, `/tg-config`, and `/tg-list` commands.** Each duplicated a
  capability the `/tg` menu already owns: the model thinking level moved to `/tg` → Config
  → **Thinking level** (hosts with a native `/thinking` keep it), config keys were already
  editable under `/tg` → Config (Tool / Thinking / Retry / TUI bridge / Shell confirm), and
  the current binding plus its enabled state show under `/tg` → Project. Typing the removed
  commands now falls through to the model as prompt text, like any unknown command.

- **TUI slash registration of the Telegram management commands.** `/tg-bot-*`,
  `/tg-bind-cwd`, `/tg-unbind-cwd`, `/tg-cwd-connect`, `/tg-cwd-disconnect` and
  `/tg-switch` no longer appear in the host TUI slash menu: bot tokens and local-cwd
  bindings are chat-side management, and `/tg` owns those flows. They stay dispatchable
  from Telegram (via `/tg` or by typing them). The TUI keeps `/tg`, `/cwd`, `/cd`,
  `/status`, `/stop`, `/debug`.

## [0.0.12] — 2026-10-19

### Fixed

- **A shared cursor that sat past the end of the bot's `update_id` stream could never
  recover, so polling permanently asked for updates that do not exist.** Every cursor write
  is a monotonic max, so a `lastUpdateId` seeded from an update-id sequence the bot no longer
  belongs to — a re-created bot, a token reused for another bot, or an intermediary that
  assigns its own ids — was unreachable from below. Observed live: the cursor held
  `636583913` while the bot's stream was at `541383987`, and every poll asked for
  `636583914`. Messages still arrived only because the endpoint in use ignores an
  out-of-range offset; the documented contract is to return nothing, so the same state
  silently drops every message on a strict Bot API server. Polling now treats a delivered
  update below the offset it asked for as proof the cursor is foreign, logs `poll cursor is
  ahead of the update stream; rewinding`, and rewinds both the shared cursor and the project
  binding to one below the delivered update before handling the batch. A second signal
  covers the server that answers out-of-range requests with nothing at all (the documented
  contract): once per start, polling asks for the unconfirmed backlog with `offset: 0`,
  which confirms nothing, and rewinds if that backlog sits below the stored cursor.
- **Every Telegram message answered "π session is not ready yet." under OMP
  (`@oh-my-pi/pi-coding-agent`).** OMP's `AgentSession` has no `bindExtensions()`, so the
  extension loaded with `session capture disabled` and never held a session to drive. A
  `/pair <code>` reply still succeeded — pairing resolves before a session is needed — which
  made the failure look like a pairing bug. Capture now falls back to OMP's process-global
  agent registry, which holds the live top-level session.
  See [compatibility.md](docs/compatibility.md#omp-oh-my-pi-pi-coding-agent).
- **Released versions were shipped with their notes still labelled `[Unreleased]`.**
  `0.0.11` was published with 42 lines of release notes sitting under `## [Unreleased]`, its
  `[Unreleased]` link still comparing from `v0.0.10`. The publish workflow bumped
  `package.json` and tagged a release, but nothing ever moved the notes into a version
  section, so the published tarball described a released version as unreleased. The release
  now rolls this file, and `npm run changelog:check` fails any release whose CHANGELOG does
  not describe the version being published.
- **`package-lock.json` stayed pinned to the previous release on `master`.** The bump job
  committed `package.json` alone, so the lockfile still read `0.0.10` while `package.json`
  read `0.0.11`. Both files are now committed together.

### Added

- **`npm run changelog:roll`** — moves `## [Unreleased]` under the current version with
  today's date, inserts a fresh `[Unreleased]`, and re-points the `[Unreleased]` link. With
  `--auto-draft` it first fills an empty `[Unreleased]` from the conventional commits since
  the last tag, so a release never waits on hand-written notes. Zero dependencies.
- **`npm run changelog:check`** — verifies the CHANGELOG describes the version in
  `package.json`, that every version section has a link reference, that no version repeats,
  and that the trailing provenance note matches the referenced tags.

### Notes

- `prepublishOnly` now also runs `npm run changelog:check`, and the publish workflow rolls
  the CHANGELOG in the same commit as the version bump, so the tag and the notes cannot
  disagree. The bump job checks out full history and tags, which the draft step requires.

## [0.0.11] — 2026-10-18

### Fixed

- **Attachments sent to a self-hosted Bot API server went to the wrong host.**
  `downloadTelegramFile` hardcoded `https://api.telegram.org/file/...` while every other
  call honoured `PI_TELEGRAM_API_BASE` / `config.apiBase`, so downloads failed and leaked
  the file path and bot token to an origin the operator had routed away from.
- **npm refused to co-install with pi `0.86.0`–`0.99.2`, `1.2.0` or `1.3.0`.** Those
  versions were never broken — the matrix passes on all of them — but gaps in the peer
  range made npm-native installs fail with `ERESOLVE`. The range is now
  `>=0.80.7 <1.4.0`. `pi install npm:pi-telegram-plus` was unaffected (no peer validation).
- **pi `0.85.0` is supported again.** It was carved out in `0.0.7` because its published
  tarball imports an undeclared `@earendil-works/pi-server`. That upstream defect is real,
  but the drift-proofing below means it no longer affects this extension.
  See [compatibility.md](docs/compatibility.md#pi-0850-the-pi-server-packaging-defect).

### Changed

- **pi `@earendil-works/pi-coding-agent` is no longer imported as a static value.** Every
  reference is now `import type` or a guarded `import()`, and the optional classes
  (`FooterComponent`, `AgentSession`, `SessionManager`) degrade to a logged no-op instead
  of failing extension load. This protects non-CLI consumers (bundlers, test harnesses)
  from upstream packaging and dependency drift — including the `pi-codemode` drift that
  breaks plain-Node imports of pi `1.0.1`–`1.1.0`. The pi CLI masked both defects anyway.
  See [compatibility.md](docs/compatibility.md#why-the-extension-survives-upstream-breakage).

### Added

- **`npm run test:e2e`** — isolated end-to-end acceptance: a real pi in `tmux` against a
  mock Telegram Bot API and mock OpenAI provider, asserting the full round trip (`getMe` →
  `getUpdates` → injected message → real pi turn → reply delivered) on five pi versions.
- **The pi version matrix covers 21 versions** (`0.80.7`–`1.3.0`), and the README
  compatibility table is now generated from recorded results instead of maintained by hand.
  See [compatibility.md](docs/compatibility.md#keeping-this-honest).

### Notes

- `prepublishOnly` (mirrored by the publish workflow) runs `npm test`, `npm run typecheck`
  and `npm run compat:check`, which fails a release if the table, the test scripts and the
  peer range disagree. The matrix and E2E run manually and are recorded with `--record`.

## [0.0.10] — 2026-10-15

### Added

- Bot registry with project-level `.pi` binding, replacing path-bound bot tokens
  (PR #11).
- `/tg` interactive menu: multi-level navigation, single-message editing in place,
  per-project `Enabled` and `Default` toggles with confirmation before a switch that
  would disconnect an unbound project.
- Markdown tables in Telegram are rendered as native Rich Messages.

### Fixed

- `/pair` now persists `allowedUserId` to the bot registry.
- `/tg-config` direct-set reuses the shared menu flows; `/tg-switch` is registered in
  the TUI again.
- The `Enabled` toggle persists correctly, and its display is binding-based.

## [0.0.9] — 2026-10-10

### Added

- Configurable Telegram Bot API base URL, for self-hosted Bot API servers.
- `main` message mode, guaranteeing main-thread delivery during background workflows
  (issue #10).
- pi `1.0.x`/`1.1.x` added to the compatibility matrix.

### Changed

- Messages and workflow rendering follow fixed TUI-parity behavior, with the earlier
  mode-based rendering removed.
- Release and publish merged into a single `workflow_dispatch` workflow, fixing
  auto-publish (the previous `GITHUB_TOKEN` tag push did not trigger a second workflow).

### Fixed

- `/thinking` no longer collides with pi `1.x`.
- Concurrent `tg.json` writes are survived, and session start never wipes the Telegram
  configuration.
- Spurious failover notice suppressed on a single-instance restart.

## [0.0.8] — 2026-10-09

- CI: added the npm publish and release workflows.

## [0.0.7] — 2026-10-09

### Fixed

- Compatibility validation made portable for Windows.
- Telegram UI routing preserved with pi `0.85` (PR #9).

## [0.0.6] — 2026-08-09

### Added

- Multi-instance Telegram management with failover and history replay (PR #8).

### Fixed

- Guarded concurrent lock acquisition against `ENOENT` during candidate directory
  cleanup.

## [0.0.5] — 2026-07-22

### Fixed

- pi `0.80` model and auth compatibility.

## [0.0.4] — 2026-07-16

### Fixed

- Telegram messages are delivered during goal runs.

## [0.0.3] — 2026-07-08

### Added

- File-based JSON Lines logging, replacing silent `catch` blocks.
- Third-party TUI dialogs bridged to Telegram without disrupting the local TUI,
  including command-enqueued goal dialogs and multi-question forms.
- Mobile-first Telegram rendering overhaul: consistent table styling across message
  splits, oversized tables sent as a single file attachment.
- Telegram commands split into global and workspace scopes.

### Fixed

- Interactive modals no longer forward to the TUI base, which had caused selections to
  stick.
- Keyboard-strip race eliminated; questionnaire single-select auto-advances.
- Plain-text retry and warning spam suppressed on network errors.

## [0.0.2] — 2026-06-10

### Added

- `/status` command with beautified HTML output, BotMenu sync, and handler tests.
- Telegram markdown rendering aligned with the TUI style.

## [0.0.1] — 2026-06-03

- Initial release: Telegram control of the pi coding agent, with command bridging,
  interactive UI, and streaming output.

[Unreleased]: https://github.com/jalyfeng/pi-telegram-plus/compare/v0.0.12...HEAD
[0.0.12]: https://github.com/jalyfeng/pi-telegram-plus/compare/v0.0.11...v0.0.12
[0.0.11]: https://github.com/jalyfeng/pi-telegram-plus/compare/v0.0.10...v0.0.11
[0.0.10]: https://github.com/jalyfeng/pi-telegram-plus/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/jalyfeng/pi-telegram-plus/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/jalyfeng/pi-telegram-plus/compare/f2b97fa...v0.0.8
[0.0.7]: https://github.com/jalyfeng/pi-telegram-plus/compare/1ba0d32...f2b97fa
[0.0.6]: https://github.com/jalyfeng/pi-telegram-plus/compare/e084124...1ba0d32
[0.0.5]: https://github.com/jalyfeng/pi-telegram-plus/compare/e67b202...e084124
[0.0.4]: https://github.com/jalyfeng/pi-telegram-plus/compare/f5a510b...e67b202
[0.0.3]: https://github.com/jalyfeng/pi-telegram-plus/compare/f9410e7...f5a510b
[0.0.2]: https://github.com/jalyfeng/pi-telegram-plus/compare/fffc6f5...f9410e7
[0.0.1]: https://github.com/jalyfeng/pi-telegram-plus/tree/fffc6f5

<!--
     Versions linked by tag: v0.0.8, v0.0.9, v0.0.10, v0.0.11, v0.0.12; versions
     without a tag are compared by commit SHA. The v0.0.1 tag points at the
     initial commit, whose package.json still read 0.1.0, so it is linked as a
     tree, not a range. The v0.0.8 tag (bb69f57) sits one commit past the 0.0.8
     release commit (f65e372). -->
