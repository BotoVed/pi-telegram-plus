/**
 * CommandGateway (stage 1): commands whose only observable effect is host
 * output are submitted to the host editor instead of being re-implemented in
 * Telegram. The host executes them; OutputCapture returns the result.
 *
 * Only the static whitelist below enters this path. Everything else keeps the
 * existing native handler or `runTuiCommand` mirror until stage 5.
 */
import { escapeHtml } from "../html.ts";
import { log } from "../logger.ts";
import type { TelegramTransport } from "../types.ts";
import type { TuiBridgeAdapter } from "../tui-bridge.ts";
import type { Origin, OriginTracker } from "./origin.ts";
import type { OutputCapture } from "./output.ts";
import type { FocusTracker } from "./focus.ts";
import { currentHostName, currentHostState, installHostCapture, readEditorText, type HostState } from "./host.ts";
import type { TuiHost } from "../tui-bridge.ts";

const gatewayLog = log.child("tui-gateway");

/**
 * pi 0.81.1 commands classified as "output only" in Appendix A. `/model` is
 * deliberately absent: its dialog behaviour depends on the argument, so it
 * stays on the old path until the Broker exists. `/new` is a special case:
 * it calls the host's `ctx.newSession()` (the same control API the native
 * handler uses) instead of submitting `/new` to the editor. Editor submission
 * goes through `runtimeHost.newSession()` and reloads the extension runtime
 * outside pi's `withSession` sequencing; the Telegram polling singleton then
 * rejects the replacement instance. `/reload`, `/fork`, `/clone` and `/import`
 * also stay on their native handlers for the same lifecycle reason.
 */
const PI_OUTPUT_ONLY = new Set([
  "name", "session", "changelog", "debug",
  "export", "share", "compact", "new",
  "arminsayshi", "dementedelves",
]);

/**
 * OMP output/report commands. Stage 0 showed that OMP's built-ins report
 * through full-screen panels (`showCommandReport`) rather than chat children;
 * without the stage 3 InfoPanelAdapter, claiming them would send an ack and no
 * output and bypass the existing mirror. Leave OMP on the old path until then.
 */
const OMP_OUTPUT_ONLY = new Set<string>([]);

export function isOutputOnlyCommand(host: TuiHost, name: string): boolean {
  if (host === "pi") return PI_OUTPUT_ONLY.has(name);
  if (host === "omp") return OMP_OUTPUT_ONLY.has(name);
  return false;
}

export type GatewayRequest = {
  name: string;
  args: string;
  origin: Origin;
  transport: Pick<TelegramTransport, "sendText" | "editText">;
};

export type GatewayDeps = {
  bridge: TuiBridgeAdapter;
  origin: OriginTracker;
  output: OutputCapture;
  focus: FocusTracker;
  isEnabled(): boolean;
  /** Test seams; production uses the captured host. */
  hostName?: () => TuiHost;
  hostState?: () => HostState;
  readDraft?: () => string;
  writeDraft?: (text: string) => boolean;
  /** Host control API for `/new`; avoids the extension reload of editor submission. */
  newSession?: () => Promise<{ cancelled?: boolean } | void>;
};

export class CommandGateway {
  private started = false;
  private sessionWatch?: NodeJS.Timeout;
  private lastSession?: unknown;

  constructor(private readonly deps: GatewayDeps) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    void installHostCapture();
    this.deps.focus.start();
    this.deps.output.start();
    this.deps.origin.onEnd((scope) => {
      if (scope.label) this.deps.output.finish();
    });
    // /new replaces the session without letting the old onSubmit promise
    // settle. Watch the captured session identity so its scope can end.
    this.sessionWatch = setInterval(() => {
      const session = (this.deps.hostState?.() ?? currentHostState()).session;
      const scope = this.deps.origin.active();
      if (scope && this.lastSession !== undefined && session !== this.lastSession) {
        this.deps.origin.markSubmitDone(scope);
      }
      this.lastSession = session;
    }, 250);
    this.sessionWatch.unref?.();
  }

  handles(name: string): boolean {
    if (!this.deps.isEnabled()) return false;
    const host = this.deps.hostName?.() ?? currentHostName();
    if (host === "pi") return PI_OUTPUT_ONLY.has(name);
    if (host === "omp") return OMP_OUTPUT_ONLY.has(name);
    return false;
  }

  /** True when either host could claim this name; lets dispatch avoid waiting
   * for the bridge on every unrelated command. */
  couldHandle(name: string): boolean {
    return isOutputOnlyCommand("pi", name) || isOutputOnlyCommand("omp", name);
  }

  /** Returns true when the command was claimed (success or a reported error). */
  async run(request: GatewayRequest): Promise<boolean> {
    if (!this.handles(request.name)) return false;
    const host = this.deps.hostName?.() ?? currentHostName();
    if (request.name === "new" && host === "pi" && this.deps.newSession) {
      return this.runNewSession(request);
    }
    const state = this.deps.hostState?.() ?? currentHostState();
    if (!state.mode || !state.editor) {
      gatewayLog.debug("gateway unavailable: host not captured", { name: request.name });
      return false;
    }
    await this.deps.bridge.ready().catch(() => undefined);
    if (!this.deps.bridge.isAvailable()) {
      gatewayLog.debug("gateway unavailable: bridge not ready", { name: request.name });
      return false;
    }

    const commandText = `/${request.name}${request.args.trim() ? ` ${request.args.trim()}` : ""}`;
    const draft = (this.deps.readDraft ?? readEditorText)();
    const ackHtml = `<b>▶️ ${escapeHtml(commandText)}</b>`;
    const sent = await request.transport.sendText(
      request.origin.chatId,
      ackHtml,
      request.origin.messageThreadId,
      request.origin.sourceMessageId,
    ).catch((err) => {
      gatewayLog.debug("send gateway ack failed", { err, name: request.name });
      return undefined;
    });
    const messageId = sent?.[0]?.message_id;
    if (messageId === undefined) return true;

    const scope = this.deps.origin.begin(request.origin, request.name, commandText, draft);
    this.deps.output.bind(scope, {
      chatId: request.origin.chatId,
      messageThreadId: request.origin.messageThreadId,
      messageId,
      ackHtml,
    });

    const submit = this.deps.bridge.submitResult ?? ((text: string) => ({ ok: this.deps.bridge.submit(text) }));
    let result: { ok: boolean; result?: unknown };
    try {
      result = submit.call(this.deps.bridge, commandText);
    } catch (err) {
      result = { ok: false };
      gatewayLog.debug("gateway submit threw", { err, name: request.name });
    }
    if (!result.ok) {
      this.deps.output.finish();
      this.deps.origin.end(scope, "error");
      await request.transport.editText(request.origin.chatId, messageId, `${ackHtml}\n\n❌ 宿主没有接受这个命令`).catch(() => undefined);
      return true;
    }
    const value = result.result;
    if (value && typeof (value as { then?: unknown }).then === "function") {
      void Promise.resolve(value as Promise<unknown>).finally(() => {
        this.deps.origin.markSubmitDone(scope);
      });
      // A host-side session replacement can orphan the promise.
      this.deps.origin.markSubmitFallback(scope);
    } else {
      this.deps.origin.markSubmitDone(scope);
    }
    return true;
  }

  private async runNewSession(request: GatewayRequest): Promise<boolean> {
    const commandText = "/new";
    const ackHtml = `<b>▶️ ${escapeHtml(commandText)}</b>`;
    const sent = await request.transport.sendText(
      request.origin.chatId,
      ackHtml,
      request.origin.messageThreadId,
      request.origin.sourceMessageId,
    ).catch((err) => {
      gatewayLog.debug("send /new ack failed", { err });
      return undefined;
    });
    const messageId = sent?.[0]?.message_id;
    if (messageId === undefined) return true;
    const draft = (this.deps.readDraft ?? readEditorText)();
    try {
      const result = await this.deps.newSession!();
      // A new session replaces the Telegram runtime. Give the coordinator a
      // moment to hand the bot token over before reporting completion. The
      // next Telegram update is queued by the Bot API in the meantime.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (result && "cancelled" in result && result.cancelled) {
        await request.transport.editText(request.origin.chatId, messageId, `${ackHtml}\n\n<i>已取消</i>`).catch(() => undefined);
        return true;
      }
      await request.transport.editText(request.origin.chatId, messageId, `${ackHtml}\n\n✅ 新会话已开始`).catch(() => undefined);
      if (draft.length > 0 && this.deps.writeDraft) {
        const timer = setTimeout(() => { this.deps.writeDraft?.(draft); }, 150);
        timer.unref?.();
      }
    } catch (err) {
      gatewayLog.debug("new session failed", { err });
      await request.transport.editText(request.origin.chatId, messageId, `${ackHtml}\n\n❌ 无法开始新会话`).catch(() => undefined);
    }
    return true;
  }

  dispose(): void {
    if (this.sessionWatch) clearInterval(this.sessionWatch);
    this.sessionWatch = undefined;
    this.deps.output.stop();
    this.deps.focus.stop();
    this.deps.origin.dispose();
  }
}
