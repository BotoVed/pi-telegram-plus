import { describe, expect, it, vi } from "vitest";
import { registerLifecycleCommands } from "../commands/lifecycle.ts";
import type { CommandRegistry } from "../commands/register.ts";

type HandlerEntry = {
  name: string;
  description?: string;
  handler: (args: string, ctx: {
    ui: { confirm: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
    shutdown: ReturnType<typeof vi.fn>;
  }) => Promise<void>;
};

function makeRegistry(): { registry: CommandRegistry; handlers: Map<string, HandlerEntry> } {
  const handlers = new Map<string, HandlerEntry>();
  return {
    handlers,
    registry: {
      registerCommand: (name, options) => {
        handlers.set(name, {
          name,
          description: options.description,
          handler: options.handler as HandlerEntry["handler"],
        });
      },
    },
  };
}

function makeCtx(confirmResult: boolean) {
  const confirm = vi.fn(async () => confirmResult);
  const notify = vi.fn();
  const shutdown = vi.fn();
  return { ctx: { ui: { confirm, notify }, shutdown }, confirm, notify, shutdown };
}

describe("registerLifecycleCommands /quit and /exit", () => {
  it("registers both names with the shutdown description", () => {
    const { registry, handlers } = makeRegistry();
    registerLifecycleCommands(registry);

    expect(handlers.get("quit")?.description).toBe("Shut down pi");
    expect(handlers.get("exit")?.description).toBe("Shut down pi");
  });

  for (const name of ["quit", "exit"] as const) {
    it(`/${name} shuts down after the Chinese confirmation`, async () => {
      const { registry, handlers } = makeRegistry();
      registerLifecycleCommands(registry);
      const { ctx, confirm, shutdown } = makeCtx(true);

      await handlers.get(name)!.handler("", ctx);

      expect(confirm).toHaveBeenCalledWith("退出 pi？", "确认后 pi 将退出，Telegram 也会停止响应。");
      expect(shutdown).toHaveBeenCalledTimes(1);
    });

    it(`/${name} does nothing when the confirmation is declined`, async () => {
      const { registry, handlers } = makeRegistry();
      registerLifecycleCommands(registry);
      const { ctx, confirm, notify, shutdown } = makeCtx(false);

      await handlers.get(name)!.handler("", ctx);

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(shutdown).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    });
  }
});
