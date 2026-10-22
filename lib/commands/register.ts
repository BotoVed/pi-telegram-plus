import type { CapturedAgentSession, TelegramTransport, TelegramTurn } from "../types.ts";
import { registerModelCommands } from "./model.ts";
import { registerSessionCommands } from "./session.ts";
import { registerAuthCommands } from "./auth.ts";
import { registerInfoCommands } from "./info.ts";
import { registerLifecycleCommands } from "./lifecycle.ts";
import { registerSettingsCommands } from "./settings.ts";

export type CommandRegistry = {
  registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }) => void;
};

/** Minimal base deps — most commands only need session access. */
export type SessionDeps = {
  getSession: () => CapturedAgentSession | undefined;
};

/** Extended deps for session commands that also manage session names. */
export type SessionNameDeps = SessionDeps & {
  setSessionName: (name: string) => void;
  getSessionName: () => string | undefined;
};

/** Deps for the /tg Config submenu flows. */
export type TgConfigDeps = SessionDeps & {
  getConfig: () => import("../types.ts").TelegramConfig;
  setConfig: (c: import("../types.ts").TelegramConfig) => void;
  persistConfig: (c: import("../types.ts").TelegramConfig) => Promise<void>;
};

/** Optional deps for commands that need to send preformatted HTML directly. */
export type InfoDeps = {
  getTransport?: () => TelegramTransport | undefined;
  getActiveChatId?: () => number | undefined;
  getActiveTurn?: () => TelegramTurn | undefined;
};

export function registerAllCommands(
  registry: CommandRegistry,
  sessionDeps: SessionDeps,
  sessionNameDeps: SessionNameDeps,
  infoDeps?: InfoDeps,
): void {
  registerSettingsCommands(registry, sessionDeps);
  registerModelCommands(registry, sessionDeps);
  registerSessionCommands(registry, sessionNameDeps);
  registerAuthCommands(registry, sessionDeps);
  registerInfoCommands(registry, { ...sessionDeps, ...(infoDeps ?? {}) });
  registerLifecycleCommands(registry);
}