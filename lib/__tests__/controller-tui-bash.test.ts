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

  it("truncates an oversized screen snapshot to its bottom so the mirror stays one message", async () => {
    const bigScreen = Array.from({ length: 80 }, (_, i) => `row ${i} ${"█".repeat(90)}`).join("\n");
    const harness = createHarness({
      bridge: createBridge({
        snapshot: vi.fn(() => ({ text: bigScreen, interactive: false, host: "pi" as const, width: 100 })),
      }),
    });
    await harness.controller.handleMessage({
      message_id: 22,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "/settings",
    });

    await vi.waitFor(() => {
      const edit = harness.calls.find((call) => call.messageId !== undefined && call.text?.includes("<pre>"));
      expect(edit).toBeDefined();
    }, { timeout: 6000 });
    const edit = harness.calls.find((call) => call.messageId !== undefined && call.text?.includes("<pre>"))!;
    expect(Buffer.byteLength(edit.text!, "utf8")).toBeLessThanOrEqual(3600);
    expect(edit.text).toContain("…");
    expect(edit.text).toContain("row 79");
    expect(edit.text).not.toContain("row 0 ");
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

  it("mirrors /login from the host TUI in full mode even when native auth exists", async () => {
    const submit = vi.fn(() => true);
    const login = vi.fn();
    const harness = createHarness({
      session: piLikeSession(),
      bridge: createBridge({
        submit,
        getCommands: async () => [{ name: "login", description: "Log in", source: "builtin" as const }],
      }),
      config: { tuiBridge: "full", bashConfirm: "dangerous", activeChatId: 42 },
      telegramCommands: new Map([["login", login]]),
    });

    await send(harness, "/login");

    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("/login"));
    expect(login).not.toHaveBeenCalled();
  });

  it("keeps the native /login handler outside full mode", async () => {
    const submit = vi.fn(() => true);
    const login = vi.fn(async () => undefined);
    const harness = createHarness({
      session: piLikeSession(),
      bridge: createBridge({
        submit,
        getCommands: async () => [{ name: "login", description: "Log in", source: "builtin" as const }],
      }),
      telegramCommands: new Map([["login", login]]),
    });

    await send(harness, "/login");

    await vi.waitFor(() => expect(login).toHaveBeenCalled());
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps the native /login handler when the host catalog lacks the command", async () => {
    const submit = vi.fn(() => true);
    const login = vi.fn(async () => undefined);
    const harness = createHarness({
      session: piLikeSession(),
      bridge: createBridge({ submit, getCommands: async () => [] }),
      config: { tuiBridge: "full", bashConfirm: "dangerous", activeChatId: 42 },
      telegramCommands: new Map([["login", login]]),
    });

    await send(harness, "/login");

    await vi.waitFor(() => expect(login).toHaveBeenCalled());
    expect(submit).not.toHaveBeenCalled();
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

  it("lets the host render prompts and mirrors them in full mode", async () => {
    const selectorScreen = [
      "╭─ Pick one ──────────────────────╮",
      "│ ❯ alpha                        │",
      "│   beta                         │",
      "╰────────────────────────────────╯",
    ].join("\n");
    const hostSelect = vi.fn(async () => "alpha");
    const hostUi = { select: hostSelect, notify: vi.fn(), confirm: vi.fn(), input: vi.fn() };
    let routedUi: { select: (title: string, options: string[]) => Promise<string | undefined> } | undefined;
    const session = createSession({
      extensionRunner: {
        getUIContext: () => hostUi,
        setUIContext: (ui: unknown) => { routedUi = ui as typeof routedUi; },
        getCommand: () => undefined,
        createCommandContext: () => ({ ui: hostUi }),
      },
      prompt: vi.fn(async () => {
        // A prompt raised by the agent/tool while the Telegram turn runs.
        await routedUi!.select("Pick one", ["alpha", "beta"]);
      }),
    });
    const harness = createHarness({
      session,
      bridge: createBridge({
        snapshot: vi.fn(() => ({ text: selectorScreen, interactive: true, host: "pi" as const, width: 100 })),
      }),
      config: { tuiBridge: "full", bashConfirm: "dangerous", activeChatId: 42 },
    });

    await harness.controller.handleMessage({
      message_id: 50,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "hello",
    });

    await vi.waitFor(() => expect(hostSelect).toHaveBeenCalledWith("Pick one", ["alpha", "beta"]));
    await vi.waitFor(() => {
      const call = harness.calls.find((entry) => entry.method === "buttons");
      expect(call).toBeDefined();
      expect(call!.text).toContain("Pick one");
    });
    const keyboard = [...harness.calls].reverse().find((entry) => entry.method === "buttons")!.rows as Array<Array<{ text: string; value: string }>>;
    expect(keyboard.flat().map((button) => button.text)).toContain("▸ alpha");
  });
});

describe("Selector option buttons and pick routing", () => {
  const loginScreen = [
    " π > ⬢ Mock Model > 🗑 proj ▶────23%╎──────33K─",
    "────────────────────────────────────────────────",
    " Update Available",
    " New version 18.12.6 is available. Run: omp update",
    "────────────────────────────────────────────────",
    "",
    "╭─ Select provider to login ───────────────────────────────────────────────────────────────────────╮",
    "│ ❯ ChatGPT Plus/Pro (Codex Subscription)                                                        █ │",
    "│   Anthropic (Claude Pro/Max)                                                                   │ │",
    "│   Z.AI (GLM Coding Plan)                                                                       │ │",
    "│   Kimi Code                                                                                    │ │",
    "│ Type to search                                                                                   │",
    "╰──────────────────────────────────────────────────────────────────────────────────────────────────╯",
    "telegram+ connected(current)",
  ].join("\n");
  const filteredScreen = [
    "╭─ Select provider to login ───────────────────────────────────────────────────────────────────────╮",
    "│   Cursor (Claude, GPT, etc.)                                                                   │ │",
    "│ ❯ Devin                                                                                        │ │",
    "│   Google Antigravity (Gemini, Claude, GPT-OSS)                                                 │ │",
    "│ Type to search                                                                                   │",
    "╰──────────────────────────────────────────────────────────────────────────────────────────────────╯",
  ].join("\n");

  function harnessWithLiveScreen(initial: string) {
    const state = { screen: initial };
    const keys: string[] = [];
    const bridge = createBridge({
      snapshot: vi.fn(() => ({ text: state.screen, interactive: true, host: "omp" as const, width: 100 })),
      key: vi.fn((name: string) => { keys.push(name); return true; }),
    });
    const harness = createHarness({
      bridge,
      config: { tuiBridge: "full", bashConfirm: "dangerous", activeChatId: 42 },
    });
    return { harness, state, keys };
  }

  const openMirror = async (harness: ReturnType<typeof harnessWithLiveScreen>["harness"]) => {
    await harness.controller.handleMessage({
      message_id: 60,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text: "/settings",
    });
    await vi.waitFor(() => expect(harness.calls.some((call) => call.method === "buttons")).toBe(true));
  };

  const lastKeyboard = (harness: ReturnType<typeof harnessWithLiveScreen>["harness"]) => {
    const call = [...harness.calls].reverse().find((entry) => entry.method === "buttons");
    return (call?.rows as Array<Array<{ text: string; value: string }>>).flat();
  };

  it("shows one button per option in a /model-style message", async () => {
    const { harness } = harnessWithLiveScreen(loginScreen);
    await openMirror(harness);

    const buttons = lastKeyboard(harness).map((button) => button.text);
    expect(buttons).toContain("▸ ChatGPT Plus/Pro (Codex Subscription)");
    expect(buttons).toContain("Anthropic (Claude Pro/Max)");
    expect(buttons).toContain("Kimi Code");
    expect(buttons.some((text) => /search|Update|connected/i.test(text))).toBe(false);
    const values = lastKeyboard(harness).map((button) => button.value);
    expect(values).toContain("tgplus:tui:pick:1");
    expect(values).toContain("tgplus:tui:esc");

    // Same shape as /model's select: title only, no TUI screen dump or hint.
    const mirrorText = [...harness.calls].reverse().find((entry) => entry.method === "buttons")!.text!;
    expect(mirrorText).toBe("<b>Select provider to login</b>");
    expect(mirrorText).not.toContain("Update Available");
    expect(mirrorText).not.toContain("marks the current item");
  });

  it("tapping an option moves the host cursor by the marker distance and confirms", async () => {
    const { harness, keys } = harnessWithLiveScreen(loginScreen);
    await openMirror(harness);

    await harness.controller.handleCallbackQuery({
      id: "cb-pick-1",
      data: "tgplus:tui:pick:1",
      message: { message_id: 1, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });
    expect(keys).toEqual(["down", "enter"]);
  });

  it("tapping the already-selected option only presses Enter", async () => {
    const { harness, keys } = harnessWithLiveScreen(loginScreen);
    await openMirror(harness);

    await harness.controller.handleCallbackQuery({
      id: "cb-pick-0",
      data: "tgplus:tui:pick:0",
      message: { message_id: 1, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });
    expect(keys).toEqual(["enter"]);
  });

  it("taps on a filtered (stale) list notify instead of injecting blind keys", async () => {
    const { harness, state, keys } = harnessWithLiveScreen(loginScreen);
    await openMirror(harness);

    // The list filtered down while the keyboard still shows the old options;
    // the tapped label no longer exists, so no keystrokes may be guessed.
    state.screen = filteredScreen;
    await harness.controller.handleCallbackQuery({
      id: "cb-pick-zai",
      data: "tgplus:tui:pick:3",
      message: { message_id: 1, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });
    expect(keys).toEqual([]);
    expect(harness.calls.some((call) => call.text?.includes("no longer in this list"))).toBe(true);
  });

  it("tapping a still-present option uses the live marker position", async () => {
    const scrolledWithTarget = [
      "╭─ Pick ─────────────────────╮",
      "│   Kimi Code              │",
      "│ ❯ OpenRouter             │",
      "│   GitHub Copilot         │",
      "╰──────────────────────────╯",
    ].join("\n");
    const { harness, state, keys } = harnessWithLiveScreen(loginScreen);
    await openMirror(harness);
    // "Kimi Code" sat at index 3 with the marker at 0; after scrolling it is
    // one step ABOVE the live marker, so the keyboard press must be "up".
    state.screen = scrolledWithTarget;
    await harness.controller.handleCallbackQuery({
      id: "cb-pick-kimi",
      data: "tgplus:tui:pick:3",
      message: { message_id: 1, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });
    expect(keys).toEqual(["up", "enter"]);
  });

  it("refuses blind injection when the current item cannot be located", async () => {
    const noMarkerScreen = [
      "╭─ Pick ─────────────────────╮",
      "│   Kimi Code              │",
      "│   OpenRouter             │",
      "│   GitHub Copilot         │",
      "╰──────────────────────────╯",
    ].join("\n");
    const { harness, state, keys } = harnessWithLiveScreen(loginScreen);
    await openMirror(harness);

    state.screen = noMarkerScreen;
    await harness.controller.handleCallbackQuery({
      id: "cb-pick-nomarker",
      data: "tgplus:tui:pick:2",
      message: { message_id: 1, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });
    expect(keys).toEqual([]);
    expect(harness.calls.some((call) => call.text?.includes("tap an item on the refreshed keyboard"))).toBe(true);
  });

  const PROVIDERS = [
    "ChatGPT Plus/Pro (Codex Subscription)",
    "Anthropic (Claude Pro/Max)",
    "Z.AI (GLM Coding Plan)",
    "Z.AI (GLM Coding Plan · Sign in)",
    "Kimi Code",
    "OpenRouter",
    "GitHub Copilot",
    "Cursor (Claude, GPT, etc.)",
    "Devin",
    "Google Antigravity (Gemini, Claude, GPT-OSS)",
    "Google Cloud Code Assist (Gemini CLI)",
    "ChatGPT Plus/Pro (Codex, headless/device)",
    "xAI API",
    "xAI Grok OAuth (SuperGrok or X Premium+)",
    "GitLab Duo Non-Agentic",
  ];

  // One host window: OMP scrolls the list with the cursor and renders at most
  // ten rows, so a window is a slice of the catalog plus the search footer.
  const windowScreen = (start: number, selected: number, size = 10) => [
    "╭─ Select provider to login ───────────────────────────────────────────╮",
    ...PROVIDERS.slice(start, start + size).map((name, offset) =>
      `│ ${start + offset === selected ? "❯" : " "} ${name.padEnd(60)} │`),
    "│ Type to search                                                      │",
    "╰─────────────────────────────────────────────────────────────────────╯",
  ].join("\n");

  const tapCallback = async (
    harness: ReturnType<typeof harnessWithLiveScreen>["harness"],
    id: string,
    data: string,
  ) => {
    await harness.controller.handleCallbackQuery({
      id,
      data,
      message: { message_id: 1, chat: { id: 42, type: "private" } },
      from: { id: 7 },
    });
  };

  const harnessWithWindows = (windows: string[]) => {
    const cursor = { index: 0 };
    const keys: string[] = [];
    const bridge = createBridge({
      snapshot: vi.fn(() => ({
        text: windows[cursor.index] ?? windows[windows.length - 1],
        interactive: true,
        host: "omp" as const,
        width: 100,
      })),
      key: vi.fn((name: string) => {
        keys.push(name);
        if (name === "pageDown" && cursor.index < windows.length - 1) cursor.index += 1;
        if (name === "pageUp" && cursor.index > 0) cursor.index -= 1;
        return true;
      }),
    });
    const harness = createHarness({
      bridge,
      config: { tuiBridge: "full", bashConfirm: "dangerous", activeChatId: 42 },
    });
    return { harness, keys, cursor };
  };

  it("pages the host window instead of slicing the parsed rows", async () => {
    const { harness, keys, cursor } = harnessWithWindows([
      windowScreen(0, 0),
      windowScreen(5, 10),
    ]);
    await openMirror(harness);

    let texts = lastKeyboard(harness).map((button) => button.text);
    expect(texts).toContain("Next ▶");
    expect(texts).not.toContain("◀ Prev");
    expect(texts.filter((text) => text.startsWith("▸ "))).toEqual(["▸ ChatGPT Plus/Pro (Codex Subscription)"]);
    const mirrorText = [...harness.calls].reverse().find((entry) => entry.method === "buttons")!.text!;
    expect(mirrorText).toBe("<b>Select provider to login</b>");

    await tapCallback(harness, "cb-next", "tgplus:tui:page:next");
    expect(keys).toEqual(["pageDown"]);
    expect(cursor.index).toBe(1);

    texts = lastKeyboard(harness).map((button) => button.text);
    expect(texts).toContain("◀ Prev");
    expect(texts).toContain("GitLab Duo Non-Agentic");
    expect(texts.some((text) => text.startsWith("▸ "))).toBe(true);

    await tapCallback(harness, "cb-prev", "tgplus:tui:page:prev");
    expect(keys).toEqual(["pageDown", "pageUp"]);
    expect(cursor.index).toBe(0);
    expect(lastKeyboard(harness).map((button) => button.text)).not.toContain("◀ Prev");
  });

  it("picks on a paged window use the live cursor distance", async () => {
    const { harness, keys } = harnessWithWindows([
      windowScreen(0, 0),
      windowScreen(5, 10),
    ]);
    await openMirror(harness);
    await tapCallback(harness, "cb-next", "tgplus:tui:page:next");

    // Window two starts at index 5 with the cursor on index 10; tapping the
    // last visible option must press Down four times, then Enter.
    await tapCallback(harness, "cb-pick-last", "tgplus:tui:pick:9");
    expect(keys).toEqual(["pageDown", "down", "down", "down", "down", "enter"]);
  });

  it("hides Next once a forward page stops moving", async () => {
    const { harness, keys } = harnessWithWindows([windowScreen(0, 0)]);
    await openMirror(harness);
    expect(lastKeyboard(harness).map((button) => button.text)).toContain("Next ▶");

    await tapCallback(harness, "cb-next-end", "tgplus:tui:page:next");
    expect(keys).toEqual(["pageDown"]);
    expect(lastKeyboard(harness).map((button) => button.text)).not.toContain("Next ▶");
  });

  it("pages pi's provider window by walking arrow steps", async () => {
    const screen = [
      "─────────────────────────────────────────────────",
      "",
      " Select provider to configure:",
      "",
      ">",
      "",
      " → Amazon Bedrock • unconfigured",
      "   Ant Ling • unconfigured",
      "   Anthropic • unconfigured",
      "   Azure OpenAI • unconfigured",
      "   Cerebras • unconfigured",
      "   Cloudflare AI Gateway • unconfigured",
      "   Cloudflare Workers AI • unconfigured",
      "   DeepSeek • unconfigured",
      "   (1/39)",
      "",
      "─────────────────────────────────────────────────",
    ].join("\n");
    const { harness, keys } = harnessWithLiveScreen(screen);
    await openMirror(harness);

    const texts = lastKeyboard(harness).map((button) => button.text);
    expect(texts).toContain("Next ▶");
    expect(texts).not.toContain("◀ Prev");

    // pi ignores page keys, so Next falls back to a window of arrow steps.
    await tapCallback(harness, "cb-pi-next", "tgplus:tui:page:next");
    expect(keys[0]).toBe("pageDown");
    expect(keys.slice(1)).toEqual(Array(8).fill("down"));
  });

  it("shows pi's complete selector list without a Next row", async () => {
    const options = Array.from({ length: 12 }, (_, index) => `Provider ${index}`);
    const screen = [
      "",
      " Select authentication method:",
      "",
      ...options.map((label, index) => (index === 0 ? ` → ${label}` : `   ${label}`)),
      "",
      " ↑↓ navigate  enter select  escape/ctrl+c cancel",
      "",
    ].join("\n");
    const { harness } = harnessWithLiveScreen(screen);
    await openMirror(harness);

    const texts = lastKeyboard(harness).map((button) => button.text);
    expect(texts).toContain("▸ Provider 0");
    expect(texts).toContain("Provider 11");
    expect(texts).not.toContain("Next ▶");
    const message = [...harness.calls].reverse().find((entry) => entry.method === "buttons")!.text!;
    expect(message).toBe("<b>Select authentication method</b>");
  });

  it("titles non-selector overlays after the dialog and links their URLs", async () => {
    // OAuth wait screens have no options, so the mirror falls back to the
    // screen — but it must carry the dialog title and a tappable link.
    const oauthScreen = [
      "╭─ Login to OpenRouter ──────────────────────────────────────╮",
      "│ https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A54549 │",
      "│ Waiting for browser authentication...                        │",
      "╰──────────────────────────────────────────────────────────────╯",
    ].join("\n");
    const { harness } = harnessWithLiveScreen(oauthScreen);
    await openMirror(harness);

    const call = [...harness.calls].reverse().find((entry) => entry.method === "buttons")!;
    expect(call.text).toContain("<b>Login to OpenRouter</b>");
    expect(call.text).toContain("🔗 https://openrouter.ai/auth");
    expect(call.text).not.toContain("<b>TUI selector</b>");
  });

  it("offers Next on short windows that render the host scrollbar", async () => {
    // A terminal too short for ten rows still overflows: the scrollbar thumb
    // (U+2588) is the only "more rows follow" signal left.
    const shortWindow = [
      "╭─ Select provider to login ─────────────────────────────╮",
      ...PROVIDERS.slice(0, 5).map((name, index) =>
        `│ ${index === 0 ? "❯" : " "} ${name.padEnd(50)} ${index === 0 ? "█" : "│"} │`),
      "│ Type to search                                        │",
      "╰───────────────────────────────────────────────────────╯",
    ].join("\n");
    const { harness } = harnessWithWindows([shortWindow]);
    await openMirror(harness);
    expect(lastKeyboard(harness).map((button) => button.text)).toContain("Next ▶");
  });
});
