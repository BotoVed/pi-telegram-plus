/**
 * OutputCapture (stage 1): sends the host's own command output back to
 * Telegram. It only claims output while a Telegram-issued command scope is
 * active; agent messages stay with the existing renderer.
 */
import { escapeHtml } from "../html.ts";
import { markdownToTelegramHtml } from "../markdown.ts";
import { splitTelegramHtml } from "../text-split.ts";
import { stripAnsi } from "../ansi.ts";
import { log } from "../logger.ts";
import type { TelegramTransport } from "../types.ts";
import { hookMethod, isHostObject, onHostState, type HostState } from "./host.ts";
import type { CommandScope, OriginTracker } from "./origin.ts";
import type { SecretStore } from "./secrets.ts";

const outputLog = log.child("tui-output");

const OUTPUT_DEBOUNCE_MS = 700;
const OUTPUT_EDIT_MS = 1000;
const MAX_COMPONENTS = 20;
/** OMP keeps flushing PTY output asynchronously after `setComplete` returns;
 * render the final frame one beat later so that is what we push (3E). */
const BASH_SETTLE_MS = 300;
const AGENT_CTORS = /^(AssistantMessageComponent|UserMessageComponent|ToolExecutionComponent|BashExecutionComponent|qs|_Te|Aw)$/;
const AGENT_FIELDS = ["lastMessage", "hasToolCalls", "toolCallId"];

/** The host's shell-execution component (D3b), claimed only by a "!" scope.
 * Minified host builds rename constructors; this matches the unminified
 * pi/OMP class name, same convention as AGENT_CTORS. */
const BASH_EXECUTOR_CTORS = /^BashExecutionComponent$/;

export type OutputTelegram = {
  chatId: number;
  messageThreadId?: number;
  messageId: number;
  /** Header already sent by the gateway; the first edit keeps it. */
  ackHtml: string;
};

type OutputTransport = Pick<TelegramTransport, "sendText" | "editText" | "sendDocument">;

type Binding = {
  scope: CommandScope;
  telegram: OutputTelegram;
  entries: string[];
  dropped: number;
  /** BashExecutionComponents claimed by a "!" scope (D3b); final render once. */
  bashComponents: Record<string, unknown>[];
  /** Output already rendered into the ack message (non-overflow case). */
  outputHtml: string;
  /** True once the ack message could not hold the output and tails were sent. */
  overflowed: boolean;
  lastText?: string;
  lastEditAt: number;
  timer?: NodeJS.Timeout;
  flushing: boolean;
  finalPending: boolean;
  finished: boolean;
};

export class OutputCapture {
  private binding?: Binding;
  private readonly rebuilding = new WeakSet<object>();
  private readonly attached = new WeakSet<object>();
  private statusDepth = 0;
  private unsubscribe?: () => void;
  private readonly exports = new WeakSet<object>();
  /** `attached` already holds `mode` from the status-hook loop; report hooks
   * need their own dedupe set. */
  private readonly reportHooked = new WeakSet<object>();
  /** D3b: bash components claimed by the "!" scope, and the ones whose final
   * render already went out. */
  private readonly bashTracked = new WeakSet<object>();
  private readonly bashPushed = new WeakSet<object>();
  /** Components whose `setComplete` has fired; only these may owe a final
   * render at scope end (F2: an unfinished one never pushes its running frame). */
  private readonly bashCompleted = new WeakSet<object>();

  constructor(
    private readonly transport: OutputTransport,
    private readonly origin: OriginTracker,
    private readonly secrets?: SecretStore,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = onHostState((state) => this.attach(state));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.finish();
  }

  bind(scope: CommandScope, telegram: OutputTelegram): void {
    this.finish();
    this.binding = {
      scope,
      telegram,
      entries: [],
      dropped: 0,
      bashComponents: [],
      outputHtml: "",
      overflowed: false,
      lastEditAt: 0,
      flushing: false,
      finalPending: false,
      finished: false,
    };
  }

  /** True while the active binding claims a host bash component whose
   * `setComplete` has not fired yet. `OriginTracker.holdOpen` keeps the
   * scope alive while this holds, so the idle end never cuts the command's
   * final output short. */
  hasRunningBash(): boolean {
    const binding = this.binding;
    if (!binding) return false;
    return binding.bashComponents.some((child) => !this.bashCompleted.has(child));
  }

  /** Flush the active binding and stop claiming output for it. */
  finish(): void {
    const binding = this.binding;
    if (!binding || binding.finished) return;
    // D3b: only a completed component still owes its final render to the ack
    // message. A still-running one means the scope ended by timeout or
    // replacement; its "running" frame is not output, so drop it (F2).
    for (const child of binding.bashComponents) {
      if (this.bashCompleted.has(child)) this.emitBashOutput(child, binding, true);
      else outputLog.debug("bash component unfinished at scope end; running frame dropped", { scope: binding.scope.id });
    }
    binding.finished = true;
    if (binding.timer) {
      clearTimeout(binding.timer);
      binding.timer = undefined;
    }
    void this.flush(binding, true).finally(() => {
      if (this.binding === binding) this.binding = undefined;
    });
  }

  /** D3b: claim a BashExecutionComponent for the "!" scope. Its final render
   * goes out exactly once: `BASH_SETTLE_MS` after the host calls
   * `setComplete`, or at scope end when the component finished but the scope
   * ends first (the `finish` fallback). An unfinished component is dropped. */
  private trackBashComponent(child: Record<string, unknown>): void {
    const binding = this.binding;
    if (!binding || binding.finished || this.bashPushed.has(child)) return;
    if (!binding.bashComponents.includes(child)) binding.bashComponents.push(child);
    if (this.bashTracked.has(child)) return;
    this.bashTracked.add(child);
    hookMethod(child, "setComplete", "output-bash-complete", undefined, () => {
      this.bashCompleted.add(child);
      // Postpone the idle end past the settle delay so `finish` cannot beat
      // the timer and render before the host's async output flush landed.
      this.origin.touch(binding.scope);
      const timer = setTimeout(() => this.emitBashOutput(child, binding, false), BASH_SETTLE_MS);
      timer.unref?.();
    });
  }

  private emitBashOutput(child: Record<string, unknown>, binding: Binding, final: boolean): void {
    if (this.bashPushed.has(child)) return;
    this.bashPushed.add(child);
    const html = renderComponent(child, (raw) => this.redact(raw));
    if (!html || this.binding !== binding || binding.finished) return;
    // At scope end `push` refuses (the scope no longer owns output), so the
    // final render goes straight into the entries the final flush drains.
    if (final || binding.scope.ended) binding.entries.push(html);
    else this.push(html);
  }

  /** Secrets never ride the output path (§4.7.4): raw text is masked first. */
  private redact(text: string): string {
    const binding = this.binding;
    if (!binding || !this.secrets) return text;
    const { chatId, messageThreadId } = binding.telegram;
    return this.secrets.redact(`${chatId}:${messageThreadId ?? "main"}`, text);
  }

  private attach(state: HostState): void {
    for (const target of [state.mode, state.ui]) {
      if (!isHostObject(target) || this.attached.has(target)) continue;
      this.attached.add(target);
      for (const name of ["showStatus", "showError", "showWarning"]) {
        hookMethod(target, name, `output-${name}`, () => { this.statusDepth += 1; }, (args) => {
          this.statusDepth = Math.max(0, this.statusDepth - 1);
          const message = args[0];
          if (typeof message !== "string" || message.trim().length === 0) return;
          const prefix = name === "showError" ? "❌ " : name === "showWarning" ? "⚠️ " : "";
          this.push(`${prefix}${escapeHtml(this.redact(stripAnsi(message)))}`);
        });
      }
    }
    // OMP reports (`/mcp` and friends) draw a titled block on the main screen
    // instead of opening a dialog: `showCommandReport({ title, body })`. It is
    // command output (T3.1).
    const mode = state.mode;
    if (isHostObject(mode) && !this.reportHooked.has(mode)) {
      this.reportHooked.add(mode);
      hookMethod(mode, "showCommandReport", "output-command-report", undefined, (args) => {
        const report = args[0] as { title?: unknown; body?: unknown } | undefined;
        const title = typeof report?.title === "string" ? report.title.trim() : "";
        const body = isHostObject(report?.body)
          ? renderComponent(report.body, (raw) => this.redact(raw))
          : undefined;
        if (!title && !body) return;
        this.push(title ? `<b>${escapeHtml(this.redact(title))}</b>\n${body ?? ""}` : body!);
      });
    }

    const chat = state.chat;
    if (isHostObject(chat) && !this.attached.has(chat)) {
      this.attached.add(chat);
      hookMethod(chat, "clear", "output-clear", () => {
        this.rebuilding.add(chat);
        const timer = setTimeout(() => { this.rebuilding.delete(chat); }, 0);
        timer.unref?.();
      });
      hookMethod(chat, "addChild", "output-add-child", undefined, (args) => {
        if (this.statusDepth > 0) return;
        // /compact clears and rebuilds the transcript, then appends the new
        // summary in the same task. The summary is command output, not history,
        // so keep claiming children for that label; history components are
        // excluded by identity below.
        const compactScope = this.binding?.scope.label === "compact";
        if (this.rebuilding.has(chat) && !compactScope) return;
        const child = args[0];
        if (!isHostObject(child)) return;
        const mode = state.mode;
        if (isAgentComponent(child, mode)) {
          // D3b: inside a "!" scope the host's BashExecutionComponent is the
          // command's own output, not agent history; everywhere else it stays
          // excluded as before.
          if (this.binding?.scope.label === "!" && BASH_EXECUTOR_CTORS.test(ctorName(child))) this.trackBashComponent(child);
          return;
        }
        const html = renderComponent(child, (raw) => this.redact(raw));
        if (!html) return;
        this.push(html);
      });
    }
    const session = state.session;
    if (isHostObject(session) && !this.exports.has(session)) {
      this.exports.add(session);
      for (const name of ["exportToHtml", "exportToJsonl"]) {
        hookMethod(session, name, `output-${name}`, undefined, (_args, result) => {
          this.captureExport(name, result);
        });
      }
    }
  }

  private push(html: string): void {
    const binding = this.binding;
    if (!binding || binding.finished) return;
    if (this.origin.active() !== binding.scope || binding.scope.ended) return;
    this.origin.touch(binding.scope);
    const value = html.trim();
    if (!value) return;
    if (binding.entries[binding.entries.length - 1] === value) return;
    if (binding.entries.length >= MAX_COMPONENTS) {
      binding.dropped += 1;
      return;
    }
    binding.entries.push(value);
    this.schedule(binding);
  }

  private schedule(binding: Binding): void {
    if (binding.timer) return;
    const wait = Math.max(0, Math.min(OUTPUT_DEBOUNCE_MS, OUTPUT_EDIT_MS - (Date.now() - binding.lastEditAt)));
    binding.timer = setTimeout(() => {
      binding.timer = undefined;
      void this.flush(binding, false);
    }, wait);
    binding.timer.unref?.();
  }

  private async flush(binding: Binding, final: boolean): Promise<void> {
    if (binding.flushing) {
      if (final) binding.finalPending = true;
      return;
    }
    if (binding.entries.length === 0 && !final) return;
    binding.flushing = true;
    try {
      let added = binding.entries.splice(0).join("\n\n").trim();
      const dropped = binding.dropped;
      binding.dropped = 0;
      if (dropped > 0) {
        const tail = `…还有 ${dropped} 项输出，请在终端查看`;
        added = added ? `${added}\n\n${tail}` : tail;
      }
      const combined = added
        ? (binding.outputHtml ? `${binding.outputHtml}\n\n${added}` : added)
        : binding.outputHtml;
      const header = binding.telegram.ackHtml;
      const single = splitTelegramHtml(`${header}\n\n${combined}`, 3400);
      if (single.length === 1 && !binding.overflowed) {
        let text = single[0];
        if (final && !text.includes("✓ 完成")) text += "\n\n<i>✓ 完成</i>";
        if (text !== binding.lastText) {
          binding.lastText = text;
          binding.lastEditAt = Date.now();
          await this.transport.editText(binding.telegram.chatId, binding.telegram.messageId, text)
            .catch(outputLog.swallow("debug", "edit command output failed", { chatId: binding.telegram.chatId }));
        }
        binding.outputHtml = combined;
      } else {
        const body = binding.overflowed ? added : combined;
        if (body) {
          for (const chunk of splitTelegramHtml(body, 3400)) {
            await this.transport.sendText(
              binding.telegram.chatId,
              chunk,
              binding.telegram.messageThreadId,
            ).catch(outputLog.swallow("warn", "send command output tail failed", { chatId: binding.telegram.chatId }));
          }
        }
        binding.overflowed = true;
        binding.outputHtml = "";
        if (final) {
          await this.transport.sendText(
            binding.telegram.chatId,
            "<i>✓ 完成</i>",
            binding.telegram.messageThreadId,
          ).catch(outputLog.swallow("debug", "send command completion failed", { chatId: binding.telegram.chatId }));
        }
      }
    } finally {
      binding.flushing = false;
      if (binding.finalPending) {
        binding.finalPending = false;
        void this.flush(binding, true);
      }
    }
  }

  private captureExport(method: string, result: unknown): void {
    const scope = this.origin.active();
    if (!scope || scope.label !== "export") return;
    if (!result || typeof (result as { then?: unknown }).then !== "function") return;
    void Promise.resolve(result as Promise<unknown>).then((value) => {
      if (typeof value !== "string" || value.trim().length === 0) return;
      const binding = this.binding;
      if (!binding || binding.scope !== scope) return;
      if (binding.telegram.chatId === undefined) return;
      void this.transport.sendDocument(
        binding.telegram.chatId,
        value,
        `Session exported (${method.replace("exportTo", "").toLowerCase()})`,
        undefined,
        binding.telegram.messageThreadId,
      ).catch(outputLog.swallow("warn", "send exported session failed", { path: value }));
    }, (err) => {
      outputLog.debug("export promise rejected", { err });
    });
  }
}

function ctorName(child: Record<string, unknown>): string {
  try {
    return Object.getPrototypeOf(child)?.constructor?.name ?? child.constructor?.name ?? "";
  } catch {
    return "";
  }
}

function isAgentComponent(child: Record<string, unknown>, mode: Record<string, unknown> | undefined): boolean {
  if (mode && child === mode.streamingComponent) return true;
  if (AGENT_CTORS.test(ctorName(child))) return true;
  for (const field of AGENT_FIELDS) {
    try {
      if (Object.prototype.hasOwnProperty.call(child, field)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

export function renderComponent(
  component: Record<string, unknown>,
  redact: (text: string) => string = (text) => text,
): string | undefined {
  const markdown = component.markdown;
  if (typeof markdown === "string" && markdown.trim()) return markdownToTelegramHtml(redact(markdown));
  const text = component.text;
  if (typeof text === "string" && text.trim()) {
    const clean = redact(stripAnsi(text));
    return clean.includes("\n") ? `<pre>${escapeHtml(clean)}</pre>` : escapeHtml(clean);
  }
  const content = component.content;
  if (typeof content === "string" && content.trim()) return `<pre>${escapeHtml(redact(stripAnsi(content)))}</pre>`;
  const render = component.render;
  if (typeof render === "function") {
    try {
      const value = (render as (width: number) => unknown).call(component, 80);
      const textValue = Array.isArray(value)
        ? value.map((line) => String(line)).join("\n")
        : typeof value === "string" ? value : "";
      const clean = redact(stripAnsi(textValue)).trim();
      if (clean) return `<pre>${escapeHtml(clean)}</pre>`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
