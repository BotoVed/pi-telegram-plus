import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DIALOG_CALLBACK_PREFIX, decodeDialogCallback, decodeMoreCallback, decodeRunCallback, decodeTuiCallback, decodeUiCallback, encodeMoreCallback, encodeRunCallback, encodeTuiCallback } from "./callback-protocol.ts";
import { parseLeadingCommand, normalizeLeadingCommand } from "./command-parser.ts";
import type {
  CapturedAgentSession,
  TelegramBashConfirm,
  TelegramButton,
  TelegramCallbackQuery,
  TelegramConfig,
  TelegramDocument,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramTransport,
  TelegramTurn,
} from "./types.ts";
import type { TelegramUiRuntime } from "./telegram-ui.ts";
import type { TuiBridgeAdapter, TuiSnapshot } from "./tui-bridge.ts";
import { tuiBridge as defaultTuiBridge, hostOwnsPrompts } from "./tui-bridge.ts";
import type { SelectorState } from "./tui-selector.ts";
import { parseSelectorText, readDialogTitle, selectorNavigateKeys } from "./tui-selector.ts";
import { escapeHtml } from "./html.ts";
import { stripAnsi } from "./custom-dialogs.ts";
import { recordCommandUsage } from "./command-usage.ts";
import { getTelegramMenuOverflow } from "./menu-commands.ts";
import { log } from "./logger.ts";
import { commandErrorMessage, getRunnerMode, hasNativeAuthApi, restoreRunnerUiContext, setRunnerUiContext, TELEGRAM_EXTENSION_MODE } from "./pi-compat.ts";
import { isOmpHost } from "./session-capture.ts";
import { getCurrentTelegramTurn, runWithTelegramTurn } from "./turn-context.ts";
import { OriginTracker } from "./tui/origin.ts";
import { FocusTracker } from "./tui/focus.ts";
import { OutputCapture } from "./tui/output.ts";
import { CommandGateway } from "./tui/gateway.ts";
import { DialogBroker } from "./tui/broker.ts";
import { SecretStore } from "./tui/secrets.ts";
import { readEditorText as readHostEditorText, writeEditorText as writeHostEditorText } from "./tui/host.ts";

const ctrlLog = log.child("controller");

export type TelegramController = {
  handleMessage(message: TelegramMessage): Promise<void>;
  handleCallbackQuery(query: TelegramCallbackQuery): Promise<void>;
  /** Dispatch a named command from an inline menu (e.g. /tg → Commands). */
  runCommand(name: string, args: string, chatId: number, messageThreadId?: number, sourceMessageId?: number): Promise<void>;
  dispose(): void;
};

function getIncomingDocumentName(document?: TelegramDocument): string {
  if (!document) return "file";
  return document.file_name || `${document.file_id}`;
}

type IncomingMediaSummaryEntry = {
  type: string;
  fileId: string;
  fileName?: string;
};

function extractTelegramMediaEntries(message: TelegramMessage): IncomingMediaSummaryEntry[] {
  const entries: IncomingMediaSummaryEntry[] = [];
  if (message.photo && message.photo.length > 0) {
    const bestPhoto = [...message.photo].reduce<TelegramPhotoSize>((best, current) => {
      const bestSize = best.file_size ?? -1;
      const currentSize = current.file_size ?? -1;
      return currentSize > bestSize ? current : best;
    }, message.photo[0]);
    entries.push({ type: "photo", fileId: bestPhoto.file_id, fileName: undefined });
  }

  const documentAttachments: Array<{ type: string; document?: TelegramDocument }> = [];
  if (message.document) documentAttachments.push({ type: "document", document: message.document });
  if (message.video) documentAttachments.push({ type: "video", document: message.video });
  if (message.audio) documentAttachments.push({ type: "audio", document: message.audio });
  if (message.voice) documentAttachments.push({ type: "voice", document: message.voice });
  if (message.animation) documentAttachments.push({ type: "animation", document: message.animation });
  if (message.sticker) documentAttachments.push({ type: "sticker", document: message.sticker });
  for (const attachment of documentAttachments) {
    if (!attachment.document) continue;
    entries.push({
      type: attachment.type,
      fileId: attachment.document.file_id,
      fileName: attachment.document.file_name,
    });
  }

  return entries;
}

function buildTelegramIncomingMediaSummary(message: TelegramMessage, title = "[telegram attachment]"): string {
  const parts: string[] = [];
  if (message.photo && message.photo.length > 0) {
    parts.push(`- photo (${message.photo.length} photo frame(s))`);
  }
  const entries: Array<{ type: string; document?: TelegramDocument }> = [];
  if (message.document) entries.push({ type: "document", document: message.document });
  if (message.video) entries.push({ type: "video", document: message.video });
  if (message.audio) entries.push({ type: "audio", document: message.audio });
  if (message.voice) entries.push({ type: "voice", document: message.voice });
  if (message.animation) entries.push({ type: "animation", document: message.animation });
  if (message.sticker) entries.push({ type: "sticker", document: message.sticker });
  for (const attachment of entries) {
    if (!attachment.document) continue;
    parts.push(`- ${attachment.type}: ${getIncomingDocumentName(attachment.document)}`);
  }
  return parts.length ? `${title}\n${parts.join("\n")}` : "";
}

const QUOTED_TEXT_LIMIT = 1800;

function truncateQuotedText(text: string, max = QUOTED_TEXT_LIMIT): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatTelegramSender(from: TelegramMessage["from"]): string | undefined {
  if (!from) return undefined;
  const parts: string[] = [];
  if (from.username) parts.push(`@${from.username}`);
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  if (displayName) parts.push(displayName);
  if (from.id !== undefined) parts.push(`id:${from.id}`);
  if (from.is_bot) parts.push("bot");
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function buildTelegramQuotedMessageBlock(message: TelegramMessage | undefined): string {
  if (!message) return "";
  const lines = ["[telegram quoted message]", `message_id: ${message.message_id}`];
  const sender = formatTelegramSender(message.from);
  if (sender) lines.push(`from: ${sender}`);
  const text = message.text ?? message.caption;
  if (text?.trim()) {
    lines.push(message.caption !== undefined ? "caption:" : "text:");
    lines.push(truncateQuotedText(text.trim()));
  }
  const media = buildTelegramIncomingMediaSummary(message, "[telegram quoted attachment]");
  if (media) lines.push(media);
  if (lines.length === 2) lines.push("content: unavailable from Telegram update");
  return lines.join("\n");
}

function buildTelegramTextQuoteBlock(message: TelegramMessage): string {
  const quote = message.quote ?? message.text_quote ?? message.external_reply?.quote;
  if (!quote) return "";
  const text = quote.text?.trim();
  if (!text) return "";
  const lines = ["[telegram quoted text]", "text:", truncateQuotedText(text)];
  if (quote.position !== undefined) lines.push(`position: ${quote.position}`);
  if (quote.is_manual !== undefined) lines.push(`manual: ${quote.is_manual}`);
  return lines.join("\n");
}

function buildTelegramExternalReplyBlock(message: TelegramMessage): string {
  const external = message.external_reply;
  if (!external) return "";
  const lines = ["[telegram external reply]"];
  if (external.message_id !== undefined) lines.push(`message_id: ${external.message_id}`);
  if (external.chat) {
    const chat = external.chat;
    const chatParts = [
      chat.username ? `@${chat.username}` : undefined,
      chat.title,
      chat.type,
      chat.id !== undefined ? `id:${chat.id}` : undefined,
    ].filter(Boolean);
    if (chatParts.length > 0) lines.push(`chat: ${chatParts.join(" ")}`);
  }
  if (external.origin !== undefined) {
    try { lines.push(`origin: ${JSON.stringify(external.origin)}`); }
    catch { lines.push(`origin: ${String(external.origin)}`); }
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function buildTelegramReplyContextBlock(message: TelegramMessage): string {
  return [
    buildTelegramQuotedMessageBlock(message.reply_to_message),
    buildTelegramTextQuoteBlock(message),
    buildTelegramExternalReplyBlock(message),
  ].filter(Boolean).join("\n\n");
}

function logTelegramReplyContext(message: TelegramMessage): void {
  const quote = message.quote ?? message.text_quote ?? message.external_reply?.quote;
  ctrlLog.debug("incoming telegram reply context", {
    messageId: message.message_id,
    hasReplyToMessage: !!message.reply_to_message,
    replyToMessageId: message.reply_to_message?.message_id,
    replyHasText: !!message.reply_to_message?.text,
    replyHasCaption: !!message.reply_to_message?.caption,
    replyHasMedia: !!buildTelegramIncomingMediaSummary(message.reply_to_message ?? ({} as TelegramMessage)),
    hasQuote: !!quote,
    quoteTextLength: quote?.text?.length ?? 0,
    hasExternalReply: !!message.external_reply,
  });
}

function formatSavedIncomingAttachmentLine(kind: string, fileId: string, fileName: string | undefined, path: string): string {
  const savedName = fileName ? `${fileName} (${fileId})` : fileId;
  return `- ${kind}: ${savedName} => ${path}`;
}

function formatIncomingAttachmentErrorLine(kind: string, fileId: string, fileName: string | undefined, reason: string): string {
  const target = fileName ? `${fileName} (${fileId})` : fileId;
  return `- ${kind}: ${target} -> failed to save (${reason})`;
}

function formatIncomingAttachmentReceipt(state: "saved" | "failed", lines: string[]): string {
  if (lines.length === 0) return "";
  const title = state === "saved" ? "✅ Saved attachments (local paths):" : "⚠️ Attachments not saved:";
  return `${title}\n${lines.join("\n")}`;
}


export type TelegramCommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;


type TelegramUiStackEntry = {
  turn: TelegramTurn;
  ui: ExtensionUIContext;
  routedUi: ExtensionUIContext;
};

type TelegramUiStackState = {
  baseUi: unknown;
  baseMode: string;
  entries: TelegramUiStackEntry[];
};

const telegramUiStacks = new WeakMap<object, TelegramUiStackState>();

function isSameTelegramTurnTarget(currentTurn: TelegramTurn | undefined, turn: TelegramTurn): boolean {
  return currentTurn?.chatId === turn.chatId
    && currentTurn.messageThreadId === turn.messageThreadId
    && currentTurn.sourceMessageId === turn.sourceMessageId;
}

function createRoutedTelegramUi(baseUi: unknown, telegramUi: ExtensionUIContext, turn: TelegramTurn): ExtensionUIContext {
  const getTarget = () => {
    const currentTurn = getCurrentTelegramTurn();
    return (isSameTelegramTurnTarget(currentTurn, turn) ? telegramUi : baseUi) as object | undefined;
  };
  return new Proxy({}, {
    get(_target, prop, receiver) {
      if (prop === "__piTelegramPlusRoutedUi") return true;
      // Lets the focus tracker reach the host context underneath: entry hooks must
      // land on the real object even while a Telegram swap is installed.
      if (prop === "__piTelegramPlusRoutedBaseUi") return baseUi;
      const target = getTarget();
      const value = Reflect.get(target ?? {}, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, prop, value, receiver) {
      const target = getTarget();
      return Reflect.set(target ?? {}, prop, value, receiver);
    },
    has(_target, prop) {
      const target = getTarget();
      return prop in (target ?? {});
    },
    // Support object spread ({ ...ui }) without dropping dynamically routed properties.
    ownKeys(_target) {
      const target = getTarget();
      return Reflect.ownKeys(target ?? {});
    },
    getOwnPropertyDescriptor(_target, prop) {
      const target = getTarget();
      const desc = Reflect.getOwnPropertyDescriptor(target ?? {}, prop);
      if (!desc) return undefined;
      return {
        ...desc,
        configurable: true,
      };
    },
  }) as ExtensionUIContext;
}

/**
 * Replace `ui` on an already-created context object. Interactive modals must
 * not mutate stateful getters, so the property is redefined in place instead of
 * spreading the context (some hosts expose `model` and friends as getters).
 */
function withUiContext<T extends object>(ctx: T, ui: ExtensionUIContext): T {
  try {
    return Object.defineProperty(ctx, "ui", {
      value: ui,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  } catch {
    // Some hosts hand out a context whose `ui` cannot be redefined. A read-through
    // proxy overrides just that member and leaves every other getter on the
    // original object intact.
    return new Proxy(ctx, {
      get: (target, property, receiver) =>
        property === "ui" ? ui : Reflect.get(target, property, receiver),
      has: (target, property) => property === "ui" || Reflect.has(target, property),
    }) as T;
  }
}

// Runners whose getUIContext()/createContext() consult the Telegram UI stack.
// The patch is permanent per runner and falls back to the host UI when the
// stack is empty, so it needs no uninstall.
const routedRunnerUiPatched = new WeakSet<object>();

/**
 * Route agent-, tool-, and hook-raised dialogs on hosts without a UI-context
 * setter (OMP). `getUIContext()` backs tool approvals and session-level
 * selects; `createContext()` backs extension hooks and extension tools.
 * Both read the private UI context directly, so overriding the instance
 * methods is the only public seam. The returned routed proxy falls back to
 * the host UI whenever no Telegram turn is active, keeping local TUI turns
 * untouched.
 */
function installRoutedRunnerUi(runner: CapturedAgentSession["extensionRunner"]): void {
  if (routedRunnerUiPatched.has(runner)) return;
  routedRunnerUiPatched.add(runner);
  const originalGetUIContext = runner.getUIContext.bind(runner);
  const originalCreateContext = runner.createContext.bind(runner);

  runner.getUIContext = () =>
    telegramUiStacks.get(runner)?.entries.at(-1)?.routedUi ?? originalGetUIContext();
  runner.createContext = (...args: Parameters<typeof originalCreateContext>) => {
    const ctx = originalCreateContext(...args);
    const routed = telegramUiStacks.get(runner)?.entries.at(-1)?.routedUi;
    return routed ? withUiContext(ctx, routed) : ctx;
  };
}

// Turn -> routed UI. Built-in tools get their context outside the runner
// methods, so the AsyncLocalStorage turn is the key that reaches them.
const routedUiByTurn = new WeakMap<TelegramTurn, ExtensionUIContext>();
const toolExecutePatched = new WeakSet<object>();
const toolSessionPatched = new WeakSet<object>();

/**
 * Built-in tools receive `ui` from OMP's private ToolContextStore, which is not
 * reachable from AgentSession. Wrap the two places it surfaces:
 * - the `ask` tool's execute context (agent loop -> ToolContextStore)
 * - ToolSession.getToolContext (eval preludes such as computer control)
 * While a Telegram turn is active the context's `ui` is replaced with the
 * routed UI; otherwise the original context is passed through untouched.
 */
function readAgentTools(session: CapturedAgentSession): readonly unknown[] {
  if (!("agent" in session)) return [];
  const agent = session.agent;
  if (!agent || typeof agent !== "object" || !("state" in agent)) return [];
  const state = agent.state;
  if (!state || typeof state !== "object" || !("tools" in state)) return [];
  return Array.isArray(state.tools) ? state.tools : [];
}

function installToolUiRouting(session: CapturedAgentSession): void {
  for (const raw of readAgentTools(session)) {
    if (!raw || typeof raw !== "object") continue;
    const name = "name" in raw ? raw.name : undefined;
    const execute = "execute" in raw ? raw.execute : undefined;
    if (name === "ask" && typeof execute === "function" && !toolExecutePatched.has(raw)) {
      const originalExecute = execute.bind(raw) as (...args: unknown[]) => unknown;
      try {
        Object.defineProperty(raw, "execute", {
          configurable: true,
          writable: true,
          value: (...args: unknown[]) => {
            const turn = getCurrentTelegramTurn();
            const routed = turn ? routedUiByTurn.get(turn) : undefined;
            if (!routed) return originalExecute(...args);
            // Hosts disagree on where the tool context sits in the execute
            // signature (pi: second argument; OMP's ask: fifth), so route every
            // argument that carries a UI context.
            const routedArgs = args.map((arg) => {
              if (!arg || typeof arg !== "object" || !("ui" in (arg as object))) return arg;
              try {
                return withUiContext(arg as Record<string, unknown>, routed);
              } catch {
                return arg;
              }
            });
            return originalExecute(...routedArgs);
          },
        });
        toolExecutePatched.add(raw);
      } catch {
        // Frozen/proxied tools keep the host UI.
      }
    }
    const toolSession = "session" in raw ? raw.session : undefined;
    if (!toolSession || typeof toolSession !== "object" || toolSessionPatched.has(toolSession)) continue;
    const getToolContext = "getToolContext" in toolSession ? toolSession.getToolContext : undefined;
    if (typeof getToolContext !== "function") continue;
    const originalGetToolContext = getToolContext.bind(toolSession) as () => unknown;
    try {
      Object.defineProperty(toolSession, "getToolContext", {
        configurable: true,
        writable: true,
        value: () => {
          const ctx = originalGetToolContext();
          const turn = getCurrentTelegramTurn();
          const routed = turn ? routedUiByTurn.get(turn) : undefined;
          return routed && ctx && typeof ctx === "object" ? withUiContext(ctx, routed) : ctx;
        },
      });
      toolSessionPatched.add(toolSession);
    } catch {
      // Non-writable ToolSession keeps eval preludes on the host UI.
    }
  }
}

/**
 * §4.9 host-prompt UI. Instead of answering prompts itself, it delegates every
 * call to the host UI (so the terminal draws the dialog) and only reports the
 * prompt methods, which lets the mirror attach to the overlay the host is about
 * to render. Answers travel back as injected keys, so Telegram and the terminal
 * drive one implementation; once the DialogBroker can attribute the dialog to a
 * chat it takes over and the mirror stands down.
 */
function createHostPromptUi(baseUi: unknown, telegramUi: ExtensionUIContext, onPrompt?: () => void): ExtensionUIContext {
  // Host-specific prompt entry points count too: OMP's `ask` tool goes through
  // ui.askDialog(), and approvals through ui.approve().
  const promptMethods = new Set([
    "select", "confirm", "input", "inputSecret", "editor", "custom", "askDialog", "approve",
  ]);
  return new Proxy({}, {
    get(_target, prop, receiver) {
      if (prop === "__piTelegramPlusRoutedUi") return true;
      if (prop === "__piTelegramPlusRoutedBaseUi") return baseUi;
      const target = baseUi ?? {};
      const value = Reflect.get(target as object, prop, receiver);
      if (typeof value !== "function") {
        // A plugin-only affordance - the nested `menu` keyboard the management screens
        // walk - has no host twin, so the plugin's own implementation keeps serving it
        // even while the host owns the prompts.
        const own = (telegramUi as unknown as Record<string, unknown>)[String(prop)];
        return typeof own === "function" ? own.bind(telegramUi) : value;
      }
      const name = String(prop);
      if (name === "notify") {
        // Notifications are not prompts: the terminal still prints them, and
        // the chat keeps receiving what it used to.
        return (...args: unknown[]) => {
          let result: unknown;
          try {
            result = (value as (...notifyArgs: unknown[]) => unknown).apply(target, args);
          } catch {
            // Host notification failures must not block the chat copy.
          }
          try {
            const chatNotify = (telegramUi as unknown as Record<string, unknown>).notify;
            if (typeof chatNotify === "function") (chatNotify as (...a: unknown[]) => unknown).apply(telegramUi, args);
          } catch {
            // Chat notification is best-effort.
          }
          return result;
        };
      }
      if (!promptMethods.has(name)) return value.bind(target);
      return (...args: unknown[]) => {
        try {
          onPrompt?.();
        } catch {
          // Observation must never break the host prompt.
        }
        return (value as (...promptArgs: unknown[]) => unknown).apply(target, args);
      };
    },
    has(_target, prop) {
      const target = baseUi ?? {};
      return prop === "__piTelegramPlusRoutedUi" || prop in (target as object);
    },
    ownKeys() {
      return Reflect.ownKeys((baseUi ?? {}) as object);
    },
    getOwnPropertyDescriptor(_target, prop) {
      const desc = Reflect.getOwnPropertyDescriptor((baseUi ?? {}) as object, prop);
      return desc ? { ...desc, configurable: true } : undefined;
    },
  }) as ExtensionUIContext;
}

function pushTelegramUiContext(
  runner: CapturedAgentSession["extensionRunner"],
  ui: ExtensionUIContext,
  turn: TelegramTurn,
  makeRouted: (baseUi: unknown, telegramUi: ExtensionUIContext, turn: TelegramTurn) => ExtensionUIContext = createRoutedTelegramUi,
): () => void {
  if (typeof runner.setUIContext !== "function") installRoutedRunnerUi(runner);
  let state = telegramUiStacks.get(runner as object);
  if (!state) {
    state = { baseUi: runner.getUIContext(), baseMode: getRunnerMode(runner as any), entries: [] };
    telegramUiStacks.set(runner as object, state);
  }
  const previousUi = state.entries.at(-1)?.routedUi ?? state.baseUi;
  const entry: TelegramUiStackEntry = {
    turn,
    ui,
    routedUi: makeRouted(previousUi, ui, turn),
  };
  state.entries.push(entry);
  routedUiByTurn.set(turn, entry.routedUi);
  setRunnerUiContext(runner as any, entry.routedUi, TELEGRAM_EXTENSION_MODE);

  return () => {
    const current = telegramUiStacks.get(runner as object);
    if (!current) return;
    const idx = current.entries.indexOf(entry);
    if (idx === -1) return;
    const wasTop = idx === current.entries.length - 1;
    current.entries.splice(idx, 1);
    if (routedUiByTurn.get(turn) === entry.routedUi) {
      const remaining = current.entries.findLast((candidate) => candidate.turn === turn);
      if (remaining) routedUiByTurn.set(turn, remaining.routedUi);
      else routedUiByTurn.delete(turn);
    }
    if (wasTop) {
      const next = current.entries.at(-1);
      if (next) setRunnerUiContext(runner as any, next.routedUi, TELEGRAM_EXTENSION_MODE);
      else restoreRunnerUiContext(runner as any, current.baseUi, current.baseMode);
    }
    if (current.entries.length === 0) telegramUiStacks.delete(runner as object);
  };
}

async function runWithTelegramUi<T>(deps: {
  session: CapturedAgentSession;
  ui: ExtensionUIContext;
  turn: TelegramTurn;
  run: () => Promise<T>;
  /**
   * Who answers the prompts raised inside `run` (§4.2.6 item 2):
   * - `"host"`: the host UI draws them, so the terminal can answer and the
   *   DialogBroker or the mirror presents them here. Used whenever the broker
   *   is live, which is what keeps both ends able to answer one dialog.
   * - `"telegram-native"` (default): the plugin answers them in Telegram, which
   *   is what `off` mode and the plugin's own flows need.
   */
  uiMode?: "telegram-native" | "host";
  /** Attached to a host-rendered prompt to bring the mirror up on the overlay. */
  observePrompts?: () => void;
}): Promise<T> {
  // Tool contexts (ask / eval preludes) resolve `ui` from a private store that
  // does not follow the runner's setUIContext on every host, so install the
  // routing wrappers regardless; they pass straight through when no Telegram
  // turn is active.
  installToolUiRouting(deps.session);
  const hostPrompts = deps.uiMode === "host";
  const observe = deps.observePrompts;
  const restore = pushTelegramUiContext(
    deps.session.extensionRunner,
    deps.ui,
    deps.turn,
    hostPrompts ? (baseUi) => createHostPromptUi(baseUi, deps.ui, observe) : undefined,
  );
  try {
    return await deps.run();
  } finally {
    restore();
  }
}

/** One quiet window before a command scope releases the UI swap; longer than
 * pi-goal's 50ms CONTINUATION_IDLE_RETRY_MS so a scheduled continuation gets a
 * chance to start before the chain is judged drained. */
const ENQUEUE_HOLD_WINDOW_MS = 120;

/**
 * Hold the Telegram UI swap across a command's enqueued agent turns (§4.2.6).
 *
 * pi-goal-style commands enqueue the turn and return immediately; the extension
 * schedules continuation turns 50ms after a turn ends. After each idle we wait
 * one window longer than that retry interval: a chain that is still running
 * keeps the swap (so its `ctx.ui.select/confirm/input` dialogs and their output
 * stay attributed to the chat), a drained chain hands the terminal back.
 *
 * Only holds when the agent was idle before the command arrived, so a locally
 * streamed turn is never hijacked. Shared by the native command handler and the
 * CommandGateway.
 */
async function holdThroughEnqueuedTurns(ctx: unknown, wasIdle: boolean): Promise<void> {
  if (!wasIdle) return;
  const runner = ctx as { isIdle?(): boolean; waitForIdle?(): Promise<unknown> } | undefined;
  if (!runner || typeof runner.isIdle !== "function" || typeof runner.waitForIdle !== "function") return;
  const idle = () => runner.isIdle!();
  const wait = () => runner.waitForIdle!();
  try {
    for (;;) {
      await wait();
      await new Promise((r) => setTimeout(r, ENQUEUE_HOLD_WINDOW_MS));
      if (idle()) break;
    }
  } catch (err) {
    // Session disposed / torn down during the wait — nothing to do but log.
    ctrlLog.debug("waitForIdle during enqueued turn interrupted", { err });
  }
}

const BASH_TIMEOUT_MS = 120_000;
const BASH_STREAM_DEBOUNCE_MS = 700;
const TUI_SCREEN_WIDTH = 100;
const TUI_POLL_INTERVAL_MS = 80;
const TUI_POLL_ATTEMPTS = 40;
// Host-rendered prompts: poll the overlay until the host takes it back.
const TUI_PROMPT_POLL_MS = 150;
const TUI_PROMPT_EDIT_MS = 1500;
// A prompt stays mirrored for as long as it is on screen: the loop exits when
// the dialog closes, the turn ends or the host stops rendering. An OAuth wait
// can easily outlive a fixed six-minute budget.

// A command's overlay can draw a frame or two after dispatch; treat a screen as
// final only after it has been stable this long.
const TUI_MIRROR_IDLE_MS = 3_000;
const TUI_NATIVE_SELECTOR_COMMANDS = new Set(["settings"]);

// Mirror-first: these open host dialogs, and the Telegram-native
// re-implementation cannot stay faithful to the terminal (labels, ordering,
// status markers, paging). With the bridge in `full` mode the host owns the
// interaction and Telegram mirrors it; native handlers remain the fallback
// when the bridge cannot serve the command.
const MIRROR_FIRST_COMMANDS = new Set(["login", "logout"]);

// Commands whose Telegram-native handlers depend on host APIs that differ
// between pi and OMP. When the capability is missing the command is routed to
// the host's own TUI through the bridge (the host serves it there), or refused
// with an actionable message — never left to crash inside the handler.
const HOST_CAPABILITY_COMMANDS = new Set(["login", "logout", "fork", "clone"]);

const nativeHandlerAvailable = (
  name: string,
  session: CapturedAgentSession,
  hostIsOmp: boolean,
): boolean => {
  if (name === "login" || name === "logout") return hasNativeAuthApi(session);
  if (name === "fork" || name === "clone") return !hostIsOmp;
  return true;
};

const hostCommandUnavailableNotice = (name: string): string => {
  if (name === "login" || name === "logout") {
    return `This host does not expose a programmatic auth API to Telegram and its TUI does not serve /${name}. Run /${name} in the terminal.`;
  }
  return `This host does not expose /${name} to Telegram. Run it in the terminal instead.`;
};

// /more overflow keyboard: 30 command buttons per page, three per row.
const MORE_PAGE_SIZE = 30;
const MORE_ROW_SIZE = 3;

const DANGEROUS_BASH_PATTERNS: readonly RegExp[] = [
  /\brm\s+(-[a-z]*[rf]|--recursive|--force)\b/i,
  /\bsudo\b/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\s+if=/i,
  /:\s*\(\s*\)\s*\{/, // fork bomb
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bkill(?:all)?\s+-[0-9]/i,
  /\bchmod\s+(-R\s+)?777\b/i,
  /\b(chown|chgrp)\s+-R\b/i,
  /\bcurl\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/i,
  /\bwget\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/i,
  />\s*\/dev\/(?:sd|disk|nvme)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\btruncate\s+-s\s*0\b/i,
  /\b(?:diskutil|fdisk|parted)\b/i,
];

type BashResult = {
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  output?: string;
  fullOutputPath?: string;
};

type BashExecutor = (
  command: string,
  onChunk: (chunk: string) => void,
  options?: { excludeFromContext?: boolean },
) => Promise<BashResult>;

type BashAbort = () => unknown;

function readBashExecutor(session: CapturedAgentSession): BashExecutor | undefined {
  // `executeBash` is a host runtime API not present in the shared AgentSession
  // type; both supported hosts expose it under this exact name.
  const candidate = (session as unknown as Record<string, unknown>).executeBash;
  return typeof candidate === "function" ? candidate as BashExecutor : undefined;
}

function readBashAbort(session: CapturedAgentSession): BashAbort | undefined {
  const candidate = (session as unknown as Record<string, unknown>).abortBash;
  return typeof candidate === "function" ? candidate as BashAbort : undefined;
}

function isBashRunning(session: CapturedAgentSession): boolean {
  return (session as unknown as Record<string, unknown>).isBashRunning === true;
}

function isDangerousBash(command: string): boolean {
  return DANGEROUS_BASH_PATTERNS.some((pattern) => pattern.test(command));
}

function preformatted(text: string): string {
  return `<pre>${escapeHtml(text)}</pre>`;
}

function tailText(text: string, maxChars = 3200): string {
  return text.length <= maxChars ? text : `…${text.slice(-(maxChars - 1))}`;
}

// editText/editButtons only deliver the first split chunk, so a full-screen
// snapshot must fit in one chunk (3600 bytes). Keep the bottom of the screen:
// dialogs, prompts, and the latest output render there.
const TUI_SNAPSHOT_MAX_BYTES = 3000;

/**
 * Fit a rendered screen into a Telegram message without losing the parts a
 * user needs to interact: the host pads dialogs to the terminal height with
 * blank rows, which used to eat the budget and push the dialog's own header
 * (instructions, OAuth URL) out of the mirror. Collapse that padding first,
 * then keep both ends when the rest still overflows.
 */
export function clipScreen(text: string, maxBytes: number): string {
  const collapsed: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "" && collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === "") continue;
    collapsed.push(line);
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === "") collapsed.pop();
  const trimmed = collapsed.join("\n");
  if (Buffer.byteLength(trimmed, "utf8") <= maxBytes) return trimmed;
  const budget = maxBytes - 4; // "\n…\n"
  const headLimit = Math.floor(budget * 0.45);
  const head: string[] = [];
  let headBytes = 0;
  let index = 0;
  for (; index < collapsed.length; index += 1) {
    const size = Buffer.byteLength(collapsed[index], "utf8") + 1;
    if (head.length > 0 && headBytes + size > headLimit) break;
    head.push(collapsed[index]);
    headBytes += size;
  }
  const tail: string[] = [];
  let tailBytes = 0;
  for (let i = collapsed.length - 1; i > index; i -= 1) {
    const size = Buffer.byteLength(collapsed[i], "utf8") + 1;
    if (tail.length > 0 && tailBytes + size > budget - headBytes) break;
    tail.push(collapsed[i]);
    tailBytes += size;
  }
  tail.reverse();
  return [...head, "…", ...tail].join("\n");
}

// URLs inside <pre> are not linkified by Telegram; repeat them as plain text
// so OAuth/authorization screens offer a tappable link from the mirror.
// The host hard-wraps a URL that is wider than the render column, so the tail
// of an authorization URL lands on the following line as an unbroken token;
// joining it back is the difference between a usable link and a dead one.
export function snapshotLinks(body: string): string {
  const lines = body.split("\n");
  const found: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /https?:\/\/[^\s<>"'`]+/.exec(line);
    if (!match) continue;
    let url = match[0];
    // `trimEnd().length >= 80` means the token actually runs to the render
    // edge; a short URL that merely ends its line is complete already.
    const atEdge = line.trimEnd().endsWith(url) && line.trimEnd().length >= 90;
    if (atEdge) {
      for (let next = index + 1; next < lines.length; next += 1) {
        const continuation = lines[next].trim();
        // A wrapped token has no spaces of its own; anything with whitespace
        // is the next line of prose, not a URL tail.
        if (!continuation || /\s/.test(continuation)) break;
        if (!/^[\w%&=+:/?#@!$'()*,;\[\].~-]/.test(continuation)) break;
        url += continuation;
        index = next;
        if (lines[next].length < 80) break;
      }
    }
    found.push(url.replace(/[).,;:]+$/, ""));
  }
  // Keep the longest form of each link: the wrapped first copy is a prefix.
  const urls = found
    .filter((url) => !found.some((other) => other.length > url.length && other.startsWith(url)))
    .filter((url, i, all) => all.indexOf(url) === i)
    .slice(0, 3);
  return urls.length > 0 ? `\n\n${urls.map((url) => `🔗 ${escapeHtml(url)}`).join("\n")}` : "";
}

// Overlays that wait for typed input render a bare prompt row (">" / "> ▌").
// The mirror cannot host a native field, so it advertises the Type → send →
// Enter path instead of leaving the user with arrow keys only.
function hasInputPrompt(body: string): boolean {
  return body.split("\n").some((line) => {
    const stripped = line.replace(/^[\s│┃|]*/, "").replace(/[\s│┃|]+$/, "");
    if (/^>[\s\u2580-\u259F]*$/.test(stripped)) return true;
    // Other hosts draw the caret at the end of a labelled field ("Path: ▌").
    return /[▌▏]$/.test(stripped) && !/^[\s\u2580-\u259F]+$/.test(stripped);
  });
}

// A finished screen ends with the editor chrome: an optional title border plus
// the prompt row. That is not dialog output (it made a logout result look like
// it ended with an unrelated session title), so trim it from mirrored results.
export function trimScreenChrome(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  const trimmed = lines.slice(0, end);
  const isPromptRow = (line: string): boolean => /^\s*(?:[❯>]|π\s*[>❯])\s*$/.test(line);
  let cut = trimmed.length;
  for (let i = trimmed.length - 1; i >= Math.max(0, trimmed.length - 6); i -= 1) {
    if (!isPromptRow(trimmed[i])) continue;
    cut = i;
    // The editor's top border carries the session title: ─── TITLE ───
    const above = (trimmed[i - 1] ?? "").trim();
    if (/^[─━]+\s+\S.*[─━]+$/.test(above) && (above.match(/[─━]/g) ?? []).length >= 8) cut = i - 1;
    break;
  }
  const keep = trimmed.slice(0, cut);
  while (keep.length > 0 && keep[keep.length - 1].trim() === "") keep.pop();
  return keep.join("\n");
}

function formatTuiSnapshot(snapshot: TuiSnapshot, title: string, selector?: SelectorState): string {
  const shownTitle = selector?.title ?? title;
  const rawBody = selector ? selector.block : snapshot.text || "(empty screen)";
  const body = selector ? rawBody : trimScreenChrome(rawBody);
  return `<b>${escapeHtml(shownTitle)}</b>\n${preformatted(clipScreen(body, TUI_SNAPSHOT_MAX_BYTES))}${selector ? "" : snapshotLinks(body)}`;
}

// The host prints its own key legend at the bottom of every dialog ("⌃R reload
// · PgUp/PgDn scroll"). Anything it advertises that a Telegram keyboard lacks is
// an unreachable action, so the legend is parsed and turned into buttons. Keys
// without a meaningful Telegram-side effect (⌃G opens $EDITOR, ⌃Z suspends) are
// deliberately absent from the table.
const LEGEND_KEYS: Array<[RegExp, string, string]> = [
  [/⌃C|ctrl\+c/i, "Ctrl+C", "ctrl-c"],
  [/⌃R|ctrl\+r/i, "⌃R", "ctrl-r"],
  [/⌃O|ctrl\+o/i, "⌃O", "ctrl-o"],
  [/⌃Q|ctrl\+q/i, "⌃Q", "ctrl-q"],
  [/⌃L|ctrl\+l/i, "⌃L", "ctrl-l"],
  [/PgUp|page ?up/i, "PgUp", "pageup"],
  [/PgDn|page ?down/i, "PgDn", "pagedown"],
  [/⇧⇥|shift\+tab/i, "⇧Tab", "shift-tab"],
  [/\bHome\b/, "Home", "home"],
  [/\bEnd\b/, "End", "end"],
];

/** Keys advertised by the dialog's own footer, in render order. */
export function advertisedKeys(text: string): Array<{ text: string; action: string }> {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  // Legends live at the bottom; scanning the whole screen would also match
  // prose that happens to mention a key.
  const legend = lines.slice(-4).join("\n");
  const found: Array<{ text: string; action: string; at: number }> = [];
  for (const [pattern, label, action] of LEGEND_KEYS) {
    const match = pattern.exec(legend);
    if (!match) continue;
    found.push({ text: label, action, at: match.index });
  }
  return found.sort((a, b) => a.at - b.at).slice(0, 6).map(({ text: label, action }) => ({ text: label, action }));
}

function tuiKeyRows(screenText = ""): Array<Array<{ text: string; value: string }>> {
  const button = (text: string, action: string) => ({ text, value: encodeTuiCallback(action) });
  const base = new Set(["up", "down", "left", "right", "enter", "esc", "space", "tab", "shift-tab", "ctrl-c"]);
  const extra = advertisedKeys(screenText).filter((key) => !base.has(key.action));
  const legendRows: TelegramButton[][] = [];
  for (let i = 0; i < extra.length; i += 3) {
    legendRows.push(extra.slice(i, i + 3).map((key) => button(key.text, key.action)));
  }
  return [
    [button("↑", "up"), button("↓", "down")],
    [button("←", "left"), button("→", "right")],
    [button("Enter", "enter"), button("Esc", "esc")],
    [button("Space", "space"), button("Tab", "tab")],
    [button("⇧Tab", "shift-tab"), button("Ctrl+C", "ctrl-c")],
    ...legendRows,
    [button("⌨️ Type", "type"), button("Refresh", "refresh"), button("Close", "close")],
  ];
}

// Selector keyboards follow /model's select layout: one option per row and a
// Prev/Next row. The host renders only a window of its list (OMP: up to 10
// rows) and scrolls that window as the cursor moves, so paging drives the
// host itself with PageDown/PageUp and rebuilds from the new window instead
// of slicing the parsed rows. Tapping an option moves the host cursor and
// presses Enter (see selectorNavigateKeys); ▸ marks the live cursor.
const SELECTOR_PAGE_SIZE = 10;
const SELECTOR_LABEL_MAX = 45;
// Telegram rejects keyboards over 100 buttons; leave room for the nav and
// function rows when a host renders a complete (unwindowed) list.
const SELECTOR_MAX_BUTTONS = 90;

type SelectorPaging = {
  /** Net host pages moved away from the window the dialog opened on. */
  page: number;
  /** False once a forward page produced no movement (end of the list). */
  hasNext: boolean;
};

type SelectorKeyboard = {
  rows: TelegramButton[][];
};

// OMP renders a scrollbar (thumb U+2588) only when the list overflows the
// window, so it is a second "rows follow" signal for short terminals where
// the window is smaller than SELECTOR_PAGE_SIZE.
function selectorOverflows(selector: SelectorState): boolean {
  return selector.block.split("\n").some((line) => /\u2588\s*[│|]?\s*$/.test(line));
}

function buildSelectorKeyboard(selector: SelectorState, paging: SelectorPaging, screenText = ""): SelectorKeyboard | undefined {
  if (!selector.options.some((option) => option.selected)) return undefined;
  // Windowed hosts (OMP) show one page of their scrolling window; complete
  // lists (pi) render everything, capped only by Telegram's button budget.
  const window = selector.windowed === false
    ? selector.options.slice(0, SELECTOR_MAX_BUTTONS)
    : selector.options.slice(0, SELECTOR_PAGE_SIZE);
  const rows: TelegramButton[][] = window.map((option, index) => {
    const label = option.label.length > SELECTOR_LABEL_MAX
      ? `${option.label.slice(0, SELECTOR_LABEL_MAX - 1)}…`
      : option.label;
    // Checkbox questions keep their state visible: ☑/☐ plus the cursor marker.
    const check = selector.multiSelect ? `${option.checked ? "☑ " : "☐ "}` : "";
    return [{
      text: `${option.selected ? "▸ " : ""}${check}${label}`,
      value: encodeTuiCallback(`pick:${index}`),
    }];
  });
  const hasPrev = (paging.page > 0 || selector.moreAbove === true) && window.length > 0;
  // A full window cannot tell whether rows follow; the first Next tap does.
  // The scrollbar covers short terminals whose window is below the page size;
  // pi's provider selector reports the remainder explicitly.
  const moreBelow = selector.moreBelow
    ?? (window.length >= SELECTOR_PAGE_SIZE || selectorOverflows(selector));
  const hasNext = paging.hasNext && selector.windowed !== false && moreBelow;
  if (hasPrev || hasNext) {
    const nav: TelegramButton[] = [];
    if (hasPrev) nav.push({ text: "◀ Prev", value: encodeTuiCallback("page:prev") });
    if (hasNext) nav.push({ text: "Next ▶", value: encodeTuiCallback("page:next") });
    rows.push(nav);
  }
  // Multi-question dialogs (OMP ask) switch questions with ⇥/←/→; Telegram
  // needs explicit buttons since arrow keys move inside the option list.
  if (selector.multiQuestion) {
    rows.push([
      { text: "◀ Question", value: encodeTuiCallback("q:prev") },
      { text: "Question ▶", value: encodeTuiCallback("q:next") },
    ]);
  }
  // Selector dialogs advertise extra actions in the same footer legend.
  const selectorBase = new Set([
    "up", "down", "left", "right", "enter", "esc", "space", "tab", "shift-tab", "ctrl-c",
  ]);
  const legend = advertisedKeys(screenText || selector.block).filter((key) => !selectorBase.has(key.action));
  for (let i = 0; i < legend.length; i += 3) {
    rows.push(legend.slice(i, i + 3).map((key) => ({ text: key.text, value: encodeTuiCallback(key.action) })));
  }
  const footer: TelegramButton[] = [];
  // Checkbox questions need an explicit submit: Enter confirms the question,
  // which is a different action from toggling an item.
  if (selector.multiSelect) footer.push({ text: "⏎ Submit", value: encodeTuiCallback("enter") });
  footer.push(
    { text: "Esc", value: encodeTuiCallback("esc") },
    { text: "Ctrl+C", value: encodeTuiCallback("ctrl-c") },
    { text: "⌨️ Type", value: encodeTuiCallback("type") },
    { text: "Refresh", value: encodeTuiCallback("refresh") },
    { text: "Close", value: encodeTuiCallback("close") },
  );
  rows.push(footer);
  return { rows };
}

// The selector message mirrors /model's select: title only. The host owns the
// window (and never reports its total), so no page counter is invented; the
// buttons carry the options.
function formatSelectorMessage(selector: SelectorState): string {
  return `<b>${escapeHtml(selector.title ?? "TUI selector")}</b>`;
}

function keyboardSignature(rows: TelegramButton[][]): string {
  return rows.map((row) => row.map((button) => `${button.text}\u0000${button.value}`).join(",")).join("\n");
}

type TuiMirror = {
  chatId: number;
  messageThreadId?: number;
  messageId: number;
  lastText?: string;
  lastCanControl?: boolean;
  pendingText?: boolean;
  /** Selector parsed from the most recent mirror refresh, if any. */
  selector?: SelectorState;
  /** Title of the parsed selector; a new dialog resets paging. */
  selectorTitle?: string;
  /** Paging state for the current selector; the host owns the underlying window. */
  selectorPaging?: SelectorPaging;
  /** Keyboard layout signature; lets the refresh skip unchanged edits. */
  lastKeyboard?: string;
};

/** Text that must not be swallowed by a dialog: shell input and slash commands. */
function isDialogExemptText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("!")) return true;
  return parseLeadingCommand(trimmed) !== undefined;
}

export function createTelegramController(deps: {
  getSession: () => CapturedAgentSession | undefined;
  transport: TelegramTransport;
  ui: TelegramUiRuntime;
  authorizeUser(userId: number | undefined, text?: string): Promise<boolean | "paired">;
  setActiveChatId(chatId: number): Promise<void>;
  getBotUsername(): string | undefined;
  telegramCommands: Map<string, TelegramCommandHandler>;
  getActiveTurn(chatId: number, messageThreadId?: number): TelegramTurn | undefined;
  /** Active turns oldest first, for dialog ownership (§4.3 rule 2). */
  getActiveTurns?(): TelegramTurn[];
  beginTelegramTurn(chatId: number, replaceMessageId?: number, messageThreadId?: number, sourceMessageId?: number): TelegramTurn | undefined;
  endTelegramTurn(chatId: number, turn: TelegramTurn): void;
  saveIncomingTelegramAttachment?: (fileId: string, fileName: string | undefined, kind: string) => Promise<string>;
  getConfig?: () => TelegramConfig;
  tuiBridge?: TuiBridgeAdapter;
  /** Host-family probe; overridable for tests. Defaults to the live module check. */
  isOmpHost?: () => boolean;
  isTelegramActive?: () => boolean;
  /** Host control API for /new; overridable for tests. */
  newSession?: (origin: { chatId: number; messageThreadId?: number; sourceMessageId?: number }) => Promise<{ cancelled?: boolean } | void>;
}): TelegramController {
  const targetKey = (chatId: number, messageThreadId?: number) => `${chatId}:${messageThreadId ?? "main"}`;
  const bridge = deps.tuiBridge ?? defaultTuiBridge;
  const hostIsOmp = deps.isOmpHost ?? isOmpHost;
  const tuiMirrors = new Map<string, TuiMirror>();
  const getTuiMode = () => deps.getConfig?.().tuiBridge ?? "commands";
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const focusTracker = new FocusTracker();
  const originTracker = new OriginTracker({
    isEditorFocused: () => {
      const current = focusTracker.current();
      return current.kind === "unknown" ? bridge.isEditorFocused() : focusTracker.isEditor();
    },
    readDraft: () => {
      const reader = bridge.readEditorText;
      return reader ? reader.call(bridge) : readHostEditorText();
    },
    writeDraft: (text) => {
      const writer = bridge.writeEditorText;
      return writer ? writer.call(bridge, text) : writeHostEditorText(text);
    },
  });
  const secretStore = new SecretStore();
  const outputCapture = new OutputCapture(deps.transport, originTracker, secretStore);
  const commandGateway = new CommandGateway({
    bridge,
    origin: originTracker,
    output: outputCapture,
    focus: focusTracker,
    isEnabled: () => getTuiMode() !== "off",
    readDraft: () => {
      const reader = bridge.readEditorText;
      return reader ? reader.call(bridge) : readHostEditorText();
    },
    writeDraft: (text) => {
      const writer = bridge.writeEditorText;
      return writer ? writer.call(bridge, text) : writeHostEditorText(text);
    },
    newSession: deps.newSession ?? (async (origin) => {
      const session = deps.getSession();
      if (!session) return { cancelled: true };
      const ctx = session.extensionRunner.createCommandContext();
      const create = (ctx as unknown as { newSession?: (options?: unknown) => Promise<{ cancelled?: boolean }> } | undefined)?.newSession;
      if (!create) return { cancelled: true };
      const telegramUi = deps.ui.create(origin.chatId, origin.messageThreadId, origin.sourceMessageId);
      const turn = deps.getActiveTurn(origin.chatId, origin.messageThreadId)
        ?? { chatId: origin.chatId, messageThreadId: origin.messageThreadId, sourceMessageId: origin.sourceMessageId, queuedAttachments: [] };
      return runWithTelegramTurn(turn, () => runWithTelegramUi({
        session,
        ui: telegramUi,
        turn,
        run: async () => await create.call(ctx, { withSession: async () => undefined }),
      }));
    }),
  });
  commandGateway.start();

  const dialogBroker = new DialogBroker({
    transport: deps.transport,
    focus: focusTracker,
    origin: originTracker,
    secrets: secretStore,
    activeChatId: () => deps.getConfig?.().activeChatId,
    activeTurns: () => deps.getActiveTurns?.() ?? [],
    writeText: (text) => bridge.write(text),
    // One switch for both (§9 决定 27): the broker may only track a host whose
    // dialogs it can actually read. A host without a usable bridge has no focus to
    // track anyway, and OMP's components render in an overlay without focus, so
    // there it must stay completely inert - see hostOwnsPrompts.
    enabled: () => hostOwnsPrompts(bridge, getTuiMode()),
  });
  dialogBroker.start();

  const refreshTuiMirror = async (mirror: TuiMirror): Promise<void> => {
    let snapshot: TuiSnapshot | undefined;
    try { snapshot = bridge.snapshot(TUI_SCREEN_WIDTH); } catch {}
    if (!snapshot) {
      for (let i = 0; i < 8; i += 1) {
        await sleep(30);
        try { snapshot = bridge.snapshot(TUI_SCREEN_WIDTH); } catch {}
        if (snapshot) break;
      }
    }
    if (!snapshot) {
      await deps.transport.editText(mirror.chatId, mirror.messageId, "TUI bridge is no longer available.").catch(ctrlLog.swallow("debug", "editText TUI unavailable failed", { chatId: mirror.chatId }));
      await deps.transport.removeInlineKeyboard(mirror.chatId, mirror.messageId).catch(ctrlLog.swallow("debug", "removeInlineKeyboard TUI unavailable failed", { chatId: mirror.chatId }));
      tuiMirrors.delete(targetKey(mirror.chatId, mirror.messageThreadId));
      return;
    }

    const selector = snapshot.interactive ? parseSelectorText(snapshot.text ?? "") : undefined;
    mirror.selector = selector;
    const selectorTitle = selector?.title ?? "";
    if (selector && mirror.selectorTitle !== selectorTitle) {
      mirror.selectorTitle = selectorTitle;
      mirror.selectorPaging = { page: 0, hasNext: true };
    }
    const canControl = snapshot.interactive && getTuiMode() === "full" && !mirror.pendingText;
    const selectorKeyboard = canControl && selector
      ? buildSelectorKeyboard(selector, mirror.selectorPaging ?? { page: 0, hasNext: true }, snapshot.text ?? "")
      : undefined;
    // Panels drawn into the transcript (not focusable overlays) still carry a
  // boxed title; show it instead of the generic "TUI"/"TUI screen" label.
  const dialogTitle = !selector ? readDialogTitle(snapshot.text ?? "") : undefined;
    const title = mirror.pendingText
      ? "TUI · send the next Telegram message as input"
      : snapshot.interactive
        ? (selector?.title ?? dialogTitle ?? (selector ? "TUI selector" : "TUI screen"))
        : (dialogTitle ?? "TUI");
    const inputHint = snapshot.interactive && !selector && getTuiMode() === "full"
      && hasInputPrompt(snapshot.text ?? "")
      ? "\n\n<i>⌨️ This dialog expects typed input: tap ⌨️ Type, send the text as the next message, then tap ⏎ Enter.</i>"
      : "";
    const hint = snapshot.interactive && getTuiMode() !== "full"
      ? "\n\n<i>Interactive mirror is off. Set TUI bridge to full in /tg → Config to control this selector.</i>"
      : inputHint;
    const text = selectorKeyboard && selector
      ? formatSelectorMessage(selector)
      : `${formatTuiSnapshot(snapshot, title, selector)}${hint}`;
    const rows: TelegramButton[][] | undefined = mirror.pendingText
      ? [[{ text: "Cancel", value: encodeTuiCallback("cancel-type") }]]
      : canControl
        ? (selectorKeyboard?.rows ?? tuiKeyRows(snapshot.text ?? ""))
        : undefined;
    const keyboardSig = rows ? keyboardSignature(rows) : "none";
    if (text === mirror.lastText && mirror.lastCanControl === canControl && keyboardSig === mirror.lastKeyboard && !mirror.pendingText) return;
    mirror.lastText = text;
    mirror.lastCanControl = canControl;
    mirror.lastKeyboard = keyboardSig;

    if (rows) {
      await deps.transport.editButtons(mirror.chatId, mirror.messageId, text, rows).catch(ctrlLog.swallow("debug", "editButtons failed", { chatId: mirror.chatId }));
    } else {
      await deps.transport.editText(mirror.chatId, mirror.messageId, text).catch(ctrlLog.swallow("debug", "editText failed", { chatId: mirror.chatId }));
      await deps.transport.removeInlineKeyboard(mirror.chatId, mirror.messageId).catch(ctrlLog.swallow("debug", "removeInlineKeyboard TUI mirror failed", { chatId: mirror.chatId }));
      if (!snapshot.interactive) tuiMirrors.delete(targetKey(mirror.chatId, mirror.messageThreadId));
    }
  };

  /**
   * Attach a mirror to a prompt the host is about to render. Prompts are modal
   * (one owns the terminal at a time) and belong to the turn that raised them,
   * so the requesting chat gets the mirror and answers with injected keys —
   * exactly what someone at the terminal would do.
   */
  const startPromptMirror = (turn: TelegramTurn): void => {
    if (getTuiMode() !== "full") return;
    const chatId = turn.chatId;
    const messageThreadId = turn.messageThreadId;
    const key = targetKey(chatId, messageThreadId);
    const existing = tuiMirrors.get(key);
    if (existing) {
      void refreshTuiMirror(existing);
      return;
    }
    void (async () => {
      // The observer fires before the host renders; wait for the overlay.
      let snapshot: TuiSnapshot | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(30);
        try { snapshot = bridge.snapshot(TUI_SCREEN_WIDTH); } catch { snapshot = undefined; }
        if (snapshot?.interactive) break;
      }
      if (!snapshot?.interactive) return;
      if (tuiMirrors.has(key)) return;
      const sent = await deps.transport
        .sendText(chatId, "<b>TUI prompt</b>", messageThreadId, turn.sourceMessageId)
        .catch(ctrlLog.swallow("warn", "sendText prompt mirror failed", { chatId }));
      const messageId = sent?.[0]?.message_id;
      if (messageId === undefined) return;
      const mirror: TuiMirror = { chatId, messageThreadId, messageId };
      tuiMirrors.set(key, mirror);
      await refreshTuiMirror(mirror);
      let lastEditAt = Date.now();
      for (;;) {
        await sleep(TUI_PROMPT_POLL_MS);
        if (tuiMirrors.get(key) !== mirror) return;
        if (!deps.getActiveTurn(chatId, messageThreadId)) return;
        let live: TuiSnapshot | undefined;
        try { live = bridge.snapshot(TUI_SCREEN_WIDTH); } catch { live = undefined; }
        if (!live) return;
        // Selector prompts render as a title plus buttons (stable text); other
        // overlays carry spinners, so their whole-screen mirror is throttled to
        // stay clear of Telegram's per-chat edit rate.
        const parsed = live.interactive ? parseSelectorText(live.text ?? "") : undefined;
        const now = Date.now();
        if (!parsed && now - lastEditAt < TUI_PROMPT_EDIT_MS) {
          if (!live.interactive) return;
          continue;
        }
        await refreshTuiMirror(mirror);
        lastEditAt = now;
        if (!live.interactive) return;
      }
      tuiMirrors.delete(key);
    })();
  };

  const promptMirrorHook = (turn: TelegramTurn): (() => void) | undefined => {
    // The DialogBroker mirrors dialogs from its real component; a mirror of
    // the same screen would be a second stale copy of one dialog (§4.4). Only a
    // dialog this chat can see counts: a session the terminal owns has no
    // message here, and standing down for it would leave no keyboard at all.
    if (getTuiMode() !== "full" || !bridge.isAvailable()) return undefined;
    if (dialogBroker.mirrorsFor(turn.chatId, turn.messageThreadId)) return undefined;
    return () => startPromptMirror(turn);
  };

  /**
   * §4.2.6 item 2: while the DialogBroker is live, prompts raised by work this
   * chat started belong to the host UI — a terminal user can answer them and
   * Telegram mirrors them, so neither end is locked out. Everywhere else - and on
   * hosts whose dialogs the broker cannot read yet - the plugin keeps answering
   * them in Telegram. See hostOwnsPrompts for the full condition.
   */
  const promptUiMode = (): "telegram-native" | "host" =>
    (hostOwnsPrompts(bridge, getTuiMode()) ? "host" : "telegram-native");

  const runTuiCommand = async (
    name: string,
    args: string,
    chatId: number,
    messageThreadId?: number,
    sourceMessageId?: number,
  ): Promise<void> => {
    try {
      await runTuiCommandInner(name, args, chatId, messageThreadId, sourceMessageId);
    } catch (err) {
      ctrlLog.error("runTuiCommand failed", { err, name });
    }
  };

  const runTuiCommandInner = async (
    name: string,
    args: string,
    chatId: number,
    messageThreadId?: number,
    sourceMessageId?: number,
  ): Promise<void> => {
    if (getTuiMode() === "off") return;
    await bridge.ready().catch(ctrlLog.swallow("debug", "TUI bridge readiness failed"));
    if (!bridge.isAvailable()) {
      await deps.transport.sendText(
        chatId,
        "TUI bridge is unavailable on this host; the command was not sent.",
        messageThreadId,
        sourceMessageId,
      ).catch(ctrlLog.swallow("warn", "sendText TUI unavailable failed", { chatId }));
      return;
    }

    const commandText = `/${name}${args.trim() ? ` ${args.trim()}` : ""}`;
    const status = await deps.transport.sendText(
      chatId,
      `<b>▶️ TUI command</b>\n${preformatted(commandText)}`,
      messageThreadId,
      sourceMessageId,
    ).catch(ctrlLog.swallow("warn", "sendText TUI command status failed", { chatId }));
    const messageId = status?.[0]?.message_id;
    ctrlLog.debug("TUI command ack", { name, messageId, status });
    if (messageId === undefined) return;

    const submitted = bridge.submit(commandText);
    ctrlLog.debug("TUI command submitted", { name, submitted });
    if (!submitted) {
      await deps.transport.editText(chatId, messageId, "TUI bridge could not submit the command.").catch(ctrlLog.swallow("debug", "editText TUI submit failure failed", { chatId }));
      return;
    }

    let snapshot: TuiSnapshot | undefined;
    for (let attempt = 0; attempt < TUI_POLL_ATTEMPTS; attempt += 1) {
      await sleep(TUI_POLL_INTERVAL_MS);
      try {
        snapshot = bridge.snapshot(TUI_SCREEN_WIDTH);
      } catch (err) {
        ctrlLog.debug("TUI snapshot poll failed", { err, attempt });
      }
      if (snapshot?.interactive) break;
    }

    ctrlLog.debug("TUI snapshot after command", { name, interactive: snapshot?.interactive, len: snapshot?.text?.length });
    if (!snapshot) {
      await deps.transport.editText(chatId, messageId, "Command sent to TUI; this host did not expose a renderable screen.").catch(ctrlLog.swallow("debug", "editText TUI no snapshot failed", { chatId }));
      return;
    }

    if (snapshot.interactive && getTuiMode() === "full") {
      // Give the broker a beat: a dialog this command opened belongs to it, and
      // two mirrors of one dialog would fight over the same keystrokes. Only a
      // session that drew a message in this chat may take the keyboard away.
      await sleep(TUI_PROMPT_POLL_MS * 2);
      if (dialogBroker.mirrorsFor(chatId, messageThreadId)) {
        await deps.transport
          .editText(chatId, messageId, `<b>▶️ ${escapeHtml(commandText)}</b>\n\n<i>选择器已在上面的消息里，也可以直接在终端操作。</i>`)
          .catch(ctrlLog.swallow("debug", "editText broker-owned ack failed", { chatId }));
        return;
      }
      const key = targetKey(chatId, messageThreadId);
      const mirror: TuiMirror = { chatId, messageThreadId, messageId };
      tuiMirrors.set(key, mirror);
      await refreshTuiMirror(mirror);
      // Authorization flows (OAuth wait screens) change without user action:
      // keep the mirror current until the overlay closes or is replaced.
      void (async () => {
        let lastEditAt = Date.now();
        let lastText = snapshot?.text ?? "";
        let idleSince = Date.now();
        for (;;) {
          await sleep(TUI_PROMPT_POLL_MS);
          if (tuiMirrors.get(key) !== mirror) return;
          let live: TuiSnapshot | undefined;
          try { live = bridge.snapshot(TUI_SCREEN_WIDTH); } catch { live = undefined; }
          if (!live) return;
          const text = live.text ?? "";
          const changed = text !== lastText;
          const now = Date.now();
          if (changed) idleSince = now;
          // Never treat the first non-interactive frame as "closed": right after
          // dispatch the host still shows the old screen (/settings froze on the
          // pre-panel frame that way). Stop only once the screen stays put.
          if (!changed) {
            if (!live.interactive && now - idleSince >= TUI_MIRROR_IDLE_MS) return;
            continue;
          }
          // Spinner-bearing screens change every frame; keep them off the
          // Telegram edit limit, but let selector updates through immediately.
          const parsed = live.interactive ? parseSelectorText(text) : undefined;
          if (!parsed && now - lastEditAt < TUI_PROMPT_EDIT_MS) continue;
          await refreshTuiMirror(mirror);
          lastEditAt = now;
          lastText = text;
        }
      })();
    } else {
      const selector = snapshot.interactive ? parseSelectorText(snapshot.text ?? "") : undefined;
      const hint = snapshot.interactive
        ? "\n\n<i>Interactive mirror is off. Set TUI bridge to full in /tg → Config to control this selector.</i>"
        : "";
      const panelTitle = selector ? undefined : readDialogTitle(snapshot.text ?? "");
      const label = snapshot.interactive
        ? (selector ? "TUI selector" : (panelTitle ?? "TUI screen"))
        : (panelTitle ?? "TUI");
      const body = `${formatTuiSnapshot(snapshot, label, selector)}${hint}`;
      // Static panels (e.g. /mcp, /context) close with Esc in the terminal. Give
      // the mirror the same escape hatch instead of a dead-end screen.
      const closable = !snapshot.interactive && panelTitle !== undefined
        && /(?:\besc\b|⎋|\bclose\b|\bcancel\b)/i.test(snapshot.text ?? "");
      if (closable) {
        tuiMirrors.set(targetKey(chatId, messageThreadId), { chatId, messageThreadId, messageId });
        await deps.transport.editButtons(chatId, messageId, body, [[{ text: "⎋ Close", value: encodeTuiCallback("esc") }]])
          .catch(ctrlLog.swallow("debug", "editButtons TUI panel failed", { chatId }));
      } else {
        await deps.transport.editText(chatId, messageId, body)
          .catch(ctrlLog.swallow("debug", "editText TUI snapshot failed", { chatId }));
      }
    }
  };

  const runTelegramBash = async (
    command: string,
    excludeFromContext: boolean,
    chatId: number,
    messageThreadId: number | undefined,
    sourceMessageId: number | undefined,
    userId: number | undefined,
    chatType: string | undefined,
  ): Promise<void> => {
    if (chatType && chatType !== "private") {
      await deps.transport.sendText(chatId, "Shell commands are only allowed in private chats.", messageThreadId, sourceMessageId);
      return;
    }
    if (!command) {
      await deps.transport.sendText(chatId, "Usage: !<command> (or !!<command> to exclude output from context).", messageThreadId, sourceMessageId);
      return;
    }

    const session = deps.getSession();
    const executor = session ? readBashExecutor(session) : undefined;
    if (!session || !executor) {
      await deps.transport.sendText(chatId, "Shell execution is not available in this session.", messageThreadId, sourceMessageId);
      return;
    }

    const policy: TelegramBashConfirm = deps.getConfig?.().bashConfirm ?? "dangerous";
    if (policy === "always" || (policy === "dangerous" && isDangerousBash(command))) {
      const confirmUi = deps.ui.create(chatId, messageThreadId, sourceMessageId);
      const approved = await confirmUi.confirm(
        "Run shell command?",
        `${command}\n\ncwd: ${process.cwd()}\ncontext: ${excludeFromContext ? "excluded" : "included"}`,
      );
      if (!approved) {
        await deps.transport.sendText(chatId, "Shell command cancelled.", messageThreadId, sourceMessageId);
        return;
      }
    }

    const status = await deps.transport.sendText(
      chatId,
      `<b>▶️ bash</b>\n${preformatted(`$ ${command}`)}`,
      messageThreadId,
      sourceMessageId,
    ).catch(ctrlLog.swallow("warn", "sendText bash status failed", { chatId }));
    const messageId = status?.[0]?.message_id;
    let output = "";
    let lastEditAt = 0;
    let editChain: Promise<void> = Promise.resolve();

    const editProgress = (final: boolean, result?: BashResult): void => {
      if (messageId === undefined) return;
      const clean = stripAnsi(output || result?.output || "").replace(/\r\n/g, "\n");
      const header = final ? "bash finished" : "bash";
      const exitLine = final
        ? `\nexit: ${result?.cancelled ? "cancelled" : result?.exitCode ?? "unknown"}${result?.truncated ? " · output truncated" : ""}`
        : "";
      const pathLine = final && result?.fullOutputPath ? `\nfull output: ${result.fullOutputPath}` : "";
      const body = `<b>▶️ ${header}</b>\n${preformatted(`$ ${command}`)}\n${preformatted(tailText(clean || "(no output)"))}${exitLine}${pathLine}`;
      editChain = editChain
        .then(() => deps.transport.editText(chatId, messageId, body))
        .catch(ctrlLog.swallow("debug", "editText bash progress failed", { chatId, messageId }));
    };

    const onChunk = (chunk: string): void => {
      output += chunk;
      const now = Date.now();
      if (now - lastEditAt < BASH_STREAM_DEBOUNCE_MS) return;
      lastEditAt = now;
      editProgress(false);
    };

    let timedOut = false;
    const abort = readBashAbort(session);
    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeout = new Promise<BashResult>((resolve) => {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        void Promise.resolve(abort?.()).catch(ctrlLog.swallow("debug", "abortBash after timeout failed"));
        resolve({ exitCode: 124, cancelled: true });
      }, BASH_TIMEOUT_MS);
      timeoutTimer.unref?.();
    });

    let result: BashResult;
    try {
      result = await Promise.race([
        executor.call(session, command, onChunk, { excludeFromContext }),
        timeout,
      ]);
    } catch (err) {
      ctrlLog.warn("telegram bash failed", { chatId, command, err });
      await deps.transport.sendText(chatId, `⚠️ Shell command failed: ${commandErrorMessage(err)}`, messageThreadId, sourceMessageId);
      return;
    } finally {
      clearTimeout(timeoutTimer);
    }

    if (timedOut) output += `\n[timed out after ${Math.round(BASH_TIMEOUT_MS / 1000)}s]`;
    editProgress(true, result);
    await editChain;
    ctrlLog.info("telegram bash executed", {
      chatId,
      userId,
      cwd: process.cwd(),
      command,
      excludeFromContext,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      timedOut,
    });
  };

  const handleTuiCallback = async (
    action: string,
    chatId: number,
    messageThreadId: number | undefined,
  ): Promise<void> => {
    await bridge.ready().catch(ctrlLog.swallow("debug", "TUI callback bridge readiness failed"));
    const key = targetKey(chatId, messageThreadId);
    const mirror = tuiMirrors.get(key);
    if (!mirror) {
      await deps.transport.sendText(chatId, "This TUI prompt is no longer active.", messageThreadId);
      return;
    }
    if (action === "close") {
      bridge.key("esc");
      tuiMirrors.delete(key);
      await deps.transport.editText(chatId, mirror.messageId, "TUI mirror closed.").catch(ctrlLog.swallow("debug", "editText TUI close failed", { chatId }));
      await deps.transport.removeInlineKeyboard(chatId, mirror.messageId).catch(ctrlLog.swallow("debug", "removeInlineKeyboard TUI close failed", { chatId }));
      return;
    }
    if (action === "type") {
      mirror.pendingText = true;
      mirror.lastText = undefined;
      await refreshTuiMirror(mirror);
      return;
    }
    if (action === "cancel-type") {
      mirror.pendingText = false;
      mirror.lastText = undefined;
      await refreshTuiMirror(mirror);
      return;
    }
    if (action === "page:next" || action === "page:prev") {
      const forward = action === "page:next";
      const before = mirror.selector?.options.map((option) => option.label).join("\u0000") ?? "";
      // The host renders on its own frame; poll until the window moves (or the
      // list ends, which is the only way to learn there is nothing more).
      const windowMoved = async (): Promise<boolean> => {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await sleep(40);
          let snapshot: TuiSnapshot | undefined;
          try { snapshot = bridge.snapshot(TUI_SCREEN_WIDTH); } catch { snapshot = undefined; }
          const parsed = snapshot?.interactive ? parseSelectorText(snapshot.text ?? "") : undefined;
          const after = parsed?.options.map((option) => option.label).join("\u0000") ?? "";
          if (after.length > 0 && after !== before) return true;
        }
        return false;
      };
      let moved = false;
      if (bridge.key(forward ? "pageDown" : "pageUp")) moved = await windowMoved();
      // pi's selectors do not implement page keys; when their scroll indicator
      // proves rows remain, page by walking one window of arrow steps.
      if (!moved && mirror.selector?.moreBelow === true) {
        const steps = Math.max(1, mirror.selector.options.length);
        for (let i = 0; i < steps; i += 1) {
          if (!bridge.key(forward ? "down" : "up")) break;
        }
        moved = await windowMoved();
      }
      const paging = mirror.selectorPaging ?? { page: 0, hasNext: true };
      mirror.selectorPaging = forward
        ? { page: paging.page + (moved ? 1 : 0), hasNext: moved }
        : { page: Math.max(0, paging.page - (moved ? 1 : 0)), hasNext: paging.hasNext || moved };
      mirror.lastText = undefined;
      mirror.lastKeyboard = undefined;
      await refreshTuiMirror(mirror);
      return;
    }
    if (action.startsWith("pick:")) {
      mirror.pendingText = false;
      const index = Number.parseInt(action.slice("pick:".length), 10);
      const target = mirror.selector?.options[index];
      let liveSnapshot: TuiSnapshot | undefined;
      try { liveSnapshot = bridge.snapshot(TUI_SCREEN_WIDTH); } catch { liveSnapshot = undefined; }
      const live = liveSnapshot?.interactive ? parseSelectorText(liveSnapshot.text ?? "") : undefined;
      if (!target || !live) {
        mirror.lastText = undefined;
        await deps.transport.sendText(chatId, "That selector changed; tap an item on the refreshed keyboard.", messageThreadId);
        await refreshTuiMirror(mirror);
        return;
      }
      const liveIndex = live.options.findIndex((option) => option.label === target.label);
      if (liveIndex === -1) {
        mirror.lastText = undefined;
        await deps.transport.sendText(chatId, `"${target.label}" is no longer in this list; tap an item on the refreshed keyboard.`, messageThreadId);
        await refreshTuiMirror(mirror);
        return;
      }
      const navKeys = selectorNavigateKeys(live, liveIndex);
      // Checkbox questions toggle: Enter would submit the question (and an
      // empty submit cancels it). Move onto the row, then press Space.
      const keys = navKeys && live.multiSelect ? [...navKeys.slice(0, -1), "space"] : navKeys;
      if (!keys) {
        mirror.lastText = undefined;
        await deps.transport.sendText(chatId, "Cannot locate the current item in this dialog; use the arrow keys instead.", messageThreadId);
        await refreshTuiMirror(mirror);
        return;
      }
      for (const press of keys) {
        if (!bridge.key(press)) {
          await deps.transport.sendText(chatId, "The TUI selector no longer accepts input.", messageThreadId);
          tuiMirrors.delete(key);
          return;
        }
      }
      await sleep(TUI_POLL_INTERVAL_MS * 2);
      mirror.lastText = undefined;
      mirror.lastKeyboard = undefined;
      await refreshTuiMirror(mirror);
      return;
    }
    if (action === "q:prev" || action === "q:next") {
      if (!bridge.key(action === "q:prev" ? "shift-tab" : "tab")) {
        await deps.transport.sendText(chatId, "The TUI dialog no longer accepts input.", messageThreadId);
        tuiMirrors.delete(key);
        return;
      }
      await sleep(TUI_POLL_INTERVAL_MS * 2);
      mirror.lastText = undefined;
      mirror.lastKeyboard = undefined;
      await refreshTuiMirror(mirror);
      return;
    }
    if (action !== "refresh") {
      if (!bridge.key(action)) {
        await deps.transport.sendText(chatId, "The TUI selector no longer accepts input.", messageThreadId);
        tuiMirrors.delete(key);
        return;
      }
      await sleep(TUI_POLL_INTERVAL_MS);
    }
    mirror.lastText = undefined;
    await refreshTuiMirror(mirror);
  };

  const unsubscribeLocalTui = bridge.onLocalSubmit((text) => {
    if (getTuiMode() === "off" || deps.isTelegramActive?.() === false) return;
    const command = text.trim();
    if (!command.startsWith("/") && !command.startsWith("!")) return;
    if (/^\/?tg(?:-|$)/.test(command)) return;
    const chatId = deps.getConfig?.().activeChatId;
    if (chatId === undefined) return;
    void (async () => {
      await deps.transport.sendText(chatId, `<b>⌨️ TUI command</b>\n${preformatted(command)}`)
        .catch(ctrlLog.swallow("warn", "sendText local TUI command failed", { chatId }));
      await sleep(450);
      const snapshot = bridge.snapshot(TUI_SCREEN_WIDTH);
      if (!snapshot) return;
      await deps.transport.sendText(chatId, formatTuiSnapshot(snapshot, snapshot.interactive ? "TUI selector (local)" : "TUI result", snapshot.interactive ? parseSelectorText(snapshot.text ?? "") : undefined))
        .catch(ctrlLog.swallow("warn", "sendText local TUI snapshot failed", { chatId }));
    })();
  });

  // Per chat/thread prompt queues: each Telegram topic chains independently.
  const promptTails = new Map<string, Promise<void>>();
  // Increasing generation per chat/thread lets stop invalidate pending queue items.
  const interruptGenerationByTarget = new Map<string, number>();

  const getOrCreateTail = (key: string): Promise<void> => promptTails.get(key) ?? Promise.resolve();
  const setTail = (key: string, tail: Promise<void>) => promptTails.set(key, tail);
  const getInterruptGeneration = (key: string): number => interruptGenerationByTarget.get(key) ?? 0;
  const bumpInterruptGeneration = (key: string): void => {
    const next = getInterruptGeneration(key) + 1;
    interruptGenerationByTarget.set(key, next);
  };

  const fastInterrupt = async (chatId: number, messageThreadId?: number, sourceMessageId?: number) => {
    const session = deps.getSession();
    if (!session) {
      await deps.transport.sendText(chatId, "π session is not ready yet.", messageThreadId, sourceMessageId);
      return;
    }

    bumpInterruptGeneration(targetKey(chatId, messageThreadId));
    await deps.transport.sendText(chatId, "⏹️ Interrupt requested.", messageThreadId, sourceMessageId);
    const abortResult = (session as any).abort?.();
    void abortResult?.catch?.(() => undefined);
  };

  const reportPromptFailure = async (label: string, chatId: number, messageThreadId: number | undefined, sourceMessageId: number | undefined, err: unknown): Promise<void> => {
    ctrlLog.error(`${label} prompt task failed`, { chatId, messageThreadId, sourceMessageId, err });
    await deps.transport.sendText(chatId, "⚠️ Your message could not be delivered to π. Please retry.", messageThreadId, sourceMessageId)
      .catch(ctrlLog.swallow("warn", "sendText prompt-failure notice failed", { chatId, messageThreadId, sourceMessageId }));
  };

  // Main-mode delivery: wait until the main loop is idle, then submit a plain
  // prompt (no streamingBehavior) so core starts a fresh main-thread turn.
  // While background workflow agents run, session.isStreaming stays true and
  // core rejects plain prompts; steer/followUp would drain into a workflow
  // agent's turn instead (repo issue #10).
  const deliverToMainThread = async (text: string, chatId: number, messageThreadId: number | undefined, sourceMessageId: number | undefined): Promise<void> => {
    const session = deps.getSession();
    if (!session) return;
    const ctx = session.extensionRunner.createCommandContext();
    const idleFn = typeof (ctx as any).isIdle === "function" ? (ctx as any).isIdle : undefined;
    const waitFn = typeof (ctx as any).waitForIdle === "function" ? (ctx as any).waitForIdle : undefined;

    let heldNoticeSent = false;
    const sendHeldNotice = async (): Promise<void> => {
      if (heldNoticeSent) return;
      heldNoticeSent = true;
      await deps.transport.sendText(
        chatId,
        "⏳ π is busy — holding your message until the main thread is idle.",
        messageThreadId,
        sourceMessageId,
      ).catch(ctrlLog.swallow("warn", "sendText held-notice failed", { chatId, messageThreadId, sourceMessageId }));
    };

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    const maxDeliveryAttempts = 20;
    for (let attempt = 0; attempt < maxDeliveryAttempts; attempt += 1) {
      if (session.isStreaming) {
        await sendHeldNotice();
        if (waitFn) {
          try {
            await waitFn.call(ctx);
          } catch (err) {
            // Session disposed / torn down during the wait — nothing to deliver to.
            ctrlLog.debug("waitForIdle during main-delivery hold interrupted", { chatId, messageThreadId, err });
            return;
          }
        } else {
          await sleep(500);
        }
        // Settle window: pi-goal schedules continuation turns via
        // setTimeout(0 / 50ms) after a turn ends. Yield one macrotask window
        // so the loop only proceeds when the stream stays idle.
        await sleep(120);
        // A main turn (e.g. a goal continuation) started while we waited —
        // behave like the terminal and steer into it instead of holding.
        if (idleFn && !idleFn.call(ctx)) {
          await session.prompt(text, { source: "interactive", streamingBehavior: "steer" as const });
          return;
        }
        continue;
      }
      try {
        await session.prompt(text, { source: "interactive" });
        return;
      } catch (err) {
        // A goal continuation or workflow step may have started between our
        // idle check and prompt dispatch. Loop and wait again.
        ctrlLog.debug("main-delivery prompt raced with a new turn; waiting again", { chatId, messageThreadId, attempt, err });
        await sleep(120);
      }
    }
    await reportPromptFailure("main-delivery", chatId, messageThreadId, sourceMessageId, new Error("main-mode delivery attempts exhausted"));
  };

  // Hold-and-deliver path shared by "main" and idle-"tui": wait until the
  // main loop is idle, then submit a plain prompt so the message always
  // starts a fresh main-thread turn.
  const runMainDelivery = async (text: string, chatId: number, replaceMessageId: number | undefined, messageThreadId: number | undefined, sourceMessageId: number | undefined) => {
    const turn = deps.beginTelegramTurn(chatId, replaceMessageId, messageThreadId, sourceMessageId);
    if (!turn) {
      // Target already has an active turn — reject with a busy message.
      if (replaceMessageId !== undefined) await deps.transport.editText(chatId, replaceMessageId, "⏳ π is busy. Try again shortly.");
      else await deps.transport.sendText(chatId, "⏳ π is busy. Try again shortly.", messageThreadId, sourceMessageId);
      return;
    }
    const session = deps.getSession();
    if (!session) return;
    const telegramUi = deps.ui.create(chatId, messageThreadId, sourceMessageId);
    try {
      await runWithTelegramTurn(turn, () => runWithTelegramUi({
        session,
        ui: telegramUi,
        turn,
        uiMode: promptUiMode(),
        observePrompts: promptMirrorHook(turn),
        run: () => deliverToMainThread(text, chatId, messageThreadId, sourceMessageId),
      }));
    } finally {
      deps.endTelegramTurn(chatId, turn);
    }
  };

  const runPrompt = async (text: string, chatId: number, replaceMessageId?: number, messageThreadId?: number, sourceMessageId?: number) => {
    const session = deps.getSession();
    if (!session) {
      if (replaceMessageId !== undefined) await deps.transport.editText(chatId, replaceMessageId, "π session is not ready yet.");
      else await deps.transport.sendText(chatId, "π session is not ready yet.", messageThreadId, sourceMessageId);
      return;
    }

    // TUI parity: a message behaves exactly like typing in the terminal.
    // While the main loop runs its own turn, steer into it; while background
    // agents run with the main loop idle, hold and deliver a plain prompt once
    // the main loop settles. ctx.isIdle() distinguishes the two —
    // session.isStreaming alone cannot (it stays true for background runs).
    let mainBusy = session.isStreaming;
    try {
      const probeCtx = session.extensionRunner.createCommandContext();
      const idleFn = typeof (probeCtx as any).isIdle === "function" ? (probeCtx as any).isIdle : undefined;
      mainBusy = idleFn ? !idleFn.call(probeCtx) : session.isStreaming;
    } catch {
      mainBusy = session.isStreaming;
    }
    const isSteer = mainBusy;

    // While the main loop is idle, hold the message until it settles, then
    // submit a plain prompt so the message always starts a fresh main-thread
    // turn; it is never steered or queued into a background workflow agent's
    // turn.
    if (!mainBusy) {
      await runMainDelivery(text, chatId, replaceMessageId, messageThreadId, sourceMessageId);
      return;
    }

    // In steer mode, reuse the existing active turn for this chat/thread.
    // Steer messages inject into a running stream — they must not acquire a
    // new turn (which would fail since the target is already busy).
    if (isSteer) {
      const existingTurn = deps.getActiveTurn(chatId, messageThreadId);
      if (!existingTurn) {
        // No active turn to steer into — fall back to a new prompt.
        const turn = deps.beginTelegramTurn(chatId, undefined, messageThreadId, sourceMessageId);
        if (!turn) {
          await deps.transport.sendText(chatId, "⏳ π is busy. Try again shortly.", messageThreadId, sourceMessageId);
          return;
        }
        const telegramUi = deps.ui.create(chatId, messageThreadId, sourceMessageId);
        try {
          await runWithTelegramTurn(turn, () => runWithTelegramUi({
            session,
            ui: telegramUi,
            turn,
            uiMode: promptUiMode(),
            observePrompts: promptMirrorHook(turn),
            run: async () => {
              // Goal auto-continuations can be streaming without owning an
              // active TelegramTurn. Keep the delivery behavior tied to the
              // configured mode rather than to our renderer bookkeeping.
              await session.prompt(text, { source: "interactive", streamingBehavior: "steer" });
            },
          }));
        } finally {
          deps.endTelegramTurn(chatId, turn);
        }
        return;
      }
      const telegramUi = deps.ui.create(chatId, messageThreadId, sourceMessageId);
      await runWithTelegramTurn(existingTurn, () => runWithTelegramUi({
        session,
        ui: telegramUi,
        turn: existingTurn,
        uiMode: promptUiMode(),
        observePrompts: promptMirrorHook(existingTurn),
        run: () => session.prompt(text, { source: "interactive", streamingBehavior: "steer" as const }),
      }));
      return;
    }
  };

  const submitText = async (text: string, chatId: number, replaceMessageId?: number, messageThreadId?: number, sourceMessageId?: number) => {
    // Chain behind the previous prompt for this chat/thread so multiple
    // messages are delivered to the main thread in order.
    const key = targetKey(chatId, messageThreadId);
    const generation = getInterruptGeneration(key);
    const task = getOrCreateTail(key)
      .then(() => {
        if (generation !== getInterruptGeneration(key)) return;
        return runPrompt(text, chatId, replaceMessageId, messageThreadId, sourceMessageId);
      })
      .catch((err) => reportPromptFailure("prompt-delivery", chatId, messageThreadId, sourceMessageId, err));
    setTail(key, task);
  };

  const runCommandHandler = (handler: TelegramCommandHandler, args: string, session: CapturedAgentSession, chatId: number, messageThreadId?: number, sourceMessageId?: number, label = "command") => {
    // Commands run immediately — they do not acquire a turn and are never
    // blocked by an active agent prompt.  Fast config / status commands
    // briefly borrow the UI context; the rendering pipeline still finds the
    // existing prompt turn via getActiveTurn() and stream output normally.
    //
    // Do not await command handlers here: some commands open interactive
    // prompts (e.g. /new confirmation), and awaiting them would stall the
    // polling loop and block callback processing for that update.
    const telegramUi = deps.ui.create(chatId, messageThreadId, sourceMessageId);
    const ctx = session.extensionRunner.createCommandContext();
    // Whether the host - rather than the plugin - answers prompts raised by this
    // command's own work (§4.2.6 item 2).
    const hostPrompts = promptUiMode() === "host";
    // §4.3 rule 1: while a Telegram-issued command runs, the dialogs it opens
    // belong to this chat. Without a scope the broker tracks them silently
    // (§4.3 rule 3) and the chat is left with a raw key mirror - no typed
    // input, no secret handling, no keyboard withdrawal when it closes.
    const scope = hostPrompts
      ? originTracker.begin({ chatId, messageThreadId, sourceMessageId }, label, "", "")
      : undefined;
    // In telegram-native mode the command's own prompts (e.g. /new's confirm) are pinned
    // to the Telegram UI, and a host with no UI-context setter needs the same treatment
    // because there is no routed proxy to lean on. In host mode the host answers, and its
    // context still exposes the plugin's `menu` affordance (see createHostPromptUi).
    const commandCtx = typeof session.extensionRunner.setUIContext === "function" || hostPrompts
      ? ctx
      : withUiContext(ctx, telegramUi);
    // Capture idleness BEFORE the handler runs. Commands like /sisyphus and
    // /goals enqueue the agent turn fire-and-forget via pi.sendUserMessage and
    // return immediately; the actual turn (and any goal_question /
    // propose_goal_draft / goal_questionnaire dialogs it raises) runs AFTER the
    // handler resolves. If we let runWithTelegramUi restore the TUI UI at that
    // point, those dialogs render to the local TUI and Telegram gets nothing.
    // Only hold the swap when the agent was idle when the command arrived: if a
    // local turn was already streaming, holding the swap would hijack the local
    // user's TUI (modals would route to Telegram, editor would no-op).
    const wasIdle = typeof (ctx as any).isIdle === "function" ? (ctx as any).isIdle.call(ctx) : false;
    const commandTurn = deps.getActiveTurn(chatId, messageThreadId) ?? { chatId, messageThreadId, sourceMessageId, queuedAttachments: [] };
    void runWithTelegramTurn(commandTurn, () => runWithTelegramUi({
      session,
      ui: telegramUi,
      turn: commandTurn,
      // With the broker live the host owns the prompt: a command's own dialog
      // (an extension's `ui.select`, a `/goals` confirmation) renders in the
      // terminal, so the terminal user can answer it too. The scope above makes
      // the broker attribute it to this chat, and the broker's keyboard is the
      // one the chat sees - no screen mirror, which could not take typed text,
      // hide a secret answer, or withdraw itself once the terminal answered.
      uiMode: promptUiMode(),
      run: async () => {
        try {
          await handler(args, commandCtx);
          await holdThroughEnqueuedTurns(ctx, wasIdle);
        } finally {
          // The scope deliberately outlives the handler: a dialog answered a
          // moment later still belongs to this chat, and the tracker ends the
          // scope only once focus is back in the editor and output went quiet.
          if (scope) originTracker.markSubmitDone(scope);
        }
      },
    })).catch(async (err) => {
      ctrlLog.warn("telegram command handler failed", { chatId, messageThreadId, err });
      await deps.transport.sendText(chatId, `⚠️ Command failed:\n${commandErrorMessage(err)}`, messageThreadId, sourceMessageId)
        .catch(ctrlLog.swallow("warn", "sendText command-failure notice failed", { chatId, messageThreadId }));
    });
  };

  const menuOverflow = (): Array<{ command: string; description: string }> => {
    const config = deps.getConfig?.();
    return getTelegramMenuOverflow(config?.botToken, config?.apiBase);
  };

  const moreKeyboard = (page: number): { text: string; rows: TelegramButton[][] } => {
    const overflow = menuOverflow();
    const pageCount = Math.max(1, Math.ceil(overflow.length / MORE_PAGE_SIZE));
    const safePage = Math.min(Math.max(page, 0), pageCount - 1);
    const slice = overflow.slice(safePage * MORE_PAGE_SIZE, (safePage + 1) * MORE_PAGE_SIZE);
    const rows: TelegramButton[][] = [];
    for (let i = 0; i < slice.length; i += MORE_ROW_SIZE) {
      rows.push(slice.slice(i, i + MORE_ROW_SIZE).map((entry) => ({
        text: `/${entry.command}`,
        value: encodeRunCallback(entry.command),
      })));
    }
    if (pageCount > 1) {
      const nav: TelegramButton[] = [];
      if (safePage > 0) nav.push({ text: "◀️", value: encodeMoreCallback(safePage - 1) });
      nav.push({ text: `${safePage + 1} / ${pageCount}`, value: encodeMoreCallback(safePage) });
      if (safePage < pageCount - 1) nav.push({ text: "▶️", value: encodeMoreCallback(safePage + 1) });
      rows.push(nav);
    }
    return { text: `More commands (${overflow.length} beyond the BotMenu) — tap one to run it.`, rows };
  };

  const dispatchNamedCommand = async (
    name: string,
    args: string,
    session: CapturedAgentSession,
    chatId: number,
    messageThreadId?: number,
    sourceMessageId?: number,
  ): Promise<boolean> => {
    // /more opens the overflow keyboard for this bot's menu. Only claimed when
    // an overflow exists, so a user-registered /more keeps working otherwise.
    if (name === "more" && menuOverflow().length > 0) {
      const { text, rows } = moreKeyboard(0);
      await deps.transport.sendButtons(chatId, text, rows, messageThreadId, sourceMessageId);
      return true;
    }

    // Stage 1 gateway: output-only commands go straight to the host editor.
    // Native handlers and the screen mirror must not also run for these.
    if (getTuiMode() !== "off" && bridge.isAvailable() && commandGateway.couldHandle(name)) {
      if (commandGateway.handles(name)) {
        const handled = await commandGateway.run({
          name,
          args,
          origin: { chatId, messageThreadId, sourceMessageId },
          transport: deps.transport,
        });
        if (handled) {
          recordCommandUsage(name);
          return true;
        }
      }
    }

    // These commands deliberately use the host selector/confirmation UI when
    // the bridge is enabled. Telegram-native handlers remain the fallback when
    // the host catalog does not expose the command.
    if (getTuiMode() !== "off" && TUI_NATIVE_SELECTOR_COMMANDS.has(name)) {
      const candidates = new Set([name, name.replace(/_/g, "-"), name.replace(/-/g, "_")]);
      const catalog = await bridge.getCommands().catch(() => []);
      const known = catalog.some((command) => candidates.has(command.name)
        || (command.aliases ?? []).some((alias) => candidates.has(alias)));
      if (known) {
        recordCommandUsage(name);
        void runTuiCommand(name, args, chatId, messageThreadId, sourceMessageId);
        return true;
      }
    }

    const handler =
      deps.telegramCommands.get(name)
      ?? deps.telegramCommands.get(name.replace(/_/g, "-"))
      ?? deps.telegramCommands.get(name.replace(/-/g, "_"));

    // Mirror-first dialogs: with interactive control available, the host's own
    // UI is the source of truth, so Telegram mirrors it instead of running a
    // native re-implementation (labels, ordering, status markers and paging
    // stay identical to the terminal). Applies to every host that serves the
    // command; the branches below remain as the fallback.
    if (getTuiMode() === "full" && MIRROR_FIRST_COMMANDS.has(name)) {
      const mirrorCandidates = new Set([name, name.replace(/_/g, "-"), name.replace(/-/g, "_")]);
      const mirrorCatalog = await bridge.getCommands().catch(() => []);
      const served = mirrorCatalog.some((command) => mirrorCandidates.has(command.name)
        || (command.aliases ?? []).some((alias) => mirrorCandidates.has(alias)));
      if (served) {
        recordCommandUsage(name);
        void runTuiCommand(name, args, chatId, messageThreadId, sourceMessageId);
        return true;
      }
    }

    if (handler && HOST_CAPABILITY_COMMANDS.has(name) && !nativeHandlerAvailable(name, session, hostIsOmp())) {
      recordCommandUsage(name);
      if (getTuiMode() !== "off") {
        const catalog = await bridge.getCommands().catch(() => []);
        if (catalog.some((command) => command.name === name || (command.aliases ?? []).includes(name))) {
          void runTuiCommand(name, args, chatId, messageThreadId, sourceMessageId);
          return true;
        }
      }
      await deps.transport.sendText(chatId, hostCommandUnavailableNotice(name), messageThreadId, sourceMessageId);
      return true;
    }
    if (handler) {
      recordCommandUsage(name);
      await runCommandHandler(handler, args, session, chatId, messageThreadId, sourceMessageId, name);
      return true;
    }
    const externalCommand =
      session.extensionRunner.getCommand(name)
      ?? session.extensionRunner.getCommand(name.replace(/_/g, "-"))
      ?? session.extensionRunner.getCommand(name.replace(/-/g, "_"));
    if (externalCommand) {
      recordCommandUsage(name);
      await runCommandHandler(externalCommand.handler, args, session, chatId, messageThreadId, sourceMessageId, name);
      return true;
    }

    if (getTuiMode() !== "off") {
      const candidates = new Set([name, name.replace(/_/g, "-"), name.replace(/-/g, "_")]);
      const catalog = await bridge.getCommands().catch(() => []);
      const known = catalog.some((command) => candidates.has(command.name)
        || (command.aliases ?? []).some((alias) => candidates.has(alias)));
      if (known) {
        recordCommandUsage(name);
        void runTuiCommand(name, args, chatId, messageThreadId, sourceMessageId);
        return true;
      }
    }
    return false;
  };

  const tryHandleSlashCommand = async (text: string, chatId: number, messageThreadId?: number, sourceMessageId?: number): Promise<boolean> => {
    const parsed = parseLeadingCommand(text);
    if (!parsed) return false;
    const session = deps.getSession();
    if (!session) {
      await deps.transport.sendText(chatId, "π session is not ready yet.", messageThreadId, sourceMessageId);
      return true;
    }
    return await dispatchNamedCommand(parsed.name.toLowerCase(), parsed.args, session, chatId, messageThreadId, sourceMessageId);
  };

  return {
    async handleCallbackQuery(query) {
      const chatId = query.message?.chat?.id;
      if (typeof chatId !== "number") return;
      const messageThreadId = query.message?.message_thread_id;
      const sourceMessageId = query.message?.message_id;
      if (!(await deps.authorizeUser(query.from?.id))) return;
      await deps.setActiveChatId(chatId);

      const data = query.data ?? "";
      // Dialog buttons are answered here and nowhere else (§4.5 rule 3). This
      // branch runs before the generic acknowledgement because the toast has to
      // travel inside the same answerCallbackQuery call. Anything carrying the
      // dialog prefix belongs to a dialog - even a payload that no longer
      // decodes, because submitted as text it would run as a prompt.
      if (data.startsWith(DIALOG_CALLBACK_PREFIX)) {
        const dialogCallback = decodeDialogCallback(data);
        const result = dialogCallback === undefined
          ? { handled: true, toast: "这个菜单已经过期", clear: true }
          : dialogBroker.handleCallback(chatId, messageThreadId, dialogCallback);
        await deps.transport.answerCallbackQuery(query.id, result.toast)
          .catch(ctrlLog.swallow("debug", "answerCallbackQuery failed", { queryId: query.id }));
        const pageMessageId = query.message?.message_id;
        if (result.clear && pageMessageId !== undefined) {
          await deps.transport.removeInlineKeyboard(chatId, pageMessageId)
            .catch(ctrlLog.swallow("debug", "removeInlineKeyboard dialog keyboard failed", { chatId }));
        }
        return;
      }

      await deps.transport.answerCallbackQuery(query.id).catch(ctrlLog.swallow("debug", "answerCallbackQuery failed", { queryId: query.id }));
      const uiValue = decodeUiCallback(data);
      if (uiValue !== undefined) {
        const result = deps.ui.resolveInput(chatId, uiValue, query.message?.message_id, true, messageThreadId);
        if (!result.handled) {
          await deps.transport.sendText(chatId, "This prompt is no longer active.", messageThreadId, sourceMessageId);
        }
        // Keyboard cleanup is OWNED by each UI flow (confirm/input/select and the
        // custom-dialog bridge): each calls removeInlineKeyboard on its own prompt
        // message right before resolving a terminal value (yes/no/cancel/submit/...).
        // The controller must NOT speculatively strip keyboards here. Doing so races
        // with continuation flows (multi-question tab navigation, single-question
        // option toggles, select pagination) that edit the SAME message in place:
        // removeInlineKeyboard and editButtons hit Telegram concurrently on one
        // message, and when the strip lands last the message is left with no
        // buttons — the "answered Q1 but Q2 never appeared" bug. Terminal flows
        // clean up themselves, so no controller-side strip is needed.
        return;
      }

      const morePage = decodeMoreCallback(data);
      if (morePage !== undefined) {
        const pageMessageId = query.message?.message_id;
        if (pageMessageId !== undefined) {
          const { text, rows } = moreKeyboard(Number.parseInt(morePage, 10) || 0);
          await deps.transport.editButtons(chatId, pageMessageId, text, rows).catch(ctrlLog.swallow("debug", "editButtons /more page failed", { chatId }));
        }
        return;
      }

      const runName = decodeRunCallback(data);
      if (runName !== undefined) {
        const session = deps.getSession();
        if (!session) {
          await deps.transport.sendText(chatId, "π session is not ready yet.", messageThreadId, sourceMessageId);
          return;
        }
        const dispatched = await dispatchNamedCommand(runName.toLowerCase(), "", session, chatId, messageThreadId, sourceMessageId);
        if (!dispatched) {
          await deps.transport.sendText(chatId, `/${escapeHtml(runName)} is no longer available.`, messageThreadId, sourceMessageId);
        }
        return;
      }

      const tuiAction = decodeTuiCallback(data);
      if (tuiAction !== undefined) {
        await handleTuiCallback(tuiAction, chatId, messageThreadId);
        return;
      }

      if (data) {
        const messageId = query.message?.message_id;
        await submitText(data, chatId, messageId, messageThreadId, sourceMessageId);
      }
    },

    async handleMessage(message) {
      const chatId = message.chat?.id;
      if (typeof chatId !== "number") return;
      const messageThreadId = message.message_thread_id;
      const sourceMessageId = message.message_id;
      const rawText = message.text ?? message.caption ?? "";
      ctrlLog.debug("incoming telegram message shape", {
        messageId: message.message_id,
        keys: Object.keys(message),
        hasReplyToMessage: !!message.reply_to_message,
        hasQuote: !!message.quote,
        hasTextQuote: !!message.text_quote,
        hasExternalReply: !!message.external_reply,
      });
      const authorization = await deps.authorizeUser(message.from?.id, rawText);
      if (!authorization) return;
      await deps.setActiveChatId(chatId);
      if (authorization === "paired") {
        await deps.transport.sendText(chatId, "✅ Telegram user paired.", messageThreadId, sourceMessageId);
        return;
      }

      const pendingTuiMirror = tuiMirrors.get(targetKey(chatId, messageThreadId));
      if (pendingTuiMirror?.pendingText && message.text !== undefined) {
        pendingTuiMirror.pendingText = false;
        pendingTuiMirror.lastText = undefined;
        // A dialog field is a key sequence, not a document: newlines from a
        // pasted Telegram message would submit before the text is complete.
        if (!bridge.write(message.text.replace(/\r?\n/g, " "))) {
          await deps.transport.sendText(chatId, "The TUI selector no longer accepts input.", messageThreadId, sourceMessageId);
          tuiMirrors.delete(targetKey(chatId, messageThreadId));
          return;
        }
        await sleep(TUI_POLL_INTERVAL_MS);
        await refreshTuiMirror(pendingTuiMirror);
        return;
      }

      const text = normalizeLeadingCommand(rawText, deps.getBotUsername());
      const trimmed = text.trim();
      const replyToInput = message.reply_to_message?.message_id;
      if (trimmed.startsWith("!")) {
        const excludeFromContext = trimmed.startsWith("!!");
        const command = trimmed.slice(excludeFromContext ? 2 : 1).trim();
        if (dialogBroker.mirrorsFor(chatId, messageThreadId)) {
          // §4.2: the dialog owns the keyboard, so the shell command has nowhere
          // to land; say so instead of queueing it behind the dialog.
          await deps.transport.sendText(chatId, "⚠️ 终端里有对话框正在等待输入：先回答它，或发送 /stop 关闭。", messageThreadId, sourceMessageId)
            .catch(ctrlLog.swallow("warn", "sendText dialog busy notice failed", { chatId }));
          return;
        }

        void runTelegramBash(
          command,
          excludeFromContext,
          chatId,
          messageThreadId,
          sourceMessageId,
          message.from?.id,
          message.chat?.type,
        ).catch(async (err) => {
          ctrlLog.error("telegram bash failed", { err, chatId, userId: message.from?.id });
          await deps.transport.sendText(
            chatId,
            `Shell command failed: ${escapeHtml(commandErrorMessage(err))}`,
            messageThreadId,
            sourceMessageId,
          ).catch(ctrlLog.swallow("warn", "sendText bash failure failed", { chatId }));
        });
        return;
      }
      if (message.reply_to_message || message.quote || message.text_quote || message.external_reply) logTelegramReplyContext(message);
      if (trimmed === "/stop") {
        // §4.5 rule 6: the dialog gets the Esc first, then the normal /stop path
        // runs (pending input, bash abort, turn interrupt).
        dialogBroker.cancelFor(chatId, messageThreadId);

        // /stop cancellation priority: first try canceling a reply-targeted
        // pending input, then any pending input, then abort the agent turn.
        const cancelResult = deps.ui.resolveInput(chatId, undefined, replyToInput, false, messageThreadId);
        const cancelAnyResult = !cancelResult.handled ? deps.ui.resolveInput(chatId, undefined, undefined, false, messageThreadId) : cancelResult;
        if (cancelAnyResult.handled) {
          if (cancelAnyResult.promptMessageId) void deps.transport.removeInlineKeyboard(chatId, cancelAnyResult.promptMessageId);
          await deps.transport.sendText(chatId, "Cancelled.", messageThreadId, sourceMessageId);
          return;
        }
        const stopSession = deps.getSession();
        if (stopSession && isBashRunning(stopSession)) {
          const abort = readBashAbort(stopSession);
          await Promise.resolve(abort?.()).catch(ctrlLog.swallow("debug", "abortBash from /stop failed"));
          await deps.transport.sendText(chatId, "⏹️ Bash stopped.", messageThreadId, sourceMessageId);
          return;
        }
        await fastInterrupt(chatId, messageThreadId, sourceMessageId);
        return;
      }

      const mediaSummary = buildTelegramIncomingMediaSummary(message);
      const hasMediaInput = mediaSummary.length > 0;
      const hasTextInput = message.text !== undefined || message.caption !== undefined;
      const incomingMedia = hasMediaInput ? extractTelegramMediaEntries(message) : [];
      const downloadedMediaLines: string[] = [];
      const failedMediaLines: string[] = [];
      if (deps.saveIncomingTelegramAttachment && incomingMedia.length > 0) {
        const mediaSaveResults = await Promise.allSettled(
          incomingMedia.map((attachment) => deps.saveIncomingTelegramAttachment!(
            attachment.fileId,
            attachment.fileName,
            attachment.type,
          )),
        );
        for (let i = 0; i < incomingMedia.length; i++) {
          const media = incomingMedia[i];
          const saveResult = mediaSaveResults[i];
          if (saveResult.status === "fulfilled") {
            downloadedMediaLines.push(formatSavedIncomingAttachmentLine(media.type, media.fileId, media.fileName, saveResult.value));
          } else {
            const reason = saveResult.reason instanceof Error ? saveResult.reason.message : String(saveResult.reason);
            failedMediaLines.push(formatIncomingAttachmentErrorLine(media.type, media.fileId, media.fileName, reason));
          }
        }
        if (downloadedMediaLines.length > 0 || failedMediaLines.length > 0) {
          const lines = [
            formatIncomingAttachmentReceipt("saved", downloadedMediaLines),
            formatIncomingAttachmentReceipt("failed", failedMediaLines),
          ].filter(Boolean);
          await deps.transport.sendText(chatId, lines.join("\n\n"), messageThreadId, sourceMessageId).catch(ctrlLog.swallow("warn", "sendText media receipt failed", { chatId, messageThreadId }));
        }
      }
      const hasPromptInput = hasTextInput || hasMediaInput;
      if (hasTextInput) {
        const wasSensitive = deps.ui.isSensitiveInput(chatId, replyToInput, messageThreadId);
        const inputResult = deps.ui.resolveInput(chatId, rawText, replyToInput, false, messageThreadId);
        ctrlLog.debug("TMP native text", { chatId, handled: inputResult.handled });
        if (inputResult.handled) {
          if (wasSensitive) await deps.transport.deleteMessage(chatId, message.message_id);
          return;
        }
      }
      // Only now does a mirrored host dialog get the text (§4.5.1): in the terminal this
      // same message would be a search term or a typed answer. A prompt the plugin raised
      // in this chat is answered above - it waits on a Telegram keyboard *here*, while the
      // mirror only borrows the chat. Without that order a terminal dialog nobody asked
      // about in this chat (an unadapted snapshot, say) swallows the answer the user is
      // typing for the prompt, and the prompt then eats the next message instead.
      const dialogSession = dialogBroker.sessionFor(chatId, messageThreadId);
      ctrlLog.debug("TMP dialog text", {
        chatId,
        session: dialogSession !== undefined,
        drawn: dialogSession?.telegram !== undefined,
        purpose: dialogSession?.pendingInput?.purpose ?? null,
        modelKind: (dialogSession?.model as { kind?: string } | undefined)?.kind ?? null,
      });
      if (dialogSession !== undefined && message.text !== undefined && !isDialogExemptText(rawText)) {
        const result = dialogBroker.handleText(dialogSession, rawText, message.message_id);
        if (result.handled) {
          if (result.toast !== undefined) {
            await deps.transport.sendText(chatId, result.toast, messageThreadId, sourceMessageId)
              .catch(ctrlLog.swallow("warn", "sendText dialog hint failed", { chatId }));
          }
          return;
        }
      }
      if (hasPromptInput) {
        const mediaBlock = (() => {
          if (!hasMediaInput) return "";
          const lines = [mediaSummary];
          const statusLines = [...downloadedMediaLines, ...failedMediaLines];
          if (statusLines.length > 0) {
            lines.push(statusLines.join("\n"));
          }
          return `\n\n${lines.filter(Boolean).join("\n")}`;
        })();
        const handled = trimmed ? await tryHandleSlashCommand(text, chatId, messageThreadId, sourceMessageId) : false;
        if (!handled) {
          const parsed = parseLeadingCommand(text);
          const basePrompt = parsed
            ? `/${parsed.name.replace(/_/g, "-")}${parsed.args ? ` ${parsed.args}` : ""}`
            : trimmed || "";
          const promptText = `${basePrompt}${mediaBlock}`.trim();
          const quotedBlock = buildTelegramReplyContextBlock(message);
          const finalPrompt = quotedBlock
            ? `${quotedBlock}\n\n[telegram message]\n${promptText}`.trim()
            : promptText;
          await submitText(finalPrompt, chatId, undefined, messageThreadId, sourceMessageId);
        }
      }
    },

    async runCommand(name, args, chatId, messageThreadId, sourceMessageId) {
      const session = deps.getSession();
      if (!session) {
        await deps.transport.sendText(chatId, "π session is not ready yet.", messageThreadId, sourceMessageId);
        return;
      }
      await dispatchNamedCommand(name.toLowerCase(), args, session, chatId, messageThreadId, sourceMessageId);
    },

    dispose() {
      dialogBroker.stop();
      unsubscribeLocalTui();
      tuiMirrors.clear();
      commandGateway.dispose();
    },
  };
}
