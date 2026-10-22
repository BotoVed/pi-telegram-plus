import { describe, expect, it, vi } from "vitest";
import { createTelegramController } from "../controller.ts";
import type { CapturedAgentSession, TelegramTransport } from "../types.ts";
import type { TuiBridgeAdapter } from "../tui-bridge.ts";

type Call = { method: string; text?: string; messageId?: number; rows?: unknown };

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
    editButtons: async (_chatId, messageId, value, rows) => {
      calls.push({ method: "buttons", text: value, messageId, rows });
    },
    answerCallbackQuery: async () => undefined,
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
  session?: CapturedAgentSession;
  bridge?: TuiBridgeAdapter;
  config?: { tuiBridge?: "off" | "commands" | "full"; bashConfirm?: "always" | "dangerous" | "never"; activeChatId?: number };
  confirmResult?: boolean;
  telegramCommands?: Map<string, any>;
  confirm?: ReturnType<typeof vi.fn>;
  isOmpHost?: () => boolean;
} = {}) {
  const calls: Call[] = [];
  const transport = createTransport(calls);
  const session = options.session ?? createSession();
  const bridge = options.bridge ?? createBridge();
  const confirm = options.confirm ?? vi.fn(async () => options.confirmResult ?? true);
  const config = options.config ?? { tuiBridge: "commands", bashConfirm: "dangerous", activeChatId: 42 };
  const controller = createTelegramController({
    getSession: () => session,
    transport,
    ui: {
      create: () => ({
        notify: async () => undefined,
        confirm,
      }) as never,
      resolveInput: () => ({ handled: false }),
      isSensitiveInput: () => false,
      hasPendingInput: () => false,
      dispose: () => undefined,
    },
    authorizeUser: async () => true,
    setActiveChatId: async () => undefined,
    getBotUsername: () => "test-bot",
    telegramCommands: options.telegramCommands ?? new Map(),
    getActiveTurn: () => undefined,
    beginTelegramTurn: (chatId, replaceMessageId) => ({ chatId, replaceMessageId, queuedAttachments: [] }),
    endTelegramTurn: () => undefined,
    getConfig: () => config,
    tuiBridge: bridge,
    isOmpHost: options.isOmpHost,
  });
  return { controller, transport, calls, session, bridge, config, confirm };
}

describe("Telegram shell commands", () => {
  it("executes !cmd with context enabled and streams the result", async () => {
    const harness = createHarness();
    await harness.controller.handleMessage({
      message_id: 10,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "!echo hi",
    });

    await vi.waitFor(() => {
      expect(harness.session.executeBash).toHaveBeenCalledWith(
        "echo hi",
        expect.any(Function),
        { excludeFromContext: false },
      );
      expect(harness.calls.some((call) => call.text?.includes("PTP_BASH_OK"))).toBe(true);
      expect(harness.calls.some((call) => call.text?.includes("exit: 0"))).toBe(true);
    });
  });

  it("executes !!cmd with context excluded", async () => {
    const harness = createHarness();
    await harness.controller.handleMessage({
      message_id: 11,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "!!false",
    });

    await vi.waitFor(() => expect(harness.session.executeBash).toHaveBeenCalledWith(
      "false",
      expect.any(Function),
      { excludeFromContext: true },
    ));
  });

  it("asks before a destructive command under the dangerous policy", async () => {
    const harness = createHarness({ confirmResult: false });
    await harness.controller.handleMessage({
      message_id: 12,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "!rm -rf /tmp/example",
    });

    expect(harness.confirm).toHaveBeenCalledWith(
      "Run shell command?",
      expect.stringContaining("rm -rf /tmp/example"),
    );
    expect(harness.session.executeBash).not.toHaveBeenCalled();
  });

  it("returns the update handler while a bash confirmation is pending", async () => {
    let resolveConfirm: ((value: boolean) => void) | undefined;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => { resolveConfirm = resolve; }));
    const harness = createHarness({ confirm });

    await expect(harness.controller.handleMessage({
      message_id: 16,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "!rm -rf /tmp/example",
    })).resolves.toBeUndefined();

    expect(confirm).toHaveBeenCalled();
    resolveConfirm?.(false);
    await vi.waitFor(() => expect(harness.session.executeBash).not.toHaveBeenCalled());
  });

  it("always asks before a safe command", async () => {
    const harness = createHarness({
      config: { tuiBridge: "commands", bashConfirm: "always", activeChatId: 42 },
      confirmResult: false,
    });
    await harness.controller.handleMessage({
      message_id: 14,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "!echo safe",
    });

    expect(harness.confirm).toHaveBeenCalled();
    expect(harness.session.executeBash).not.toHaveBeenCalled();
  });

  it("never asks before a dangerous command", async () => {
    const harness = createHarness({
      config: { tuiBridge: "commands", bashConfirm: "never", activeChatId: 42 },
    });
    await harness.controller.handleMessage({
      message_id: 15,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "!rm -rf /tmp/example",
    });

    expect(harness.confirm).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(harness.session.executeBash).toHaveBeenCalled());
  });

  it("rejects shell commands outside private chats", async () => {
    const harness = createHarness();
    await harness.controller.handleMessage({
      message_id: 13,
      chat: { id: -100, type: "supergroup" },
      from: { id: 7 },
      text: "!echo hi",
    });

    expect(harness.session.executeBash).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.text?.includes("private chats"))).toBe(true);
  });
});

describe("TUI command bridge routing", () => {
  it("forwards a captured host command that has no Telegram handler", async () => {
    const submit = vi.fn(() => true);
    const harness = createHarness({ bridge: createBridge({ submit }) });
    await harness.controller.handleMessage({
      message_id: 20,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "/settings",
    });

    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("/settings"));
    expect(harness.calls.some((call) => call.text?.includes("TUI command"))).toBe(true);
  });

  it("renders an interactive selector and routes callback keys in full mode", async () => {
    const key = vi.fn(() => true);
    const bridge = createBridge({
      getCommands: async () => [{ name: "settings", description: "Open settings", source: "builtin" }],
      snapshot: vi.fn(() => ({ text: "Settings\n> Theme", interactive: true, host: "pi" as const, width: 100 })),
      key,
    });
    const harness = createHarness({
      bridge,
      config: { tuiBridge: "full", bashConfirm: "dangerous", activeChatId: 42 },
    });

    await harness.controller.handleMessage({
      message_id: 21,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "/settings",
    });

    await vi.waitFor(() => {
      expect(harness.calls.some((call) => call.method === "buttons")).toBe(true);
    });

    await harness.controller.handleCallbackQuery({
      id: "cb-1",
      data: "tgplus:tui:down",
      message: { message_id: 1, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });

    await vi.waitFor(() => expect(key).toHaveBeenCalledWith("down"));
  });

  it("prefers the host /settings selector over the Telegram-native handler", async () => {
    const submit = vi.fn(() => true);
    const nativeSettings = vi.fn(async () => undefined);
    const bridge = createBridge({
      submit,
      snapshot: vi.fn(() => ({ text: "Settings\n> Theme", interactive: true, host: "pi" as const, width: 100 })),
    });
    const harness = createHarness({
      bridge,
      config: { tuiBridge: "full", bashConfirm: "dangerous", activeChatId: 42 },
      telegramCommands: new Map([["settings", nativeSettings]]),
    });

    await harness.controller.handleMessage({
      message_id: 29,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "/settings",
    });

    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("/settings"));
    expect(nativeSettings).not.toHaveBeenCalled();
  });

  it("writes arbitrary Telegram text into an active selector", async () => {
    const key = vi.fn(() => true);
    const write = vi.fn(() => true);
    const bridge = createBridge({
      snapshot: vi.fn(() => ({ text: "Settings\n> Search", interactive: true, host: "pi" as const, width: 100 })),
      key,
      write,
    });
    const harness = createHarness({
      bridge,
      config: { tuiBridge: "full", bashConfirm: "dangerous", activeChatId: 42 },
    });

    await harness.controller.handleMessage({
      message_id: 30,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "/settings",
    });
    await vi.waitFor(() => expect(harness.calls.some((call) => call.method === "buttons")).toBe(true));

    await harness.controller.handleCallbackQuery({
      id: "cb-type",
      data: "tgplus:tui:type",
      message: { message_id: 1, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });
    await harness.controller.handleMessage({
      message_id: 31,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "arbitrary model/search text",
    });

    expect(write).toHaveBeenCalledWith("arbitrary model/search text");
    expect(key).not.toHaveBeenCalledWith("arbitrary model/search text");
  });

  it.each(["up", "down", "left", "right", "enter", "esc", "space", "tab"])(
    "routes the %s selector key",
    async (action) => {
      const key = vi.fn(() => true);
      const bridge = createBridge({
        snapshot: vi.fn(() => ({ text: "Settings\n> Theme", interactive: true, host: "pi" as const, width: 100 })),
        key,
      });
      const harness = createHarness({
        bridge,
        config: { tuiBridge: "full", bashConfirm: "dangerous", activeChatId: 42 },
      });

      await harness.controller.handleMessage({
        message_id: 40,
        chat: { id: 42, type: "private" },
        from: { id: 7 },
        text: "/settings",
      });
      await vi.waitFor(() => expect(harness.calls.some((call) => call.method === "buttons")).toBe(true));
      await harness.controller.handleCallbackQuery({
        id: `cb-${action}`,
        data: `tgplus:tui:${action}`,
        message: { message_id: 1, chat: { id: 42, type: "private" } },
        from: { id: 7 },
      });

      expect(key).toHaveBeenCalledWith(action);
    },
  );

  it("refreshes without injecting a key and removes buttons when focus returns to the editor", async () => {
    const key = vi.fn(() => true);
    const interactive = { text: "Settings\n> Theme", interactive: true, host: "pi" as const, width: 100 };
    const closed = { text: "Editor", interactive: false, host: "pi" as const, width: 100 };
    const snapshot = vi.fn()
      .mockReturnValueOnce(interactive)
      .mockReturnValueOnce(interactive)
      .mockReturnValueOnce(interactive)
      .mockReturnValueOnce(closed);
    const harness = createHarness({
      bridge: createBridge({ snapshot, key }),
      config: { tuiBridge: "full", bashConfirm: "dangerous", activeChatId: 42 },
    });

    await harness.controller.handleMessage({
      message_id: 45,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "/settings",
    });
    await vi.waitFor(() => expect(harness.calls.some((call) => call.method === "buttons")).toBe(true));
    await harness.controller.handleCallbackQuery({
      id: "cb-refresh",
      data: "tgplus:tui:refresh",
      message: { message_id: 1, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });
    expect(key).not.toHaveBeenCalled();

    await harness.controller.handleCallbackQuery({
      id: "cb-esc-close",
      data: "tgplus:tui:esc",
      message: { message_id: 1, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });
    expect(key).toHaveBeenCalledWith("esc");
    expect(harness.calls.some((call) => call.method === "removeKeyboard" && call.messageId === 1)).toBe(true);
  });

  it("cancels pending text input and closes the mirror keyboard", async () => {
    const write = vi.fn(() => true);
    const bridge = createBridge({
      snapshot: vi.fn(() => ({ text: "Settings\n> Theme", interactive: true, host: "pi" as const, width: 100 })),
      write,
    });
    const harness = createHarness({
      bridge,
      config: { tuiBridge: "full", bashConfirm: "dangerous", activeChatId: 42 },
    });

    await harness.controller.handleMessage({
      message_id: 50,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "/settings",
    });
    await vi.waitFor(() => expect(harness.calls.some((call) => call.method === "buttons")).toBe(true));
    await harness.controller.handleCallbackQuery({
      id: "cb-type-cancel",
      data: "tgplus:tui:type",
      message: { message_id: 1, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });
    await harness.controller.handleCallbackQuery({
      id: "cb-cancel-type",
      data: "tgplus:tui:cancel-type",
      message: { message_id: 1, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });
    await harness.controller.handleCallbackQuery({
      id: "cb-close",
      data: "tgplus:tui:close",
      message: { message_id: 1, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });

    expect(write).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.method === "removeKeyboard" && call.messageId === 1)).toBe(true);
  });

});

describe("Host capability routing", () => {
  const ompLikeSession = () => createSession({
    modelRegistry: { authStorage: { listProviders: () => [] } },
  });
  const piLikeSession = () => createSession({
    modelRuntime: {
      getProviders: () => [],
      login: async () => undefined,
      logout: async () => undefined,
    },
  });

  const send = async (harness: { controller: { handleMessage(m: unknown): Promise<void> } }, text: string) => {
    await harness.controller.handleMessage({
      message_id: 30,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text,
    });
  };

  it("routes /login to the host TUI when the native auth API is missing", async () => {
    const submit = vi.fn(() => true);
    const login = vi.fn();
    const harness = createHarness({
      session: ompLikeSession(),
      bridge: createBridge({
        submit,
        getCommands: async () => [{ name: "login", description: "Log in", source: "builtin" as const }],
      }),
      telegramCommands: new Map([["login", login]]),
    });

    await send(harness, "/login");

    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("/login"));
    expect(login).not.toHaveBeenCalled();
  });

  it("refuses /login with an actionable notice when the host TUI cannot serve it either", async () => {
    const login = vi.fn();
    const harness = createHarness({
      session: ompLikeSession(),
      bridge: createBridge({ getCommands: async () => [] }),
      config: { tuiBridge: "commands", bashConfirm: "dangerous", activeChatId: 42 },
      telegramCommands: new Map([["login", login]]),
    });

    await send(harness, "/login");

    expect(login).not.toHaveBeenCalled();
    expect(harness.calls.some((call) => call.text?.includes("does not expose a programmatic auth API"))).toBe(true);
  });

  it("runs the native login handler when ModelRuntime auth exists", async () => {
    const login = vi.fn(async () => undefined);
    const harness = createHarness({
      session: piLikeSession(),
      telegramCommands: new Map([["login", login]]),
    });

    await send(harness, "/login");

    await vi.waitFor(() => expect(login).toHaveBeenCalled());
  });

  it("routes /fork to the host TUI on OMP-like hosts", async () => {
    const submit = vi.fn(() => true);
    const fork = vi.fn();
    const harness = createHarness({
      session: ompLikeSession(),
      bridge: createBridge({
        submit,
        getCommands: async () => [{ name: "fork", description: "Fork", source: "builtin" as const }],
      }),
      isOmpHost: () => true,
      telegramCommands: new Map([["fork", fork]]),
    });

    await send(harness, "/fork");

    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("/fork"));
    expect(fork).not.toHaveBeenCalled();
  });

  it("runs the native fork handler on pi-like hosts", async () => {
    const fork = vi.fn(async () => undefined);
    const harness = createHarness({
      session: piLikeSession(),
      isOmpHost: () => false,
      telegramCommands: new Map([["fork", fork]]),
    });

    await send(harness, "/fork");

    await vi.waitFor(() => expect(fork).toHaveBeenCalled());
  });
});
