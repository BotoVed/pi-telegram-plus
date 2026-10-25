import type { CommandRegistry } from "./register.ts";
import { checkpointCurrentUpdateCursor } from "../polling.ts";

/**
 * All command handlers capture ctx.ui at entry and use the captured reference.
 * ctx.ui is a getter that reads runner.uiContext, which resets to the TUI UI
 * after a session replacement; the captured reference keeps the TelegramUi
 * alive via its closure over chatId + transport.
 */
export function registerLifecycleCommands(registry: CommandRegistry): void {

  // ── /reload ────────────────────────────────────────────────────────────
  registry.registerCommand("reload", {
    description: "Reload extensions, skills, prompts, and themes",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      ui.notify("Reloading…", "info");
      // /reload re-activates the plugin in-process; commit this update first so
      // the replacement runtime does not re-fetch and re-run the unconfirmed
      // /reload (which would call ctx.reload() again).
      await checkpointCurrentUpdateCursor();
      await ctx.reload();
      return;
    },
  });

  // ── /stop ─────────────────────────────────────────────────────────────
  registry.registerCommand("stop", {
    description: "Stop the current agent turn",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      ctx.abort();
      ui.notify("⏹ Stopped.", "info");
    },
  });

  // ── /quit ──────────────────────────────────────────────────────────────
  registry.registerCommand("quit", {
    description: "Shut down pi",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const confirmed = await ui.confirm("Quit", "Shut down pi?");
      if (confirmed) {
        ctx.shutdown();
        ui.notify("Shutdown requested. If pi keeps running, stop it from the TUI/terminal.", "info");
      }
    },
  });

}