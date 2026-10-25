import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { readBotRegistry, readProjectBinding } from "../config.ts";
import type { TelegramInstanceMetadata } from "../instance-coordinator.ts";
import type { TelegramInstanceCoordinator } from "../instance-coordinator.ts";
import type { MenuUi, TelegramCommandDeps, TelegramConnectionState } from "./telegram-commands.ts";
import type { TgConfigDeps, SessionDeps } from "./register.ts";
import type { BotRecord, BotRegistry, TelegramConfig } from "../types.ts";
import { configToolFlow, configThinkingFlow, configRetryFlow, configBashFlow } from "./tg-config.ts";
import { formatPairingInstructions } from "../pairing.ts";
import {
  addBotFlow,
  clearBotDefaultFlow,
  regeneratePairingCodeFlow,
  unpairBotFlow,
  setBotDefaultFlow,
  updateBotFlow,
  removeBotFlow,
  bindProjectFlow,
  enableProjectFlow,
  disableProjectFlow,
  unbindProjectFlow,
} from "./telegram-commands.ts";

/** Format a live instance for display in the switch selector. */
export function formatInstanceChoice(instance: TelegramInstanceMetadata, activeId: string): string {
  const marker = instance.id === activeId ? "✓" : " ";
  const project = (basename(instance.cwd) || instance.cwd).slice(0, 28);
  const session = (instance.sessionName || instance.sessionId?.slice(0, 8) || "session").slice(0, 24);
  const model = (instance.model || "no-model").slice(0, 36);
  return `${marker} ${project} · ${session} · ${model} · ${instance.id.slice(0, 8)}`;
}

// ── Menu option labels ─────────────────────────────────────────────────────

const MAIN_MENU_OPTIONS = [
  "🤖 Bots",
  "📁 Project",
  "⌨️ Commands",
  "⚙️ Config",
  "🔄 Switch instance",
  "❌ Close",
] as const;

const BOTS_MENU_ADD = "➕ 添加 Bot";
const BOTS_MENU_LIST = "Bot 列表";
const BOTS_MENU_DEFAULT_PREFIX = "⭐ 全局默认 Bot：";
const CLEAR_DEFAULT_LABEL = "清除默认";

const CONFIG_MENU_PREFIX = "⚙️ Telegram Config";
const BACK_LABEL = "⬅️ Back";
const UNBIND_LABEL = "Unbind";

/** Format a registered bot for display in bot-list / pickers. */
function formatBotLabel(bot: BotRecord, registry: BotRegistry): string {
  const marker = registry.defaultBotId === bot.id ? " ⭐ 默认" : "";
  const username = bot.botUsername ? `@${bot.botUsername}` : "无用户名";
  const paired = bot.allowedUserId !== undefined ? "已配对" : "未配对";
  return `${bot.name}${marker} · ${username} · ${paired}`;
}

/** Thrown from a leaf action that moves this pi off the current bot: the menu's
 *  chat stops being polled, so the whole /tg menu exits instead of returning
 *  to a submenu nobody can press. */
class MenuClosed extends Error {}

/** Navigation select. On Telegram, ui.menu edits one message in place so the
 *  whole /tg navigation stays on a single message; the TUI has no edit concept
 *  and falls back to ui.select. */
function pick(ui: MenuUi, title: string, options: string[]): Promise<string | undefined> {
  return ui.menu ? ui.menu(title, options) : ui.select(title, options);
}

// ── Switch instance flow deps ──────────────────────────────────────────────

export type CommandMenuDeps = {
  /** Full catalog (plugin + host builtins/extensions), deduped by the caller. */
  getCommands: () => Promise<Array<{ name: string; description?: string }>>;
  /** Execute a command in the current Telegram chat. */
  runCommand: (name: string, args: string) => Promise<void>;
};

export type SwitchInstanceDeps = {
  getCoordinator: () => TelegramInstanceCoordinator | undefined;
  getCurrentChatId: () => number | undefined;
  stopPolling: () => Promise<void>;
  startPolling: () => void;
  requestReconcile: () => void;
  getCurrentTurn: () => { chatId: number; messageThreadId?: number; sourceMessageId?: number } | undefined;
  /** Shared handoff gate (same Set used by isActiveInstance) so a
   *  menu-triggered switch blocks outbound sends during the handoff. */
  pendingHandoffs: Set<string>;
};

// ── Menu registration ──────────────────────────────────────────────────────

export function registerTgMenuCommand(
  registry: { registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => void },
  deps: TelegramCommandDeps,
  configDeps: TgConfigDeps,
  switchDeps: SwitchInstanceDeps,
  commandDeps?: CommandMenuDeps,
  sessionDeps?: SessionDeps,
): void {
  registry.registerCommand("tg", {
    description: "Open the Telegram management menu",
    handler: (_args, ctx) => runTgMenu(
      // MenuUi is the structural subset of ExtensionUIContext the menu flows
      // consume (plus Telegram-only menu/closeMenu hooks injected by the
      // controller's run-with-UI wrapper).
      ctx.ui as unknown as MenuUi,
      deps, configDeps, switchDeps, commandDeps, sessionDeps, ctx.cwd || process.cwd(),
    ),
  });
}

// ── Menu driver ─────────────────────────────────────────────────────────────

async function runTgMenu(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  configDeps: TgConfigDeps,
  switchDeps: SwitchInstanceDeps,
  commandDeps: CommandMenuDeps | undefined,
  sessionDeps: SessionDeps | undefined,
  cwd: string,
): Promise<void> {
  try {
    await mainMenu(ui, deps, configDeps, switchDeps, commandDeps, sessionDeps, cwd);
  } catch (error) {
    if (!(error instanceof MenuClosed)) throw error;
  } finally {
    await ui.closeMenu?.();
  }
}

async function mainMenu(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  configDeps: TgConfigDeps,
  switchDeps: SwitchInstanceDeps,
  commandDeps: CommandMenuDeps | undefined,
  sessionDeps: SessionDeps | undefined,
  cwd: string,
): Promise<void> {
  const options = commandDeps
    ? [...MAIN_MENU_OPTIONS]
    : MAIN_MENU_OPTIONS.filter((option) => option !== "⌨️ Commands");
  while (true) {
    const choice = await pick(ui, "Telegram Management", options);
    if (!choice || choice === "❌ Close") return;

    if (choice === "🤖 Bots") {
      if (await botsMenu(ui, deps, cwd)) continue;
      return;
    } else if (choice === "📁 Project") {
      if (await projectMenu(ui, deps, cwd)) continue;
      return;
    } else if (choice === "⌨️ Commands") {
      if (commandDeps) await commandsMenu(ui, commandDeps);
      continue;
    } else if (choice === "⚙️ Config") {
      if (await configMenu(ui, configDeps, sessionDeps)) continue;
      return;
    } else if (choice === "🔄 Switch instance") {
      if (await switchInstanceMenu(ui, switchDeps)) continue;
      return;
    }
    // Unknown choice — return to main menu
  }
}

// ── Full command catalog ───────────────────────────────────────────────────

async function commandsMenu(ui: MenuUi, deps: CommandMenuDeps): Promise<void> {
  const commands = (await deps.getCommands()).filter((command) => command.name !== "tg");
  if (commands.length === 0) {
    ui.notify("No commands are available.", "info");
    return;
  }
  const labels = commands.map((command) => `/${command.name}${command.description ? ` — ${command.description}` : ""}`);
  const selected = await pick(ui, `⌨️ Commands (${commands.length})`, [...labels, BACK_LABEL]);
  if (!selected || selected === BACK_LABEL) return;
  const index = labels.indexOf(selected);
  const command = commands[index];
  if (!command) return;
  await deps.runCommand(command.name, "");
}

// ── Bots submenu ───────────────────────────────────────────────────────────

async function botsMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<boolean> {
  while (true) {
    // Re-read each iteration so the "全局默认 Bot" line always shows the
    // current default (or 未设置).
    const registry = await readBotRegistry();
    const defaultBot = registry.bots.find((b) => b.id === registry.defaultBotId);
    const defaultChoice = `${BOTS_MENU_DEFAULT_PREFIX}${defaultBot?.name ?? "未设置"}`;
    const choice = await pick(ui, "🤖 Bots", [BOTS_MENU_ADD, BOTS_MENU_LIST, defaultChoice, BACK_LABEL]);
    if (!choice || choice === BACK_LABEL) return true; // back to main

    if (choice === BOTS_MENU_ADD) {
      await addBotFlow(ui, deps);
    } else if (choice === BOTS_MENU_LIST) {
      await botListMenu(ui, deps, cwd);
    } else if (choice === defaultChoice) {
      await defaultBotMenu(ui, deps, cwd);
    }
    // loop re-renders the Bots submenu
  }
}

// ── Global default bot (the default is set ONLY here) ──────────────────────

async function defaultBotMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<void> {
  while (true) {
    const registry = await readBotRegistry();
    if (registry.bots.length === 0) {
      ui.notify("No bots registered. Use ➕ 添加 Bot first.", "info");
      return;
    }
    // The current default is ⭐-marked via formatBotLabel; 清除默认 only exists
    // while a default actually is set.
    const choices = registry.bots.map((b) => formatBotLabel(b, registry));
    const selected = await pick(ui, "⭐ 全局默认 Bot", [
      ...choices,
      ...(registry.defaultBotId ? [CLEAR_DEFAULT_LABEL] : []),
      BACK_LABEL,
    ]);
    if (!selected || selected === BACK_LABEL) return; // back to Bots submenu

    if (selected === CLEAR_DEFAULT_LABEL) {
      if (await clearBotDefaultFlow(ui, deps, cwd)) throw new MenuClosed();
      continue;
    }
    const bot = registry.bots[choices.indexOf(selected)];
    if (bot && await setBotDefaultFlow(ui, bot.id, deps, cwd)) throw new MenuClosed();
    // loop re-renders the picker (the ⭐ marker may have moved)
  }
}

// ── Bot list (object-first: pick a bot → per-bot actions) ──────────────────

async function botListMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<void> {
  while (true) {
    const registry = await readBotRegistry();
    if (registry.bots.length === 0) {
      ui.notify("No bots registered. Use ➕ 添加 Bot first.", "info");
      return;
    }
    const choices = registry.bots.map((b) => formatBotLabel(b, registry));
    const selected = await pick(ui, "Bot 列表", [...choices, BACK_LABEL]);
    if (!selected || selected === BACK_LABEL) return; // back to Bots submenu
    const bot = registry.bots[choices.indexOf(selected)];
    if (bot) await botDetailMenu(ui, deps, cwd, bot);
    // loop re-renders the bot list (reflects remove/pairing changes)
  }
}

// ── Per-bot actions ──────────────────────────────────────────────────────────

async function botDetailMenu(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
  bot: BotRecord,
): Promise<void> {
  while (true) {
    // Re-read each iteration so the bot's existence stays fresh.
    const registry = await readBotRegistry();
    const botNow = registry.bots.find((b) => b.id === bot.id);
    if (!botNow) {
      ui.notify("Bot no longer exists.", "info");
      return; // removed elsewhere → back to bot list
    }
    // The global default is set only in the ⭐ 全局默认 Bot submenu; this page
    // holds the bot's own actions.
    const choice = await pick(ui, `🤖 ${botNow.name}`, ["更新", "配对", "删除", BACK_LABEL]);
    if (!choice || choice === BACK_LABEL) return; // back to bot list

    if (choice === "更新") {
      await updateBotFlow(ui, deps, cwd, botNow.id);
    } else if (choice === "配对") {
      await pairingMenu(ui, deps, botNow);
    } else if (choice === "删除") {
      await removeBotFlow(ui, deps, cwd, botNow.id);
      const removed = !(await readBotRegistry()).bots.some((b) => b.id === botNow.id);
      if (removed) return; // back to bot list (re-reads without this bot); declined → stay here
    }
    // loop re-renders the per-bot action menu (re-reads registry)
  }
}

// ── Per-bot pairing page ─────────────────────────────────────────────────────

async function pairingMenu(ui: MenuUi, deps: TelegramCommandDeps, bot: BotRecord): Promise<void> {
  while (true) {
    const registry = await readBotRegistry();
    const botNow = registry.bots.find((b) => b.id === bot.id);
    if (!botNow) {
      ui.notify("Bot no longer exists.", "info");
      return;
    }
    const paired = botNow.allowedUserId !== undefined;
    // The menu UI only offers select/notify: the state/instructions go out as
    // a notify right before the choices render.
    if (paired) {
      ui.notify(`已配对用户：${botNow.allowedUserId}`, "info");
    } else {
      ui.notify(formatPairingInstructions({ ...botNow, botToken: botNow.token } as TelegramConfig), "info");
    }
    const choice = await pick(
      ui,
      `🔑 配对 · ${botNow.name}`,
      paired ? ["解除配对", BACK_LABEL] : ["重新生成配对码", BACK_LABEL],
    );
    if (!choice || choice === BACK_LABEL) return; // back to bot detail

    if (choice === "重新生成配对码") {
      await regeneratePairingCodeFlow(ui, deps, botNow.id);
    } else if (choice === "解除配对") {
      await unpairBotFlow(ui, deps, botNow.id);
    }
    // loop re-renders the pairing page (fresh code / pairing state)
  }
}

// ── Project submenu (binding + real connection state) ──────────────────────

/** Second item: the actual runtime connection state (same source as the
 *  status bar), offered as the matching action. */
function connectionChoice(state: TelegramConnectionState): string {
  if (state === "connected") return "🟢 已连接 → 断开";
  if (state === "connecting") return "🔄 连接中 → 断开";
  if (state === "other-instance") return "🟡 其他实例使用中";
  return "⚪ 已断开 → 连接";
}

async function projectMenu(ui: MenuUi, deps: TelegramCommandDeps, cwd: string): Promise<boolean> {
  while (true) {
    const [registry, project] = await Promise.all([readBotRegistry(), readProjectBinding(cwd)]);
    const boundBotId = project?.binding.botId;
    // 绑定里没有 botId = 跟随全局默认 Bot（`{ enabled: false }` 断开记录
    // 也算跟随默认，不是"已绑定"）。
    const followsDefault = !boundBotId;
    const effectiveBotId = boundBotId ?? registry.defaultBotId;
    const effectiveBot = effectiveBotId ? registry.bots.find((b) => b.id === effectiveBotId) : undefined;

    const botLabel = effectiveBot
      ? `绑定 Bot：${effectiveBot.name}${followsDefault ? "（全局默认）" : ""}`
      : "绑定 Bot：未设置";

    const connection = deps.connectionState();
    const connectLabel = connectionChoice(connection);

    const choice = await pick(ui, "📁 Project", [
      botLabel,
      // 没有可用 Bot 时谈不上连接，隐藏这一项。
      ...(effectiveBot ? [connectLabel] : []),
      BACK_LABEL,
    ]);
    if (!choice || choice === BACK_LABEL) return true; // back to main

    if (choice === botLabel) {
      if (registry.bots.length === 0) {
        ui.notify("No bots registered. Use /tg → Bots → Add bot first.", "info");
        continue;
      }
      const choices = registry.bots.map((b) => formatBotLabel(b, registry));
      // 解绑只对"绑定里有 botId"的项目有意义。
      const selected = await pick(ui, "Bind project to bot", [...choices, ...(boundBotId ? [UNBIND_LABEL] : []), BACK_LABEL]);
      if (!selected || selected === BACK_LABEL) continue;
      if (selected === UNBIND_LABEL) {
        await unbindProjectFlow(ui, deps, cwd);
      } else {
        const bot = registry.bots[choices.indexOf(selected)];
        if (bot) await bindProjectFlow(ui, deps, cwd, bot.id);
      }
    } else if (choice === connectLabel) {
      if (connection === "other-instance") {
        ui.notify("同一个 Bot 正由另一个 pi 实例服务", "info");
      } else if (connection === "disconnected") {
        // flow awaits reconcile, so the next render shows the new state.
        await enableProjectFlow(ui, deps, cwd);
      } else {
        const ok = await ui.confirm(
          "断开当前目录的 Telegram？",
          "断开后 Telegram 将不再响应，只能在终端用 /tg 重新连接。",
        );
        if (ok) await disableProjectFlow(ui, deps, cwd);
      }
    }
    // loop re-renders Project (binding + live connection state)
  }
}

// ── Config submenu ─────────────────────────────────────────────────────────

async function configMenu(ui: MenuUi, configDeps: TgConfigDeps, sessionDeps?: SessionDeps): Promise<boolean> {
  while (true) {
    const config = configDeps.getConfig();
    const currentTool = config.tool ?? "brief";
    const currentThinking = config.thinking ?? "brief";
    const currentRetry = config.retryCount ?? 3;
    const currentBash = config.bashConfirm ?? "dangerous";
    // Model thinking level lives on the session, not the bridge config; the
    // flat thinking command was removed, so this menu is its Telegram-side
    // home (pi users also have native /thinking; OMP has no Telegram-reachable
    // hotkey).
    const session = sessionDeps?.getSession();
    const thinkingLevels = session?.getAvailableThinkingLevels() ?? [];

    const choice = await pick(ui, CONFIG_MENU_PREFIX, [
      `🔧 Tool: ${currentTool}`,
      `💭 Thinking: ${currentThinking}`,
      ...(thinkingLevels.length > 0 ? [`🧠 Thinking level: ${session?.thinkingLevel ?? "off"}`] : []),
      `🔄 Retry: ${currentRetry}`,
      `🐚 Shell confirm: ${currentBash}`,
      BACK_LABEL,
    ]);
    if (!choice || choice === BACK_LABEL) return true; // back to main

    if (choice.startsWith("🔧 Tool:")) {
      await configToolFlow(ui, configDeps);
    } else if (choice.startsWith("💭 Thinking:")) {
      await configThinkingFlow(ui, configDeps);
    } else if (choice.startsWith("🧠 Thinking level:")) {
      if (!session || thinkingLevels.length === 0) continue;
      const labels = thinkingLevels.map((l) => (l === session.thinkingLevel ? "● " : "  ") + String(l));
      const selected = await pick(ui, "Thinking level", labels);
      if (!selected) continue;
      const level = thinkingLevels[labels.indexOf(selected)];
      if (level !== undefined) {
        session.setThinkingLevel(level);
        ui.notify(`Thinking level set: ${level}`, "info");
      }
    } else if (choice.startsWith("🔄 Retry:")) {
      await configRetryFlow(ui, configDeps);
    } else if (choice.startsWith("🐚 Shell confirm:")) {
      await configBashFlow(ui, configDeps);
    }
  }
}

// ── Switch instance submenu ────────────────────────────────────────────────

async function switchInstanceMenu(ui: MenuUi, switchDeps: SwitchInstanceDeps): Promise<boolean> {
  const coordinator = switchDeps.getCoordinator();
  if (!coordinator || !coordinator.isActive()) {
    ui.notify("This pi instance is not the active Telegram instance.", "error");
    return true; // back to main
  }
  const instances = await coordinator.listInstances();
  const active = coordinator.getActive();
  if (!active || instances.length === 0) {
    ui.notify("No live Telegram instances are available.", "error");
    return true; // back to main
  }

  const choices = instances.map((instance) => formatInstanceChoice(instance, active.instanceId));
  const selected = await pick(ui, "Switch Telegram pi instance", [...choices, BACK_LABEL]);
  if (!selected || selected === BACK_LABEL) return true; // back to main

  const target = instances[choices.indexOf(selected)];
  if (!target) return true;

  const turn = switchDeps.getCurrentTurn();
  const chatId = turn?.chatId ?? switchDeps.getCurrentChatId();
  if (chatId === undefined) {
    ui.notify("No active Telegram chat is available for history replay.", "error");
    return true;
  }

  const handoffId = randomUUID();
  const pendingHandoffs = switchDeps.pendingHandoffs;
  pendingHandoffs.add(handoffId);
  try {
    await switchDeps.stopPolling();
    await coordinator.switchTo(
      target.id,
      {
        chatId,
        messageThreadId: turn?.messageThreadId,
        sourceMessageId: turn?.sourceMessageId,
      },
      { instanceId: active.instanceId, generation: active.generation },
    );
  } finally {
    pendingHandoffs.delete(handoffId);
    switchDeps.requestReconcile();
    if (pendingHandoffs.size === 0 && coordinator.isActive() && !coordinator.getActive()?.replay) {
      switchDeps.startPolling();
    }
  }
  return true; // back to main
}