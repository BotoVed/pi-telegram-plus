# Changelog

Notable changes to `pi-telegram-plus`. Versions follow the published npm releases;
dates are the publish dates from the npm registry.

## [Unreleased]

### Fixed

- **Attachment downloads ignored `apiBase`.** `downloadTelegramFile` hardcoded
  `https://api.telegram.org/file/...` while every other call in the module honoured
  `PI_TELEGRAM_API_BASE` / `config.apiBase`. With a self-hosted Bot API server or a mock
  configured, incoming attachment downloads were sent to the real Telegram service:
  they failed, and they leaked the file path and bot token to an origin the operator had
  explicitly routed away from. The file endpoint now resolves through the same
  `telegramApiBase()` helper as the rest of the Bot API calls.
- **Peer range rejected pi `0.86.0`–`0.99.2` and `1.2.0`/`1.3.0`.** The range stopped at
  `<0.86.0` and resumed at `>=1.0.0`, leaving a hole over the `0.86`–`0.99` line, and had
  not been widened past `<1.2.0` for the newest releases. Those pi versions were never
  broken — the full matrix passes on all of them — but npm's peer validation refused to
  co-install the plugin alongside any of them:

  ```
  npm error code ERESOLVE
  npm error Conflicting peer dependency: @earendil-works/pi-coding-agent@1.1.0
  ```

  This only affected npm-native installs (pi as a `devDependency`, or a manual
  `npm install`); `pi install npm:pi-telegram-plus` does not run peer validation and
  worked either way. The supported range is now `>=0.80.7 <1.4.0`, which still excludes
  `0.74.x`.
- **pi `0.85.0` re-admitted.** The range previously carved it out as
  `<0.85.0 || >=0.85.1`, on the grounds that pi `0.85.0`'s published tarball statically
  imports the undeclared `@earendil-works/pi-server` — reachable from `dist/index.js` via
  `dist/main.js` → `dist/experimental/server.js` — so a plain Node `import()` of the pi
  package root throws `Cannot find package '@earendil-works/pi-server'`.

  The upstream defect is real (`pi-server` appears in none of pi `0.85.0`'s dependency
  fields, and `0.85.1` dropped the reference), but it no longer affects this extension:
  the `Changed` entry below replaced every static pi package-root import with a guarded
  `import()`. Measured on `0.85.0` with the current sources, both the clean-install matrix
  (`426/426`) and the full tmux E2E round trip (`8/8` assertions) pass, in default and
  `--strict-upstream` modes. Reverting just `lib/status-footer.ts` to its `v0.0.10` static
  value import is enough to reproduce the failure as a hard
  `lib/__tests__/status-footer.test.ts` suite error, so the guard is what carries it rather
  than luck.

  Worth noting for anyone reading the earlier exclusion: inside the pi CLI the defect was
  masked regardless, because the CLI's virtual-module alias table serves
  `@earendil-works/pi-coding-agent` from its own bundle, so `dist/experimental/server.js`
  never loads. The excluded version primarily broke plain-Node consumers,
  including this project's own test matrix.

### Changed

- **pi package-root imports no longer fail extension load when upstream is broken.** Every
  `@earendil-works/pi-coding-agent` import in the package is now `import type` or a
  guarded dynamic `import()`. `FooterComponent`, `AgentSession` and `SessionManager` are
  resolved once via top-level `await` (so the extension factory stays synchronous, as pi
  requires) and degrade to a logged no-op when unavailable, instead of failing extension
  load.

  This makes the plugin immune to an upstream drift it cannot control. Since pi `0.99.0`,
  pi declares `@earendil-works/pi-codemode` through a caret range and statically imports
  `MCP_TYPESCRIPT_PREAMBLE` from it, but that export was removed in `pi-codemode 1.2.0`.
  A lockfile-less install therefore floats `pi-codemode` forward past what the pi release
  expects. Measured across the supported range, the drift breaks exactly pi `1.0.1`
  through `1.1.0`:

  | pi | ships `npm-shrinkwrap.json` | `pi-codemode` resolves to | bundle still imports the symbol | plain Node `import()` |
  |---|---|---|---|---|
  | `0.80.7`–`0.87.1` | yes | not a dependency | — | ok |
  | `0.99.0`–`0.99.2` | yes | `0.99.x` (pinned) | yes | ok |
  | `1.0.0` | yes | `1.0.0` (pinned) | yes | ok |
  | `1.0.1`–`1.1.0` | no | `1.3.0` | yes | **throws** |
  | `1.2.0`–`1.3.0` | no | `1.3.0` | no | ok |

  pi `1.0.0` and earlier escaped because they ship an `npm-shrinkwrap.json` pinning the
  contemporaneous `pi-codemode`; that shrinkwrap was dropped in `1.0.1`. `1.2.0` and
  `1.3.0` escape because their bundles stopped referencing the removed symbol. `1.0.0` is
  therefore immune by accident rather than by design.

  In practice the pi CLI already masked this behind its virtual-module alias table — a
  drifted install fails a plain Node `import()` while `pi --print` runs a full turn
  normally — so this is robustness work that protects non-CLI consumers (bundlers, test
  harnesses) and future upstream changes, **not** a fix for a user-reported failure.

  `installTelegramStatusAlignment()` deliberately stays synchronous: pi rejects extension
  API calls made after an `await` inside the extension factory ("Extension runtime not
  initialized"), so the lazy resolution happens at module scope, which pi awaits before
  invoking the factory.

### Added

- **Automated isolated end-to-end acceptance** (`npm run test:e2e`), on pi `0.85.1`,
  `1.0.4`, `1.1.0` and `1.3.0`. It drives a real pi inside `tmux` against a mock Telegram
  Bot API and a mock OpenAI-compatible provider, and asserts the full round trip rather
  than just startup: `getMe` authentication, the `getUpdates` polling loop, pickup of an
  injected Telegram message, a real pi turn reaching the provider, and the assistant
  reply delivered back through `sendMessage`/`editMessageText`.

- **The pi version matrix now covers 21 versions** (`0.80.7` through `1.3.0`), each
  installed into a temporary clean tree. `--strict-upstream` skips the contemporaneous
  `pi-codemode` pin to expose raw upstream drift; both modes pass, and the unpinned mode
  acts as a regression sentinel that fails if a static package-root import is
  reintroduced.

### Notes

- The publish gate (`prepublishOnly`, mirrored by the publish workflow) runs `npm test`
  and `npm run typecheck`. The matrix and E2E suites are run manually before a release:
  E2E installs pi and starts `tmux` for every version, so making it a hard gate would
  slow releases enough to encourage bypassing it.

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

[Unreleased]: https://github.com/jalyfeng/pi-telegram-plus/compare/v0.0.10...HEAD
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

<!-- Tags exist only for v0.0.1, v0.0.8, v0.0.9 and v0.0.10; earlier versions are
     compared by commit SHA. The v0.0.1 tag points at the initial commit, whose
     package.json still read 0.1.0, so it is linked as a tree, not a range. The
     v0.0.8 tag (bb69f57) sits one commit past the 0.0.8 release commit (f65e372). -->
