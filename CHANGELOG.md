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

### Fixed

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
