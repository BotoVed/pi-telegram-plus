/**
 * Session Capture & Handler Patching
 *
 * When p-tui starts, InteractiveMode calls session.bindExtensions() with
 * command-context handlers (newSession, fork, navigateTree, switchSession, reload)
 * that contain TUI rendering side effects.
 *
 * These handlers are needed for their CORE LOGIC (session lifecycle via runtimeHost).
 * The TUI rendering is harmless (just refreshes the terminal).
 *
 * After bindExtensions, we patch two things:
 *
 * 1. The shutdown handler is replaced to prevent exiting the TUI event loop
 *    from a Telegram command. Instead it just notifies.
 *
 * 2. Other handlers are left as-is. The TUI rendering they contain is harmless,
 *    and Telegram notifications are handled by the command handlers themselves
 *    using a captured ui reference (see below).
 *
 * IMPORTANT: rebindSession triggers a new bindExtensions() call, which re-runs
 * our monkey-patch. Since originalBindExtensions sets FRESH handlers each time
 * (from the new bindings), there is no accumulation of wrappers.
 *
 * IMPORTANT: /reload rebuilds the extension runtime without calling
 * bindExtensions(). Therefore capture state must live on globalThis instead of
 * module-local variables; otherwise the freshly loaded extension instance loses
 * activeSession and Telegram appears disconnected after reload.
 *
 * IMPORTANT: After rebind, runner.uiContext is reset to the TUI UI context.
 * This means ctx.ui (a getter reading runner.uiContext) would return the TUI UI
 * instead of TelegramUi. Command handlers MUST capture ctx.ui at the start
 * and use the captured reference for all Telegram notifications:
 *
 *   handler: async (args, ctx) => {
 *     const ui = ctx.ui;  ← capture before any rebind can occur
 *     ...
 *     ui.notify("✅ Done", "info");  ← always goes to Telegram
 *   };
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { log } from "./logger.ts";
import type { CapturedAgentSession } from "./types.ts";

const sessionCaptureLog = log.child("session-capture");

/**
 * `AgentSession` must be resolved lazily rather than statically imported.
 *
 * pi >= 1.0.0 re-exports `createCodemodeExtension` from its package root, pulling in
 * `@earendil-works/pi-codemode/declarations`. The `MCP_TYPESCRIPT_PREAMBLE` export that
 * pi reads was removed in pi-codemode 1.2.0, while pi declares the dependency with a
 * caret range — so a lockfile-less install can float past what pi supports and make a
 * static package-root import throw at load time. The pi CLI hides this behind its
 * virtual-module alias table, but plain Node consumers do not, so resolution is done
 * here with a guard and degrades to a no-op instead of crashing the extension.
 */
type AgentSessionConstructor = { prototype: CapturedAgentSession & { bindExtensions: unknown } };

function isAgentSessionConstructor(value: unknown): value is AgentSessionConstructor {
  if (typeof value !== "function") return false;
  const prototype = (value as { prototype?: { bindExtensions?: unknown } }).prototype;
  return typeof prototype?.bindExtensions === "function";
}

async function loadAgentSession(): Promise<AgentSessionConstructor | undefined> {
  try {
    const module = await import("@earendil-works/pi-coding-agent");
    const candidate = (module as unknown as { AgentSession?: unknown }).AgentSession;
    if (isAgentSessionConstructor(candidate)) return candidate;
    sessionCaptureLog.warn("AgentSession has no bindExtensions(); session capture disabled", {
      type: typeof candidate,
    });
  } catch (error) {
    sessionCaptureLog.warn("AgentSession unavailable; session capture disabled", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return undefined;
}

const AGENT_SESSION = await loadAgentSession();

type SessionCaptureState = {
  activeSession?: CapturedAgentSession;
  installed: boolean;
};

const SESSION_CAPTURE_STATE = Symbol.for("pi-telegram-plus.session-capture-state");

function getState(): SessionCaptureState {
  const g = globalThis as typeof globalThis & Record<symbol, SessionCaptureState | undefined>;
  g[SESSION_CAPTURE_STATE] ??= { installed: false };
  return g[SESSION_CAPTURE_STATE];
}

export function installAgentSessionCapture(): boolean {
  const state = getState();
  if (state.installed) return true;
  const AgentSession = AGENT_SESSION;
  if (!AgentSession) return false;
  state.installed = true;

  const proto = AgentSession.prototype;
  const originalBindExtensions = proto.bindExtensions;

  proto.bindExtensions = async function patchedBindExtensions(this: CapturedAgentSession, bindings) {
    // Make the replacing session visible before originalBindExtensions emits
    // session_start. Otherwise session_start handlers briefly see the previous
    // session, which is especially visible for lifecycle-driven integrations
    // such as Telegram reconnect/status handling after /new.
    state.activeSession = this;

    const result = await originalBindExtensions.call(this, bindings);

    const runner = this.extensionRunner;

    // ── Replace shutdown handler ───────────────────────────────────────
    // Original exits the TUI event loop — dangerous from a Telegram command.
    // Replace with a safe notification.
    (runner as unknown as { shutdownHandler: () => void }).shutdownHandler = () => {
      const ui = runner.getUIContext();
      ui.notify(
        "⚠️ Shutdown requested. Use Ctrl+C in terminal to stop pi.",
        "info",
      );
    };

    return result;
  };
  return true;
}

export function getActiveSession(): CapturedAgentSession | undefined {
  return getState().activeSession;
}
