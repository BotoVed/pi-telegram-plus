import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { addBot, bindProjectTelegram, clearDefaultBot, findBotByIdOrName, readBotRegistry, removeBot, setDefaultBot, unbindProjectTelegram, updateBot, updateProjectBindingLocked, readProjectBinding, readResolvedTelegramConfig } from "../config.ts";
import { escapeHtml } from "../html.ts";
import { getTelegramBotUsername } from "../telegram-api.ts";
import { createTelegramPairingCode, ensureTelegramPairingCode, formatPairingInstructions } from "../pairing.ts";
import type { BotRecord, ResolvedTelegramConfig, TelegramConfig, TelegramTransport } from "../types.ts";
import type { TelegramPollingRuntime } from "../polling.ts";
import { log } from "../logger.ts";

const tgCmdLog = log.child("tg-commands");

export type TelegramCommandDeps = {
  getConfig: () => TelegramConfig;
  setConfig: (c: TelegramConfig) => void;
  persistConfig: (c: TelegramConfig) => Promise<void>;
  getResolvedConfig: () => ResolvedTelegramConfig | undefined;
  switchResolvedConfig: (next: ResolvedTelegramConfig) => void;
  isTelegramEnabled: () => boolean;
  transport: TelegramTransport;
  getPolling: () => TelegramPollingRuntime;
  refreshStatus: () => void;
  syncTelegramCommands: () => Promise<void>;
  startStatusHeartbeat: () => void;
  clearStatusError: () => void;
};

// ── Shared UI type ─────────────────────────────────────────────────────────

export type MenuUi = {
  notify: (message: string, level?: "info" | "warning" | "error") => void;
  select: (title: string, options: string[]) => Promise<string | undefined>;
  input: (title: string, placeholder?: string) => Promise<string | undefined>;
  inputSecret?: (title: string, placeholder?: string) => Promise<string | undefined>;
  confirm: (title: string, message?: string) => Promise<boolean>;
  /** Telegram only: select that edits one menu message in place across calls. */
  menu?: (title: string, options: string[]) => Promise<string | undefined>;
  /** Telegram only: drop the keyboard of the live menu message. */
  closeMenu?: () => Promise<void>;
};

// ── Reusable flow functions (shared by the /tg menu) ───────────────────────

export async function listBotsFlow(ui: MenuUi): Promise<void> {
  const registry = await readBotRegistry();
  if (registry.bots.length === 0) {
    ui.notify("No bots registered. Use /tg → Bots → Add bot to add one.", "info");
    return;
  }
  const lines = registry.bots.map((bot) => {
    const defaultMarker = registry.defaultBotId === bot.id ? " ★ default" : "";
    const username = bot.botUsername ? `@${bot.botUsername}` : "no username";
    const paired = bot.allowedUserId !== undefined ? `paired (user ${bot.allowedUserId})` : bot.pairingCode ? `pairing: ${bot.pairingCode}` : "not paired";
    return `- ${escapeHtml(bot.name)} (${bot.id.slice(0, 8)}) · ${username} · ${paired}${defaultMarker}`;
  });
  ui.notify(`Registered bots:\n${lines.join("\n")}`, "info");
}

export async function addBotFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  name?: string,
  token?: string,
): Promise<void> {
  const botName = name ?? await ui.input("Bot name (unique label, e.g. 'work-bot')");
  if (!botName) return;
  const botToken = token ?? await (ui.inputSecret?.("Telegram bot token (from @BotFather)") ?? ui.input("Telegram bot token (from @BotFather)"));
  if (!botToken) return;
  const registry = await readBotRegistry();
  if (registry.bots.some((b) => b.name.toLowerCase() === botName.toLowerCase())) {
    ui.notify(`A bot named "${escapeHtml(botName)}" already exists. Choose a different name.`, "error");
    return;
  }
  const apiBase = deps.getConfig().apiBase;
  const botUsername = await getTelegramBotUsername(botToken, apiBase).catch(tgCmdLog.swallow("warn", "getTelegramBotUsername failed during bot-add"));
  const pairingCode = createTelegramPairingCode();
  const bot: BotRecord = {
    id: randomUUID(),
    name: botName,
    token: botToken,
    ...(botUsername === undefined ? {} : { botUsername }),
    ...(apiBase === undefined ? {} : { apiBase }),
    ...(pairingCode === undefined ? {} : { pairingCode }),
  };
  const updatedRegistry = await addBot(bot);
  const isDefault = updatedRegistry.defaultBotId === bot.id;
  await deps.syncTelegramCommands();
  deps.refreshStatus();
  ui.notify(
    `Bot added: ${escapeHtml(botName)}${botUsername ? ` (@${botUsername})` : ""}${isDefault ? " — set as default" : ""}\n${formatPairingInstructions({ ...bot, botToken } as TelegramConfig)}`,
    "info",
  );
}

/** Set the default bot. Returns true when this pi switches bots as a result:
 *  an unbound project follows the default, so a different default moves its
 *  routing just like bindProjectFlow does. In that case notify and close the
 *  menu BEFORE the switch, while this bot can still deliver to the chat. */
export async function setBotDefaultFlow(
  ui: MenuUi,
  botId: string,
  deps?: TelegramCommandDeps,
  cwd?: string,
): Promise<boolean> {
  const bot = findBotByIdOrName(await readBotRegistry(), botId);
  const label = `${escapeHtml(bot?.name ?? botId)} (${botId.slice(0, 8)})`;
  const currentToken = deps?.getConfig().botToken;
  const switching = !!bot && !!cwd && !!currentToken && bot.token !== currentToken
    && !(await readProjectBinding(cwd));
  if (switching) {
    ui.notify(
      `Default bot set to: ${label}. This project has no binding and follows the default, so it now switches to ${bot.botUsername ? `@${escapeHtml(bot.botUsername)}` : escapeHtml(bot.name)} — if /tg is open, it will close; reopen it there to continue.`,
      "info",
    );
    await ui.closeMenu?.();
  }
  await setDefaultBot(botId);
  // The default is global, but this process may route through it (unbound
  // project). Re-resolve so the switch takes effect now instead of on restart.
  if (deps && cwd) await refreshRouting(deps, cwd);
  if (!switching) ui.notify(`Default bot set to: ${label}`, "info");
  return switching;
}

/** Re-resolve this process's routing after a registry change, so a token
 *  switch or removal takes effect now instead of on restart. The upstream
 *  status error belongs to the previous routing; drop it so a stopped poller
 *  does not show a stale "error" instead of "not configured". */
async function refreshRouting(deps: TelegramCommandDeps, cwd: string): Promise<void> {
  deps.switchResolvedConfig(await readResolvedTelegramConfig(cwd));
  deps.clearStatusError();
  deps.refreshStatus();
}

/**
 * Clear the global default bot. This only touches the registry; it never
 * changes a project binding. Returns true when this project has no binding, so
 * the caller must treat the menu as closed: nothing routes Telegram here until
 * a default or a binding exists again.
 */
export async function clearBotDefaultFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps | undefined,
  cwd: string,
): Promise<boolean> {
  const registry = await readBotRegistry();
  if (!registry.defaultBotId) {
    ui.notify("No default bot is set.", "info");
    return false;
  }
  const followsDefault = !(await readProjectBinding(cwd));
  ui.notify(
    followsDefault
    ? "Default bot cleared. This project has no binding, so it now loses Telegram and the menu closes. Bind a bot (/tg → Project → Bot) or set a default in the TUI to reconnect."
      : "Default bot cleared.",
    followsDefault ? "warning" : "info",
  );
  if (followsDefault) await ui.closeMenu?.();
  await clearDefaultBot();
  if (deps) await refreshRouting(deps, cwd);
  return followsDefault;
}

export async function updateBotFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
  botId: string,
  field?: string,
  value?: string,
): Promise<void> {
  const registry = await readBotRegistry();
  const bot = registry.bots.find((b) => b.id === botId);
  if (!bot) {
    ui.notify(`Bot not found: ${botId.slice(0, 8)}`, "error");
    return;
  }
  const selectedField = field ?? await ui.input("Field to update (token, name, allowedUserId, apiBase)");
  if (!selectedField) return;
  const validFields = ["token", "name", "allowedUserId", "apiBase"];
  if (!validFields.includes(selectedField)) {
    ui.notify(`Invalid field. Choose from: ${validFields.join(", ")}`, "error");
    return;
  }
  let fieldValue: string | undefined;
  if (selectedField === "token") {
    fieldValue = value ?? await (ui.inputSecret?.("New token") ?? ui.input("New token"));
  } else {
    fieldValue = value ?? await ui.input(`New value for ${selectedField}`);
  }
  if (!fieldValue) return;
  const updates: Partial<Omit<BotRecord, "id">> = {};
  if (selectedField === "token") {
    updates.token = fieldValue;
    const botUsername = await getTelegramBotUsername(fieldValue, bot.apiBase).catch(tgCmdLog.swallow("warn", "getTelegramBotUsername failed during bot-update"));
    if (botUsername) updates.botUsername = botUsername;
  } else if (selectedField === "name") {
    if (registry.bots.some((b) => b.id !== bot.id && b.name.toLowerCase() === fieldValue!.toLowerCase())) {
      ui.notify(`A bot named "${escapeHtml(fieldValue)}" already exists.`, "error");
      return;
    }
    updates.name = fieldValue;
  } else if (selectedField === "allowedUserId") {
    const userId = Number(fieldValue);
    if (!Number.isInteger(userId)) {
      ui.notify(`Invalid allowedUserId: must be an integer.`, "error");
      return;
    }
    updates.allowedUserId = userId;
  } else if (selectedField === "apiBase") {
    updates.apiBase = fieldValue;
  }
  await updateBot(bot.id, updates);
  const currentBot = deps.getResolvedConfig()?.bot;
  if (currentBot?.id === bot.id) {
    deps.switchResolvedConfig(await readResolvedTelegramConfig(cwd));
    await deps.syncTelegramCommands();
    deps.refreshStatus();
  }
  ui.notify(`Bot updated: ${escapeHtml(bot.name)} (${bot.id.slice(0, 8)})`, "info");
}

export async function removeBotFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
  botId: string,
  skipConfirm = false,
): Promise<void> {
  const registry = await readBotRegistry();
  const bot = registry.bots.find((b) => b.id === botId);
  if (!bot) {
    ui.notify(`Bot not found: ${botId.slice(0, 8)}`, "error");
    return;
  }
  if (!skipConfirm) {
    const confirmed = await ui.confirm(`Remove bot "${bot.name}"?`, `This will remove the bot from the registry. Any project .pi/telegram.json referencing this bot will lose its binding.`);
    if (!confirmed) return;
  }
  const wasDefault = registry.defaultBotId === bot.id;
  await removeBot(bot.id);
  if (wasDefault) {
    ui.notify(`Warning: removed bot was the default. ${registry.bots.length > 1 ? "A remaining bot was promoted." : "No default bot is set."}`, "warning");
  }
  ui.notify(
    `Bot removed: ${escapeHtml(bot.name)} (${bot.id.slice(0, 8)})\nAny project .pi/telegram.json referencing this bot will lose its binding.`,
    "warning",
  );
  const currentBot = deps.getResolvedConfig()?.bot;
  if (currentBot?.id === bot.id) {
    deps.switchResolvedConfig(await readResolvedTelegramConfig(cwd));
    await deps.getPolling().stop();
    deps.refreshStatus();
  }
}

export async function bindProjectFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
  botId?: string,
): Promise<void> {
  const registry = await readBotRegistry();
  if (registry.bots.length === 0) {
    ui.notify("No bots registered. Use /tg → Bots → Add bot first.", "error");
    return;
  }
  let bot: BotRecord | undefined;
  if (botId) {
    bot = registry.bots.find((b) => b.id === botId) ?? findBotByIdOrName(registry, botId);
    if (!bot) {
      ui.notify(`Bot not found: ${escapeHtml(botId)}. Use /tg → Bots → Bot list to see registered bots.`, "error");
      return;
    }
  } else {
    const choices = registry.bots.map((b) => {
      const marker = registry.defaultBotId === b.id ? " ★" : "";
      const username = b.botUsername ? `@${b.botUsername}` : "no username";
      return `${b.name}${marker} · ${username} · ${b.id.slice(0, 8)}`;
    });
    const selected = await ui.select("Select a bot to bind to this project", choices);
    if (!selected) return;
    bot = registry.bots[choices.indexOf(selected)];
  }
  if (!bot) return;

  const workspacePath = resolve(cwd);
  const prevBotToken = deps.getConfig().botToken;
  // Binding to a DIFFERENT bot changes routing and moves active ownership to
  // the new bot. Notify BEFORE the switch (while still the active owner of the
  // current bot) so the message is delivered — a post-switch notify would be
  // suppressed until the new bot is claimed, and an in-progress /tg menu ends
  // on the routing change (the user reopens /tg). Skip for the initial bind
  // (no prior bot) so that case only gets the normal "Project bound" notice.
  if (prevBotToken && bot.token !== prevBotToken) {
    ui.notify(
      `Switching bot to ${escapeHtml(bot.name)}${bot.botUsername ? ` (@${bot.botUsername})` : ""}. ${escapeHtml(workspacePath)} — if /tg is open, it will close; reopen it to continue.`,
      "info",
    );
  }
  await deps.getPolling().stop();
  deps.switchResolvedConfig(await bindProjectTelegram(workspacePath, bot.id));
  const config = ensureTelegramPairingCode(deps.getConfig());
  if (config !== deps.getConfig()) {
    await updateBot(bot.id, { ...(config.pairingCode !== undefined ? { pairingCode: config.pairingCode } : {}) });
  }
  deps.getPolling().start();
  await deps.syncTelegramCommands();
  deps.startStatusHeartbeat();
  deps.refreshStatus();
  ui.notify(
    `Project bound to bot: ${escapeHtml(bot.name)}${bot.botUsername ? ` (@${bot.botUsername})` : ""}\n${escapeHtml(workspacePath)}\n${formatPairingInstructions(config)}`,
    "info",
  );
}

export async function enableProjectFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
): Promise<void> {
  const registry = await readBotRegistry();
  if (registry.bots.length === 0) {
    ui.notify("No Telegram bot registered. Use /tg → Bots → Add bot first.", "error");
    return;
  }
  const workspacePath = resolve(cwd);
  const project = await readProjectBinding(workspacePath);
  if (project) {
    await updateProjectBindingLocked(project.path, (b) => ({ ...b, enabled: true }));
  } else {
    if (!registry.defaultBotId) {
      ui.notify("No default bot set. Use /tg → Bots → Bot list → Set as default.", "error");
      return;
    }
    await updateProjectBindingLocked(workspacePath, () => ({ botId: registry.defaultBotId, enabled: true }));
  }
  deps.switchResolvedConfig(await readResolvedTelegramConfig(workspacePath));
  deps.setConfig({ ...deps.getConfig(), telegramEnabled: true });
  await deps.getPolling().stop();
  if (deps.isTelegramEnabled()) deps.getPolling().start();
  deps.clearStatusError();
  deps.startStatusHeartbeat();
  deps.refreshStatus();
  ui.notify(`Telegram bot enabled for current project.`, "info");
}

export async function disableProjectFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
): Promise<void> {
  const workspacePath = resolve(cwd);
  const project = await readProjectBinding(workspacePath);
  const wasEnabled = deps.getConfig().telegramEnabled !== false;
  // Disabling changes routing (enabled true→false) and disconnects the bot, so an
  // in-progress /tg menu ends and can no longer render. Notify BEFORE the switch
  // (while still the active owner) so the message is delivered, and tell the user
  // how to re-enable (the menu can't, once disconnected).
  if (wasEnabled && project) {
    ui.notify(
      `Disabling bot for this project. If /tg is open it will close; re-enable via /tg → Project → Enabled after restarting pi.`,
      "info",
    );
  }
  if (project) {
    await updateProjectBindingLocked(project.path, (b) => ({ ...b, enabled: false }));
  } else {
    deps.setConfig({ ...deps.getConfig(), telegramEnabled: false });
  }
  deps.switchResolvedConfig(await readResolvedTelegramConfig(workspacePath));
  await deps.getPolling().stop();
  deps.clearStatusError();
  deps.refreshStatus();
  ui.notify(`Telegram bot disabled for current project.`, "info");
}

export async function unbindProjectFlow(
  ui: MenuUi,
  deps: TelegramCommandDeps,
  cwd: string,
  skipConfirm = false,
): Promise<void> {
  const workspacePath = resolve(cwd);
  const project = await readProjectBinding(workspacePath);
  if (!project) {
    ui.notify("Current project has no Telegram binding. It is using the default bot (if any).", "info");
    return;
  }
  if (!skipConfirm) {
    const confirmed = await ui.confirm(`Unbind project?`, `Remove Telegram project binding for ${project.path}?`);
    if (!confirmed) return;
  }
  await deps.getPolling().stop();
  deps.switchResolvedConfig(await unbindProjectTelegram(workspacePath));
  if (deps.isTelegramEnabled()) deps.getPolling().start();
  await deps.syncTelegramCommands();
  deps.refreshStatus();
  ui.notify(`Removed Telegram project binding:\n${escapeHtml(project.path)}\nProject now uses the default bot (if any).`, "info");
}
