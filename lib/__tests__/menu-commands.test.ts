import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { createTelegramController } from "../controller.ts";
import {
  buildTelegramMenuCommands,
  buildTelegramMenuCommandsFull,
  getTelegramMenuOverflow,
  scheduleTelegramCommandRefresh,
  syncTelegramCommands,
} from "../menu-commands.ts";

const hostCommand = (name: string, description: string): SlashCommandInfo => ({
  name,
  description,
  source: "extension",
  sourceInfo: { path: `/test/${name}.ts`, source: "test", scope: "user", origin: "top-level" },
});

describe("Telegram command menu", () => {
    it("exposes /tg as the consolidated management menu command", () => {
        const commands = buildTelegramMenuCommands({
            getCommands: () => [],
        } as any);

        expect(commands).toContainEqual({
            command: "tg",
            description: "Open the Telegram management menu",
        });
    });

    it("excludes flat /tg-* commands from the bot menu", () => {
        const commands = buildTelegramMenuCommands({
            getCommands: () => [
                { name: "tg-bot-add", description: "Add" },
                { name: "tg-bot-list", description: "List" },
                { name: "tg-bot-update", description: "Update" },
                { name: "tg-bot-remove", description: "Remove" },
                { name: "tg-bot-default", description: "Default" },
                { name: "tg-switch", description: "Switch" },
                { name: "tg-bind-cwd", description: "Bind" },
                { name: "tg-unbind-cwd", description: "Unbind" },
                { name: "tg-cwd-connect", description: "Connect" },
                { name: "tg-cwd-disconnect", description: "Disconnect" },
            ],
        } as any);

        const names = commands.map((c) => c.command);
        expect(names).not.toContain("tg_bot_add");
        expect(names).not.toContain("tg_bot_list");
        expect(names).not.toContain("tg_bot_update");
        expect(names).not.toContain("tg_bot_remove");
        expect(names).not.toContain("tg_bot_default");
        expect(names).not.toContain("tg_switch");
        expect(names).not.toContain("tg_bind_cwd");
        expect(names).not.toContain("tg_unbind_cwd");
        expect(names).not.toContain("tg_cwd_connect");
        expect(names).not.toContain("tg_cwd_disconnect");
        // But /tg IS included
        expect(names).toContain("tg");
    });

    it("routes the Telegram menu command to the tg-switch handler", async () => {
        const handler = vi.fn(async () => undefined);
        const telegramCommands = new Map([["tg-switch", handler]]);
        let currentUi: unknown;
        const session = {
            extensionRunner: {
                getUIContext: () => currentUi,
                setUIContext: (ui: unknown) => { currentUi = ui; },
                getCommand: () => undefined,
                createCommandContext: () => ({}),
            },
        } as any;
        const controller = createTelegramController({
            getSession: () => session,
            transport: {} as any,
            ui: {
                create: () => ({}) as any,
                resolveInput: () => ({ handled: false }),
                isSensitiveInput: () => false,
                hasPendingInput: () => false,
                dispose: () => undefined,
            },
            authorizeUser: async () => true,
            setActiveChatId: async () => undefined,
            getBotUsername: () => "test_bot",
            telegramCommands,
            getActiveTurn: () => undefined,
            beginTelegramTurn: () => undefined,
            endTelegramTurn: () => undefined,
        });

        await controller.handleMessage({
            message_id: 1,
            chat: { id: 42 },
            from: { id: 7 },
            text: "/tg_switch current",
        });

        await vi.waitFor(() => {
            expect(handler).toHaveBeenCalledWith("current", expect.anything());
        });
    });
});

describe("dynamic TUI catalog in BotMenu", () => {
  it("merges host builtins that are absent from the static list", () => {
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [] },
      {
        tuiCommands: [
          { name: "tools", description: "Manage tools", source: "builtin" },
          { name: "theme", description: "Change theme", source: "builtin" },
        ],
      },
    );
    expect(commands).toContainEqual({ command: "tools", description: "Manage tools" });
    expect(commands).toContainEqual({ command: "theme", description: "Change theme" });
  });

  it("reserves the last menu slot for /more when the catalog exceeds 100", () => {
    const tuiCommands = Array.from({ length: 140 }, (_, index) => ({
      name: `cmd_${index}`,
      description: `Command ${index}`,
      source: "builtin" as const,
    }));
    const { commands, overflow } = buildTelegramMenuCommandsFull({ getCommands: () => [] }, { tuiCommands });
    expect(commands).toHaveLength(100);
    expect(commands[99]).toEqual({ command: "more", description: "Show more commands" });
    expect(overflow.length).toBeGreaterThan(0);
    expect(overflow.some((c) => c.command === "more")).toBe(false);
  });

  it("has no /more entry or overflow when the catalog fits", () => {
    const { commands, overflow } = buildTelegramMenuCommandsFull({ getCommands: () => [] }, {});
    expect(commands.some((c) => c.command === "more")).toBe(false);
    expect(overflow).toHaveLength(0);
  });

  it("omits the thinking entry when the host has no native thinking command", () => {
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [hostCommand("model", "Change model")] },
      { tuiCommands: [{ name: "tools", description: "Manage tools", source: "builtin" }] },
    );
    expect(commands.some((c) => c.command === "thinking")).toBe(false);
    expect(commands.some((c) => c.command === "tg_thinking")).toBe(false);
  });

  it("keeps native thinking in the menu when the host provides it", () => {
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [hostCommand("thinking", "Change thinking level")] },
    );
    expect(commands.some((c) => c.command === "thinking")).toBe(true);
    expect(commands.some((c) => c.command === "tg_thinking")).toBe(false);
  });

  it("drops static entries the captured host catalog does not serve", () => {
    const ompCommand = (name: string) => ({ name, description: `omp ${name}`, source: "builtin" as const });
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [] },
      {
        tuiCommands: [
          ompCommand("settings"), ompCommand("model"), ompCommand("session"),
          ompCommand("fork"), ompCommand("compact"), ompCommand("export"),
        ],
      },
    );
    const names = new Set(commands.map((c) => c.command));
    expect(names.has("clone")).toBe(false);
    expect(names.has("import")).toBe(false);
    expect(names.has("name")).toBe(false);
    expect(names.has("reload")).toBe(false);
    expect(names.has("settings")).toBe(true);
    expect(names.has("model")).toBe(true);
    // scoped-models has no TUI on OMP: it is not menu-visible there either.
    expect(names.has("scoped_models")).toBe(false);
  });

  it("keeps plugin-served commands even when the host catalog lacks them", () => {
    const commands = buildTelegramMenuCommands(
      { getCommands: () => [] },
      { tuiCommands: [{ name: "settings", description: "Open settings", source: "builtin" }] },
    );
    const names = new Set(commands.map((c) => c.command));
    expect(names.has("tg")).toBe(true);
    expect(names.has("cwd")).toBe(true);
    expect(names.has("status")).toBe(true);
  });

  it("keeps the curated static list when no host catalog was captured", () => {
    const commands = buildTelegramMenuCommands({ getCommands: () => [] }, {});
    const names = new Set(commands.map((c) => c.command));
    expect(names.has("clone")).toBe(true);
    expect(names.has("reload")).toBe(true);
  });
});

describe("dynamic command ordering", () => {
  it("boosts recently used non-core commands ahead of other dynamic commands", () => {
    const commands = buildTelegramMenuCommands(
      {
        getCommands: () => [
          { name: "alpha", description: "Alpha" },
          { name: "middle", description: "Middle" },
          { name: "zulu", description: "Zulu" },
        ],
      } as any,
      { recent: ["middle"] },
    );
    const names = commands.map((command) => command.command);
    expect(names.indexOf("middle")).toBeLessThan(names.indexOf("alpha"));
  });
});

describe("Telegram menu refresh scheduling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("isolates in-flight sync by token and API base", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const pi = { getCommands: () => [] } as any;

    await Promise.all([
      syncTelegramCommands("token-a", pi, "https://api-a.example"),
      syncTelegramCommands("token-b", pi, "https://api-b.example"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      expect.stringContaining("api-a.example"),
      expect.stringContaining("api-b.example"),
    ]));
  });

  it("keeps the 300ms and 1000ms refreshes independently scheduled", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const pi = { getCommands: () => [] } as any;

    scheduleTelegramCommandRefresh("token-dual-delay", pi, "https://api.example", 300);
    scheduleTelegramCommandRefresh("token-dual-delay", pi, "https://api.example", 1000);
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(700);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe("/more overflow keyboard", () => {
  const overflowPi = {
    getCommands: () => Array.from({ length: 140 }, (_, index) => ({
      name: `cmd_${index}`,
      description: `Command ${index}`,
      source: "extension" as const,
    })),
  } as any;

  it("sends the overflow keyboard on /more and dispatches run callbacks", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await syncTelegramCommands("token-more-flow", overflowPi, "https://api.example");
    } finally {
      vi.unstubAllGlobals();
    }
    const overflow = getTelegramMenuOverflow("token-more-flow", "https://api.example");
    expect(overflow.length).toBeGreaterThan(0);

    const handler = vi.fn(async () => undefined);
    const telegramCommands = new Map<string, any>();
    const transport = {
      sendButtons: vi.fn(async () => ({ message_id: 5 })),
      editButtons: vi.fn(async () => undefined),
      sendText: vi.fn(async () => [{ message_id: 6 }]),
      answerCallbackQuery: vi.fn(async () => undefined),
    };
    let currentUi: unknown = {};
    const session = {
      extensionRunner: {
        getUIContext: () => currentUi,
        setUIContext: (ui: unknown) => { currentUi = ui; },
        getCommand: () => undefined,
        createCommandContext: () => ({}),
      },
    } as any;
    const controller = createTelegramController({
      getSession: () => session,
      transport: transport as any,
      ui: {
        create: () => ({}) as any,
        resolveInput: () => ({ handled: false }),
        isSensitiveInput: () => false,
        hasPendingInput: () => false,
        dispose: () => undefined,
      },
      authorizeUser: async () => true,
      setActiveChatId: async () => undefined,
      getBotUsername: () => "test_bot",
      telegramCommands,
      getActiveTurn: () => undefined,
      beginTelegramTurn: () => undefined,
      endTelegramTurn: () => undefined,
      getConfig: () => ({ botToken: "token-more-flow", apiBase: "https://api.example" }) as any,
    });

    await controller.handleMessage({ message_id: 1, chat: { id: 42 }, from: { id: 7 }, text: "/more" });
    expect(transport.sendButtons).toHaveBeenCalledTimes(1);
    const rows = (transport.sendButtons.mock.calls[0] as unknown as unknown[])[2] as Array<Array<{ text: string; value: string }>>;
    const commandButtons = rows.flat().filter((button) => button.value.startsWith("tgplus:run:"));
    expect(commandButtons.length).toBe(Math.min(30, overflow.length));
    const target = commandButtons[0]!;
    const runName = target.value.slice("tgplus:run:".length);
    expect(target.text).toBe(`/${runName}`);

    telegramCommands.set(runName, handler);
    await controller.handleCallbackQuery({
      id: "q1",
      from: { id: 7 },
      message: { chat: { id: 42 }, message_id: 5 },
      data: target.value,
    } as any);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
  });
});
