import { describe, expect, it, vi } from "vitest";
import { clipScreen, createTelegramController } from "../controller.ts";
import type { CapturedAgentSession, TelegramTransport } from "../types.ts";
import { hostOwnsPrompts, type TuiBridgeAdapter } from "../tui-bridge.ts";

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
  config?: { bashConfirm?: "always" | "dangerous" | "never"; activeChatId?: number };
  confirmResult?: boolean;
  telegramCommands?: Map<string, any>;
  confirm?: ReturnType<typeof vi.fn>;
  isOmpHost?: () => boolean;
  /** Mirror the plugin UI's `notify` into the recorded Bot API calls, as the real runtime does. */
  notifySendsToChat?: boolean;
} = {}) {
  const calls: Call[] = [];
  const transport = createTransport(calls);
  const session = options.session ?? createSession();
  const bridge = options.bridge ?? createBridge();
  const confirm = options.confirm ?? vi.fn(async () => options.confirmResult ?? true);
  const config = options.config ?? { bashConfirm: "dangerous", activeChatId: 42 };
  const controller = createTelegramController({
    getSession: () => session,
    transport,
    ui: {
      create: () => ({
        notify: async (message: string) => {
          if (options.notifySendsToChat) calls.push({ method: "text", text: String(message) });
        },
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
      config: { bashConfirm: "always", activeChatId: 42 },
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
      config: { bashConfirm: "never", activeChatId: 42 },
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

describe("Mirror text fitting", () => {
  it("collapses the host's blank padding before the byte budget", () => {
    const screen = ["header https://auth.example/start", "", "", "", "", "footer legend"].join("\n");
    expect(clipScreen(screen, 3000)).toBe("header https://auth.example/start\n\nfooter legend");
  });

  it("keeps both ends and elides the middle of a long screen", () => {
    const screen = Array.from({ length: 80 }, (_, i) => `row ${i} ${"█".repeat(90)}`).join("\n");
    const clipped = clipScreen(screen, 3000);
    expect(Buffer.byteLength(clipped, "utf8")).toBeLessThanOrEqual(3000);
    expect(clipped.split("\n")[0]).toContain("row 0 ");
    expect(clipped.trimEnd().split("\n").at(-1)).toContain("row 79");
    expect(clipped).toContain("\n…\n");
  });

});

describe("Host capability routing", () => {
  const piLikeSession = () => createSession({
    modelRuntime: {
      getProviders: () => [],
      login: async () => undefined,
      logout: async () => undefined,
    },
  });

  it("hands prompts to the host whenever the bridge serves them", () => {
    const adapter = (host: string, available = true) => ({ isAvailable: () => available, getHost: () => host });
    const asBridge = (value: unknown) => value as unknown as TuiBridgeAdapter; // only the two probed members matter
    // Both hosts: a dialog is recognised from the entry the host asked about, and
    // read from the frame it draws, whatever its fields look like (§4.6.5).
    expect(hostOwnsPrompts(asBridge(adapter("pi")))).toBe(true);
    expect(hostOwnsPrompts(asBridge(adapter("omp")))).toBe(true);
    expect(hostOwnsPrompts(asBridge(adapter("pi", false)))).toBe(false);
  });

  it("still reports to the chat for a command that only notifies while the host owns prompts", async () => {
    // /copy (and the other terminal-only mappings) answer with a single notify and
    // no dialog. With the host owning prompts the command context used to carry the
    // host's raw ui, whose notify only prints in the terminal - so the remote user
    // got nothing at all and the command looked like a hang.
    const terminalPrints: string[] = [];
    const hostUi = {
      notify: vi.fn(async (message: string) => { terminalPrints.push(message); }),
      select: vi.fn(async () => "host_choice"),
    };
    const session = createSession({
      extensionRunner: {
        getUIContext: () => hostUi,
        setUIContext: () => undefined,
        getCommand: () => undefined,
        createCommandContext: () => ({
          isIdle: () => true,
          waitForIdle: async () => undefined,
          ui: hostUi,
        }),
      },
    });
    const harness = createHarness({
      session,
      bridge: createBridge(),
      config: { bashConfirm: "dangerous", activeChatId: 42 },
      notifySendsToChat: true,
      telegramCommands: new Map<string, any>([
        ["copy", async (_args: string, ctx: any) => {
          await ctx.ui.notify("Changelog: https://example.test/releases", "info");
        }],
      ]),
    });

    await send(harness, "/copy");

    await vi.waitFor(() => {
      expect(harness.calls.some((call) => call.text?.includes("Changelog: https://example.test"))).toBe(true);
    });
    // The terminal user still sees the notification the host printed.
    expect(terminalPrints).toContain("Changelog: https://example.test/releases");
  });

  const send = async (harness: { controller: { handleMessage(m: unknown): Promise<void> } }, text: string) => {
    await harness.controller.handleMessage({
      message_id: 30,
      chat: { id: 42, type: "private" },
      from: { id: 7 },
      text,
    });
  };

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
