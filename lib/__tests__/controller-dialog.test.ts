import { describe, expect, it, vi } from "vitest";
import { createTelegramController } from "../controller.ts";
import type { CapturedAgentSession, TelegramTransport } from "../types.ts";
import type { TuiBridgeAdapter } from "../tui-bridge.ts";

type Call = { method: string; text?: string; messageId?: number; queryId?: string };

function createTransport(calls: Call[]): TelegramTransport {
  const text = (value: string, messageId?: number): void => { calls.push({ method: "text", text: value, messageId }); };
  return {
    removeInlineKeyboard: async (_chatId, messageId) => { calls.push({ method: "removeKeyboard", messageId }); },
    sendText: async (_chatId, value) => {
      text(value);
      return [{ message_id: 1 }];
    },
    sendButtons: async (_chatId, value) => {
      text(value);
      return { message_id: 2 };
    },
    editText: async (_chatId, messageId, value) => { text(value, messageId); },
    editButtons: async (_chatId, messageId, value) => { calls.push({ method: "buttons", text: value, messageId }); },
    answerCallbackQuery: async (queryId, textValue) => {
      calls.push({ method: "answer", queryId, text: textValue });
    },
    deleteMessage: async () => undefined,
    sendDocument: async () => undefined,
    sendPhoto: async () => undefined,
    sendChatAction: async () => undefined,
  };
}

function createSession(overrides: Record<string, unknown> = {}): CapturedAgentSession {
  return {
    prompt: vi.fn(async () => undefined),
    isStreaming: false,
    extensionRunner: {
      getUIContext: () => undefined,
      setUIContext: () => undefined,
      getCommand: () => undefined,
      createCommandContext: () => ({}),
    },
    executeBash: vi.fn(async (_command: string, onChunk: (chunk: string) => void) => {
      onChunk("PTP_BASH_OK\n");
      return { exitCode: 0, output: "PTP_BASH_OK\n" };
    }),
    abortBash: vi.fn(),
    isBashRunning: false,
    ...overrides,
  } as unknown as CapturedAgentSession;
}

function createBridge(overrides: Partial<TuiBridgeAdapter> = {}): TuiBridgeAdapter {
  return {
    ready: async () => undefined,
    isAvailable: () => true,
    getHost: () => "pi",
    getCommands: async () => [{ name: "settings", description: "Open settings", source: "builtin" }],
    submit: vi.fn(() => true),
    snapshot: vi.fn(() => ({ text: "Settings\n> Theme", interactive: false, host: "pi" as const, width: 100 })),
    key: vi.fn(() => true),
    write: vi.fn(() => true),
    isEditorFocused: () => true,
    isInteractiveFocus: () => false,
    onLocalSubmit: () => () => undefined,
    ...overrides,
  };
}

function createHarness(options: {
  mode?: "off" | "commands" | "full";
  session?: CapturedAgentSession;
  bridge?: TuiBridgeAdapter;
} = {}) {
  const calls: Call[] = [];
  const transport = createTransport(calls);
  const session = options.session ?? createSession();
  const controller = createTelegramController({
    getSession: () => session,
    transport,
    ui: {
      create: () => ({ notify: async () => undefined, confirm: vi.fn(async () => true) }) as never,
      resolveInput: () => ({ handled: false }),
      isSensitiveInput: () => false,
      hasPendingInput: () => false,
      dispose: () => undefined,
    },
    authorizeUser: async () => true,
    setActiveChatId: async () => undefined,
    getBotUsername: () => "test-bot",
    telegramCommands: new Map(),
    getActiveTurn: () => undefined,
    beginTelegramTurn: (chatId: number, replaceMessageId?: number) => ({
      chatId,
      replaceMessageId,
      queuedAttachments: [],
    }),
    endTelegramTurn: () => undefined,
    getConfig: () => ({ tuiBridge: options.mode ?? "full", bashConfirm: "dangerous", activeChatId: 42 }),
    tuiBridge: options.bridge ?? createBridge(),
  });
  return { controller, calls, session };
}

describe("dialog callback dispatch", () => {
  // A dialog payload is a key sequence for the focused component. Submitted as
  // text it would run as a prompt (or worse, as a shell line), so the dialog
  // branch has to swallow it in every bridge mode.
  for (const mode of ["off", "commands", "full"] as const) {
    it(`never submits a dialog callback as a prompt in ${mode} mode`, async () => {
      const harness = createHarness({ mode });

      await harness.controller.handleCallbackQuery({
        id: "cb-9",
        data: "tgplus:dlg:s1:0:c:0.1",
        message: { message_id: 55, chat: { id: 42, type: "private" } },
        from: { id: 7 },
      });

      expect(harness.session.prompt).not.toHaveBeenCalled();
      expect(harness.calls.some((call) => call.method === "text"
        && String(call.text).includes("tgplus:dlg:"))).toBe(false);
      // Nothing is focused, so the answer is "handled in the terminal" and the
      // dead keyboard has to come off the message.
      expect(harness.calls.some((call) => call.method === "answer"
        && call.text === "已在终端处理")).toBe(true);
      expect(harness.calls.some((call) => call.method === "removeKeyboard" && call.messageId === 55)).toBe(true);
    });
  }

  it("swallows a dialog payload that no longer decodes", async () => {
    const harness = createHarness({ mode: "full" });

    await harness.controller.handleCallbackQuery({
      id: "cb-10",
      data: "tgplus:dlg:stale-keyboard",
      message: { message_id: 56, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });

    expect(harness.session.prompt).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.method === "answer"
      && call.text === "这个菜单已经过期")).toBe(true);
    expect(harness.calls.some((call) => call.method === "removeKeyboard" && call.messageId === 56)).toBe(true);
  });

  it("keeps plain chat text on the prompt path in full mode", async () => {
    const harness = createHarness({ mode: "full" });

    await harness.controller.handleMessage({
      message_id: 60,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "summarize the failing test",
    });

    await vi.waitFor(() => expect(harness.session.prompt).toHaveBeenCalledWith(
      "summarize the failing test",
      { source: "interactive" },
    ));
  });

  it("keeps shell input on the bash path in full mode", async () => {
    const harness = createHarness({ mode: "full" });

    await harness.controller.handleMessage({
      message_id: 61,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "!echo hi",
    });

    await vi.waitFor(() => expect(harness.session.executeBash).toHaveBeenCalledWith(
      "echo hi",
      expect.any(Function),
      { excludeFromContext: false },
    ));
  });
});
