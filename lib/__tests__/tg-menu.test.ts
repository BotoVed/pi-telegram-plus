import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock telegram-api to avoid real network calls.
const mocks = vi.hoisted(() => ({
  getTelegramBotUsername: vi.fn(),
}));

vi.mock("../telegram-api.ts", () => ({
  getTelegramBotUsername: mocks.getTelegramBotUsername,
}));

// Deterministic pairing codes for the regenerate/unpair assertions.
const pairingMocks = vi.hoisted(() => ({ createTelegramPairingCode: vi.fn() }));
vi.mock("../pairing.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof pairingModule>();
  return { ...actual, createTelegramPairingCode: pairingMocks.createTelegramPairingCode };
});

import { registerTgMenuCommand, type SwitchInstanceDeps } from "../commands/tg-menu.ts";
import type { TelegramCommandDeps, TelegramConnectionState } from "../commands/telegram-commands.ts";
import type { TgConfigDeps } from "../commands/register.ts";
import { readBotRegistry, readProjectBinding, addBot, writeProjectBinding, clearDefaultBot } from "../config.ts";
import type { BotRecord, ResolvedTelegramConfig, TelegramConfig } from "../types.ts";
import type * as pairingModule from "../pairing.ts";

function makeBot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? "test-bot",
    token: overrides.token ?? "tok-1",
    ...(overrides.botUsername === undefined ? {} : { botUsername: overrides.botUsername }),
    ...(overrides.allowedUserId === undefined ? {} : { allowedUserId: overrides.allowedUserId }),
    ...(overrides.pairingCode === undefined ? {} : { pairingCode: overrides.pairingCode }),
  };
}

/** Choice label for bot-list / picker menus (matches formatBotLabel in tg-menu.ts). */
function botChoiceFull(bot: BotRecord, isDefault: boolean): string {
  const marker = isDefault ? " ⭐ 默认" : "";
  const username = bot.botUsername ? `@${bot.botUsername}` : "无用户名";
  const paired = bot.allowedUserId !== undefined ? "已配对" : "未配对";
  return `${bot.name}${marker} · ${username} · ${paired}`;
}

/** Scripted mock UI: returns values from the script in order, one per call. */
function makeScriptedUi(script: {
  select?: string[];
  input?: string[];
  inputSecret?: string[];
  confirm?: boolean[];
}) {
  let selectIdx = 0;
  let inputIdx = 0;
  let inputSecretIdx = 0;
  let confirmIdx = 0;
  const notifyCalls: { message: string; level: string }[] = [];

  const ui = {
    notify: vi.fn((message: string, level = "info") => { notifyCalls.push({ message, level }); }),
    select: vi.fn(async (_title: string, _options: string[]) => {
      return script.select?.[selectIdx++] ?? undefined;
    }),
    input: vi.fn(async (_title: string, _placeholder?: string) => {
      return script.input?.[inputIdx++] ?? undefined;
    }),
    inputSecret: vi.fn(async (_title: string, _placeholder?: string) => {
      return script.inputSecret?.[inputSecretIdx++] ?? undefined;
    }),
    confirm: vi.fn(async (_title: string, _message?: string) => {
      return script.confirm?.[confirmIdx++] ?? false;
    }),
  };
  return { ui, notifyCalls };
}

describe("/tg multi-level menu", () => {
  let agentDir: string;
  let projectDir: string;
  let originalAgentDir: string | undefined;
  let commands: Map<string, (args: string, ctx: any) => Promise<void>>;
  let config: TelegramConfig;
  let resolvedConfig: ResolvedTelegramConfig | undefined;
  let pollingActive: boolean;
  let connectionStateValue: TelegramConnectionState;
  let awaitReconcileCalls: number;

  beforeEach(async () => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = await mkdtemp(join(tmpdir(), "ptp-menu-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    projectDir = await mkdtemp(join(tmpdir(), "ptp-menu-proj-"));

    commands = new Map();
    config = {};
    resolvedConfig = undefined;
    pollingActive = false;
    mocks.getTelegramBotUsername.mockReset();
    mocks.getTelegramBotUsername.mockResolvedValue("testbot");
    pairingMocks.createTelegramPairingCode.mockReset().mockReturnValue("654321");

    connectionStateValue = "disconnected";
    awaitReconcileCalls = 0;

    const deps: TelegramCommandDeps = {
      getConfig: () => config,
      setConfig: (c) => { config = c; },
      persistConfig: async (c) => { config = c; },
      getResolvedConfig: () => resolvedConfig,
      switchResolvedConfig: (next) => {
        resolvedConfig = next;
        config = next.config;
      },
      isTelegramEnabled: () => config.telegramEnabled === true,
      transport: {} as any,
      getPolling: () => ({
        start: () => { pollingActive = true; },
        stop: async () => { pollingActive = false; },
        isActive: () => pollingActive,
      }),
      refreshStatus: () => undefined,
      syncTelegramCommands: async () => undefined,
      startStatusHeartbeat: () => undefined,
      clearStatusError: () => undefined,
      connectionState: () => connectionStateValue,
      awaitReconcile: async () => { awaitReconcileCalls += 1; },
    };

    const configDeps: TgConfigDeps = {
      getSession: () => undefined,
      getConfig: () => config,
      setConfig: (c) => { config = c; },
      persistConfig: async (c) => { config = c; },
    };

    const switchDeps: SwitchInstanceDeps = {
      getCoordinator: () => undefined,
      getCurrentChatId: () => undefined,
      stopPolling: async () => { pollingActive = false; },
      startPolling: () => { pollingActive = true; },
      requestReconcile: () => undefined,
      getCurrentTurn: () => undefined,
      pendingHandoffs: new Set<string>(),
    };

    registerTgMenuCommand(
      {
        registerCommand: (name, options) => {
          commands.set(name, options.handler);
        },
      },
      deps,
      configDeps,
      switchDeps,
    );
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  const makeCtx = (ui: any, cwd?: string) => ({
    cwd: cwd ?? projectDir,
    ui,
  });

  it("registers /tg command", () => {
    expect([...commands.keys()]).toContain("tg");
  });

  it("Close exits the menu immediately", async () => {
    const { ui } = makeScriptedUi({ select: ["❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(1);
  });

  it("select=undefined exits the menu", async () => {
    const { ui } = makeScriptedUi({ select: [] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(1);
  });

  it("Bots → Bot 列表 → shows bots as selectable options", async () => {
    const bot = makeBot({ name: "alpha", token: "t1", botUsername: "alphabot" });
    await addBot(bot);
    const { ui } = makeScriptedUi({ select: ["🤖 Bots", "Bot 列表", "⬅️ Back", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    const botListCall = ui.select.mock.calls[2]; // 3rd select = Bot 列表 (after main + Bots submenu)
    expect(botListCall[1]).toContain(botChoiceFull(bot, true));
  });

  it("Bots → Add bot → adds bot to registry", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "➕ 添加 Bot", "⬅️ Back", "❌ Close"],
      input: ["my-menu-bot"],
      inputSecret: ["token-from-menu"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(1);
    expect(registry.bots[0].name).toBe("my-menu-bot");
    expect(registry.bots[0].token).toBe("token-from-menu");
    expect(notifyCalls.some((c) => c.message.includes("Bot added"))).toBe(true);
  });

  it("Bots → 全局默认 Bot → pick bot sets the global default", async () => {
    const bot1 = makeBot({ name: "a" });
    const bot2 = makeBot({ name: "b" });
    await addBot(bot1);
    await addBot(bot2);
    // bot1 is the default (first added). bot2 is not default.
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "⭐ 全局默认 Bot：a", botChoiceFull(bot2, false), "⬅️ Back", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const registry = await readBotRegistry();
    expect(registry.defaultBotId).toBe(bot2.id);
    expect(notifyCalls.some((c) => c.message.includes("Default bot set to"))).toBe(true);
  });

  it("清除默认 on an unbound project clears globally, warns, refreshes routing and closes the menu", async () => {
    const bot = makeBot({ name: "solo" });
    await addBot(bot); // becomes default
    config = { botToken: bot.token };
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "⭐ 全局默认 Bot：solo", "清除默认"],
    });
    const closeMenu = vi.fn(async () => undefined);
    await commands.get("tg")!("", makeCtx({ ...ui, closeMenu }));
    const registry = await readBotRegistry();
    expect(registry.defaultBotId).toBeUndefined();
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(ui.select).toHaveBeenCalledTimes(3); // menu exited right after clearing
    expect(closeMenu).toHaveBeenCalled();
    expect(notifyCalls.some((c) => c.message.includes("Default bot cleared"))).toBe(true);
    expect(notifyCalls.some((c) => c.message.includes("/tg → Project → 绑定 Bot"))).toBe(true);
    expect(config.botToken).toBeUndefined(); // runtime re-resolved immediately
  });

  it("清除默认 on a bound project clears globally and stays in the menu", async () => {
    const bot = makeBot({ name: "solo" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true });
    config = { botToken: bot.token };
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "⭐ 全局默认 Bot：solo", "清除默认", "⬅️ Back", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect((await readBotRegistry()).defaultBotId).toBeUndefined();
    expect(ui.confirm).not.toHaveBeenCalled();
    // picker re-rendered without 清除默认 (no default any more)
    expect(ui.select.mock.calls[3][1]).toEqual([botChoiceFull(bot, false), "⬅️ Back"]);
    expect(config.botToken).toBe(bot.token); // binding still routes this project
  });

  it("setting another default on an unbound project switches bots → notifies and closes the menu", async () => {
    const bot1 = makeBot({ name: "a", token: "tok-a" });
    const bot2 = makeBot({ name: "b", token: "tok-b", botUsername: "b_bot" });
    await addBot(bot1);
    await addBot(bot2);
    config = { botToken: bot1.token };
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "⭐ 全局默认 Bot：a", botChoiceFull(bot2, false)],
    });
    const closeMenu = vi.fn(async () => undefined);
    await commands.get("tg")!("", makeCtx({ ...ui, closeMenu }));
    expect((await readBotRegistry()).defaultBotId).toBe(bot2.id);
    expect(ui.select).toHaveBeenCalledTimes(3);
    expect(closeMenu).toHaveBeenCalled();
    expect(notifyCalls.some((c) => c.message.includes("switches to @b_bot"))).toBe(true);
    expect(config.botToken).toBe("tok-b"); // runtime switched immediately
  });

  it("navigates with ui.menu when available and closes the menu on exit", async () => {
    const { ui } = makeScriptedUi({});
    const picks = ["🤖 Bots", "⬅️ Back", "⚙️ Config", "⬅️ Back", "❌ Close"];
    let i = 0;
    const menu = vi.fn(async (_title: string, _options: string[]) => picks[i++]);
    const closeMenu = vi.fn(async () => undefined);
    await commands.get("tg")!("", makeCtx({ ...ui, menu, closeMenu }));
    expect(menu.mock.calls.map((c) => c[0])).toEqual([
      "Telegram Management", "🤖 Bots", "Telegram Management", "⚙️ Telegram Config", "Telegram Management",
    ]);
    expect(ui.select).not.toHaveBeenCalled();
    expect(closeMenu).toHaveBeenCalledTimes(1);
  });

  it("Bots → Bot 列表 → bot → 删除 → confirms and removes", async () => {
    const bot = makeBot({ name: "toremove" });
    await addBot(bot);
    const botChoice = botChoiceFull(bot, true);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "Bot 列表", botChoice, "删除", "⬅️ Back", "❌ Close"],
      confirm: [true],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(0);
    expect(notifyCalls.some((c) => c.message.includes("Bot removed"))).toBe(true);
  });

  it("Bots → Bot 列表 → bot → 删除 → cancel confirm does not remove and stays on the bot", async () => {
    const bot = makeBot({ name: "keep" });
    await addBot(bot);
    const botChoice = botChoiceFull(bot, true);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Bot 列表", botChoice, "删除", "⬅️ Back", "⬅️ Back", "⬅️ Back", "❌ Close"],
      confirm: [false],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const registry = await readBotRegistry();
    expect(registry.bots).toHaveLength(1);
    expect(ui.select.mock.calls[4][0]).toBe("🤖 keep"); // re-rendered bot detail (no default marker), not the list
  });

  it("Bots → Bot 列表 → bot → 更新 → updates allowedUserId", async () => {
    const bot = makeBot({ name: "mybot", token: "tok-x" });
    await addBot(bot);
    const botChoice = botChoiceFull(bot, true);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Bot 列表", botChoice, "更新", "⬅️ Back", "⬅️ Back", "⬅️ Back", "❌ Close"],
      input: ["allowedUserId", "99999"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const registry = await readBotRegistry();
    expect(registry.bots[0].allowedUserId).toBe(99999);
  });

  it("Bots → Bot 列表 → bot detail offers 更新/配对/删除 only (no default toggle)", async () => {
    const bot = makeBot({ name: "zeta", token: "t-z" });
    await addBot(bot);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Bot 列表", botChoiceFull(bot, true), "⬅️ Back", "⬅️ Back", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const detailCall = ui.select.mock.calls[3]; // 4th select = bot detail (main + Bots + Bot 列表 + detail)
    expect(detailCall[1]).toEqual(["更新", "配对", "删除", "⬅️ Back"]);
  });

  it("Bots submenu shows 添加/列表/全局默认 in order with the default bot named", async () => {
    const bot = makeBot({ name: "alpha", token: "t-a" });
    await addBot(bot); // becomes default
    const { ui } = makeScriptedUi({ select: ["🤖 Bots", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select.mock.calls[1][1]).toEqual(["➕ 添加 Bot", "Bot 列表", "⭐ 全局默认 Bot：alpha", "⬅️ Back"]);
  });

  it("Bots submenu default line shows 未设置 when no default is set", async () => {
    await addBot(makeBot({ name: "alpha", token: "t-a" }));
    await clearDefaultBot();
    const { ui } = makeScriptedUi({ select: ["🤖 Bots", "⭐ 全局默认 Bot：未设置", "⬅️ Back", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select.mock.calls[2][0]).toBe("⭐ 全局默认 Bot");
    expect(ui.select.mock.calls[2][1]).not.toContain("清除默认");
  });

  it("Project → shows the effective bot in the 绑定 Bot label", async () => {
    const bot = makeBot({ name: "proj-bot", token: "t-p" });
    await addBot(bot);
    const { ui } = makeScriptedUi({ select: ["📁 Project", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    const projectCall = ui.select.mock.calls[1]; // 2nd select = Project submenu (after main)
    expect(projectCall[1]).toContain("绑定 Bot：proj-bot（全局默认）");
  });

  it("Project → second item reflects connectionState", async () => {
    const bot = makeBot({ name: "state-bot", token: "t-s" });
    await addBot(bot);
    const expected: Record<TelegramConnectionState, string> = {
      "connected": "🟢 已连接 → 断开",
      "connecting": "🔄 连接中 → 断开",
      "other-instance": "🟡 其他实例使用中",
      "disconnected": "⚪ 已断开 → 连接",
    };
    for (const state of Object.keys(expected) as TelegramConnectionState[]) {
      connectionStateValue = state;
      const { ui } = makeScriptedUi({ select: ["📁 Project", "⬅️ Back", "❌ Close"] });
      await commands.get("tg")!("", makeCtx(ui));
      const options = ui.select.mock.calls[1][1] as string[];
      expect(options).toContain(expected[state]);
    }
  });

  it("Project → 其他实例使用中 → click only notifies", async () => {
    const bot = makeBot({ name: "other-bot", token: "t-o" });
    await addBot(bot);
    connectionStateValue = "other-instance";
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "🟡 其他实例使用中", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message.includes("同一个 Bot 正由另一个 pi 实例服务"))).toBe(true);
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(awaitReconcileCalls).toBe(0);
  });

  it("Project → no usable bot → only the 绑定 Bot item (no connection row)", async () => {
    const { ui } = makeScriptedUi({ select: ["📁 Project", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    const options = ui.select.mock.calls[1][1] as string[];
    expect(options).toEqual(["绑定 Bot：未设置", "⬅️ Back"]);
  });

  it("Project → a { enabled: false } disconnect record follows the default bot and offers no Unbind", async () => {
    const bot = makeBot({ name: "default-bot", token: "t-d" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { enabled: false });
    const { ui } = makeScriptedUi({
      select: ["📁 Project", "绑定 Bot：default-bot（全局默认）", "⬅️ Back", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const bindCall = ui.select.mock.calls[2]; // bot picker after clicking the binding row
    expect(bindCall[0]).toBe("Bind project to bot");
    expect(bindCall[1]).not.toContain("Unbind");
  });

  it("Project → 绑定 Bot → pick bot → writes .pi/telegram.json", async () => {
    const bot = makeBot({ name: "bind-bot", token: "t-b" });
    await addBot(bot);
    const botChoice = botChoiceFull(bot, true);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "绑定 Bot：bind-bot（全局默认）", botChoice, "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.botId).toBe(bot.id);
    expect(binding?.binding.enabled).toBe(true);
    expect(notifyCalls.some((c) => c.message.includes("Project bound to bot"))).toBe(true);
  });

  it("Project → ⚪ 已断开 → 连接 re-enables, awaits reconcile, new notice", async () => {
    const bot = makeBot({ name: "default-bot", token: "t-d" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: false });
    connectionStateValue = "disconnected";
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "⚪ 已断开 → 连接", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.enabled).toBe(true);
    expect(awaitReconcileCalls).toBe(1);
    expect(notifyCalls.some((c) => c.message.includes("已连接当前目录的 Telegram"))).toBe(true);
  });

  it("Project → 🟢 已连接 → 断开 confirms, disables, awaits reconcile, new notice", async () => {
    const bot = makeBot({ name: "dis-bot", token: "t-d" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true });
    connectionStateValue = "connected";
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "🟢 已连接 → 断开", "⬅️ Back", "❌ Close"],
      confirm: [true],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.confirm).toHaveBeenCalledWith(
      "断开当前目录的 Telegram？",
      "断开后 Telegram 将不再响应，只能在终端用 /tg 重新连接。",
    );
    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.enabled).toBe(false);
    expect(awaitReconcileCalls).toBe(1);
    expect(notifyCalls.some((c) => c.message.includes("已断开当前目录的 Telegram"))).toBe(true);
  });

  it("Project → 断开 confirm cancel does not disable", async () => {
    const bot = makeBot({ name: "dis-bot", token: "t-d" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true });
    connectionStateValue = "connected";
    const { ui } = makeScriptedUi({
      select: ["📁 Project", "🟢 已连接 → 断开", "⬅️ Back", "❌ Close"],
      confirm: [false],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const binding = await readProjectBinding(projectDir);
    expect(binding?.binding.enabled).toBe(true); // unchanged
    expect(awaitReconcileCalls).toBe(0);
  });

  it("Project → 绑定 Bot → Unbind → confirms and removes binding", async () => {
    const bot = makeBot({ name: "unbind-bot", token: "t-u" });
    await addBot(bot);
    await writeProjectBinding(projectDir, { botId: bot.id, enabled: true });
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["📁 Project", "绑定 Bot：unbind-bot", "Unbind", "⬅️ Back", "❌ Close"],
      confirm: [true],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const binding = await readProjectBinding(projectDir);
    expect(binding).toBeUndefined();
    expect(notifyCalls.some((c) => c.message.includes("Removed Telegram project binding"))).toBe(true);
  });

  it("Config → Tool → sets tool level", async () => {
    // Config menu → select "🔧 Tool: brief" → pickRenderLevel shows ["  hidden", "● brief", "  full"]
    // We pick "  full" (non-current = two-space prefix)
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["⚙️ Config", "🔧 Tool: brief", "  full", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    expect(config.tool).toBe("full");
    expect(notifyCalls.some((c) => c.message.includes("Tool") && c.message.includes("full"))).toBe(true);
  });

  it("Config → Thinking → sets thinking level", async () => {
    // pickRenderLevel shows ["  hidden", "● brief", "  full"] — we pick "  hidden"
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["⚙️ Config", "💭 Thinking: brief", "  hidden", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    expect(config.thinking).toBe("hidden");
    expect(notifyCalls.some((c) => c.message.includes("Thinking") && c.message.includes("hidden"))).toBe(true);
  });

  it("Config → Retry → sets retry count", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["⚙️ Config", "🔄 Retry: 3", "⬅️ Back", "❌ Close"],
      input: ["7"],
    });
    await commands.get("tg")!("", makeCtx(ui));

    expect(config.retryCount).toBe(7);
    expect(notifyCalls.some((c) => c.message.includes("Retry") && c.message.includes("7"))).toBe(true);
  });

  it("Back navigation: Bots → Back → main menu → Close", async () => {
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
  });

  it("Back navigation: Project → Back → main menu → Close", async () => {
    const { ui } = makeScriptedUi({
      select: ["📁 Project", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
  });

  it("Back navigation: Config → Back → main menu → Close", async () => {
    const { ui } = makeScriptedUi({
      select: ["⚙️ Config", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(3);
  });

  it("Bots → Bot 列表 with no bots shows info message", async () => {
    const { ui, notifyCalls } = makeScriptedUi({ select: ["🤖 Bots", "Bot 列表", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message.includes("No bots registered"))).toBe(true);
  });

  it("Bots → Bot 列表 → no bots → info", async () => {
    // With no bots, Bot 列表 shows the info message instead of a picker.
    const { ui, notifyCalls } = makeScriptedUi({ select: ["🤖 Bots", "Bot 列表", "⬅️ Back", "❌ Close"] });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select).toHaveBeenCalledTimes(4);
    expect(notifyCalls.some((c) => c.message.includes("No bots registered"))).toBe(true);
  });

  it("Switch instance with no coordinator shows error", async () => {
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🔄 Switch instance", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(notifyCalls.some((c) => c.message.includes("not the active Telegram instance"))).toBe(true);
  });

  it("配对 page (unpaired): shows pairing instructions, 重新生成配对码 swaps the code", async () => {
    const bot = makeBot({ name: "pairbot", pairingCode: "123456" });
    await addBot(bot);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "Bot 列表", botChoiceFull(bot, true), "配对", "重新生成配对码", "⬅️ Back", "⬅️ Back", "⬅️ Back", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const pairingCall = ui.select.mock.calls[4]; // 5th select = pairing page
    expect(pairingCall[0]).toBe("🔑 配对 · pairbot");
    expect(pairingCall[1]).toEqual(["重新生成配对码", "⬅️ Back"]);
    expect(notifyCalls.some((c) => c.message.includes("/pair 123456"))).toBe(true);
    const after = (await readBotRegistry()).bots[0];
    expect(after.pairingCode).toBe("654321");
    expect(notifyCalls.some((c) => c.message.includes("/pair 654321"))).toBe(true);
  });

  it("配对 page (paired): shows 已配对用户, 解除配对 confirms then clears allowedUserId with a new code", async () => {
    const bot = makeBot({ name: "pairbot", allowedUserId: 777 });
    await addBot(bot);
    const { ui, notifyCalls } = makeScriptedUi({
      select: ["🤖 Bots", "Bot 列表", botChoiceFull(bot, true), "配对", "解除配对", "⬅️ Back", "⬅️ Back", "⬅️ Back", "⬅️ Back", "❌ Close"],
      confirm: [true],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const pairingCall = ui.select.mock.calls[4];
    expect(pairingCall[0]).toBe("🔑 配对 · pairbot");
    expect(pairingCall[1]).toEqual(["解除配对", "⬅️ Back"]);
    expect(notifyCalls.some((c) => c.message.includes("已配对用户：777"))).toBe(true);
    expect(ui.confirm).toHaveBeenCalledWith("解除配对？", expect.stringContaining("解除后当前聊天将无法继续使用"));
    const after = (await readBotRegistry()).bots[0];
    expect(after.allowedUserId).toBeUndefined();
    expect(after.pairingCode).toBe("654321");
  });

  it("配对 page: 解除配对 cancel keeps allowedUserId and the pairing code untouched", async () => {
    const bot = makeBot({ name: "keeppair", allowedUserId: 777, pairingCode: "111111" });
    await addBot(bot);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "Bot 列表", botChoiceFull(bot, true), "配对", "解除配对", "⬅️ Back", "⬅️ Back", "⬅️ Back", "⬅️ Back", "❌ Close"],
      confirm: [false],
    });
    await commands.get("tg")!("", makeCtx(ui));
    const after = (await readBotRegistry()).bots[0];
    expect(after.allowedUserId).toBe(777);
    expect(after.pairingCode).toBe("111111");
  });

  it("全局默认 Bot submenu lists bots with the ⭐ marker and 清除默认 last", async () => {
    const bot1 = makeBot({ name: "a", botUsername: "a_bot" });
    const bot2 = makeBot({ name: "b", allowedUserId: 42 });
    await addBot(bot1);
    await addBot(bot2);
    const { ui } = makeScriptedUi({
      select: ["🤖 Bots", "⭐ 全局默认 Bot：a", "⬅️ Back", "⬅️ Back", "❌ Close"],
    });
    await commands.get("tg")!("", makeCtx(ui));
    expect(ui.select.mock.calls[2][0]).toBe("⭐ 全局默认 Bot");
    expect(ui.select.mock.calls[2][1]).toEqual([
      botChoiceFull(bot1, true), botChoiceFull(bot2, false), "清除默认", "⬅️ Back",
    ]);
  });
});