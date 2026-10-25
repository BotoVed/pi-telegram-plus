/**
 * UI race tests (§4.12, decision 53).
 *
 * The race wrapper turns an extension's `ui.select` into a two-way contest:
 * the Telegram handle's `answer()` versus the host dialog's own promise.
 * These drive the wrapper against a fake host method that records the signal
 * it was handed and resolves only when the test says so - the point is which
 * side wins, whether the loser's signal aborts, and that the entry layer
 * still sees the call (`pushEntry` takes the handle before the host runs).
 */
import { describe, expect, it, vi } from "vitest";
import { installRace, takePendingRace, type RaceHandle } from "../tui/race.ts";
import { extensionSelectAdapter } from "../tui/adapters/extension.ts";
import { hookEntryMethods, UI_CONTEXT_SPECS } from "../tui/entry.ts";
import { FocusTracker } from "../tui/focus.ts";
import type { AdapterContext, EntryInfo } from "../tui/model.ts";

type FakeHost = {
  target: Record<string, unknown>;
  /** What the fake host method saw on each call. */
  seen: { signals: AbortSignal[]; handles: (RaceHandle | undefined)[]; opts: unknown[] };
  /** Settle the n-th dialog the way the terminal user would. */
  settle: Array<(value: unknown) => void>;
  reject: Array<(error: unknown) => void>;
};

function fakeHost(): FakeHost {
  const seen = { signals: [] as AbortSignal[], handles: [] as (RaceHandle | undefined)[], opts: [] as unknown[] };
  const settle: Array<(value: unknown) => void> = [];
  const reject: Array<(error: unknown) => void> = [];
  const target: Record<string, unknown> = {
    select(title: string, options: string[], opts?: { signal?: AbortSignal }) {
      seen.signals.push((opts?.signal ?? null) as AbortSignal);
      seen.handles.push(takePendingRace());
      seen.opts.push(opts);
      const { promise, resolve, reject: fail } = Promise.withResolvers<unknown>();
      settle.push(resolve);
      reject.push(fail);
      return promise;
    },
  };
  return { target, seen, settle, reject };
}

/** Calls the wrapped `select` on a fake target with a usable signature. */
function callSelect(target: Record<string, unknown>) {
  return (title: string, options: string[], opts?: Record<string, unknown>): Promise<unknown> =>
    (target.select as (title: string, options: string[], opts?: Record<string, unknown>) => Promise<unknown>)(title, options, opts);
}

describe("race wrapper (installRace)", () => {
  it("a plugin answer wins, aborts the host signal, and drops the host's late undefined", async () => {
    const { target, seen, settle } = fakeHost();
    expect(installRace(target, "select", new WeakSet<object>())).toBe(true);
    const dialog = callSelect(target)("Pick", ["alpha", "beta"], {});
    const handle = seen.handles[0];
    expect(handle).toBeDefined();
    expect(handle?.settled).toBe(false);
    expect(handle?.answer("beta")).toBe(true);
    await expect(dialog).resolves.toBe("beta");
    expect(seen.signals[0]?.aborted).toBe(true);
    // The host dialog closes ~2 ms later with `undefined`; that must not move the answer.
    settle[0]?.(undefined);
    await Promise.resolve();
    await expect(dialog).resolves.toBe("beta");
    expect(handle?.settled).toBe(true);
    expect(handle?.answer("alpha")).toBe(false);
  });

  it("a host answer wins first and later answers return false", async () => {
    const { target, seen, settle } = fakeHost();
    installRace(target, "select", new WeakSet<object>());
    const dialog = callSelect(target)("Pick", ["alpha", "beta"], {});
    const handle = seen.handles[0];
    settle[0]?.("alpha");
    await expect(dialog).resolves.toBe("alpha");
    expect(handle?.settled).toBe(true);
    expect(handle?.answer("beta")).toBe(false);
    expect(seen.signals[0]?.aborted).toBe(false);
  });

  it("a host rejection still reaches the extension", async () => {
    const { target, seen, reject } = fakeHost();
    installRace(target, "select", new WeakSet<object>());
    const dialog = callSelect(target)("Pick", ["alpha"], {});
    reject[0]?.(new Error("host died"));
    await expect(dialog).rejects.toThrow("host died");
    expect(seen.handles[0]?.settled).toBe(true);
  });

  it("the caller's own signal still aborts the signal the host receives", () => {
    const { target, seen } = fakeHost();
    installRace(target, "select", new WeakSet<object>());
    const caller = new AbortController();
    callSelect(target)("Pick", ["alpha"], { signal: caller.signal });
    expect(seen.signals[0]?.aborted).toBe(false);
    caller.abort();
    expect(seen.signals[0]?.aborted).toBe(true);
  });

  it("keeps the other option fields the caller passed", () => {
    const { target, seen } = fakeHost();
    installRace(target, "select", new WeakSet<object>());
    callSelect(target)("Pick", ["alpha"], { placeholder: "keep me" });
    const opts = seen.opts[0] as Record<string, unknown>;
    expect(opts?.placeholder).toBe("keep me");
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it("registers the handle for the host call's synchronous run only", () => {
    const { target, seen } = fakeHost();
    installRace(target, "select", new WeakSet<object>());
    callSelect(target)("Pick", ["alpha"], {});
    expect(seen.handles[0]).toBeInstanceOf(Object);
    expect(takePendingRace()).toBeUndefined();
  });

  it("installs once per function and stays identifiable by name", () => {
    const { target, seen } = fakeHost();
    const tagged = new WeakSet<object>();
    expect(installRace(target, "select", tagged)).toBe(true);
    expect(installRace(target, "select", tagged)).toBe(false);
    expect((target.select as () => unknown).name).toBe("ptp-race:select");
    callSelect(target)("Pick", ["alpha"], {});
    expect(seen.handles[0]).toBeDefined();
  });
});

describe("extensionSelectAdapter with a race handle", () => {
  function raceCtx(race: RaceHandle | undefined) {
    const sendKey = vi.fn(() => true);
    const entry: EntryInfo = { kind: "select", source: "pi", title: "Pick", options: ["alpha", "beta"], race };
    const ctx = { host: "pi", entry, sendKey, requestRender: vi.fn() } as AdapterContext;
    return { ctx, sendKey };
  }

  const live = (): { handle: RaceHandle; answer: (value: unknown) => boolean } => {
    const answer = vi.fn(() => true);
    return { handle: { answer, settled: false }, answer };
  };

  it("choose answers the extension call with the row's label, without keys", () => {
    const { handle, answer } = live();
    const { ctx, sendKey } = raceCtx(handle);
    expect(extensionSelectAdapter.act({}, { type: "choose", key: "1:beta" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith("beta");
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("cancel answers with undefined, without keys", () => {
    const { handle, answer } = live();
    const { ctx, sendKey } = raceCtx(handle);
    expect(extensionSelectAdapter.act({}, { type: "cancel" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith(undefined);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("an unknown row key answers nothing", () => {
    const { handle, answer } = live();
    const { ctx, sendKey } = raceCtx(handle);
    expect(extensionSelectAdapter.act({}, { type: "choose", key: "9:gone" }, ctx)).toBe(false);
    expect(answer).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("a settled handle falls back to the keystroke path", () => {
    const answer = vi.fn(() => false);
    const { ctx, sendKey } = raceCtx({ answer, settled: true });
    expect(extensionSelectAdapter.act({}, { type: "cancel" }, ctx)).toBe(true);
    expect(answer).not.toHaveBeenCalled();
    expect(sendKey).toHaveBeenCalledWith("esc");
  });
});

describe("FocusTracker takes the pending race into the entry", () => {
  function wired() {
    const tracker = new FocusTracker();
    const tagged = new WeakSet<object>();
    const fake = fakeHost();
    // The entry wrapper first, then the race wrapper on the outside - exactly
    // the order `attachEntryHooks` installs on the tool UI context.
    hookEntryMethods(fake.target, UI_CONTEXT_SPECS, {
      push: (info, nested) => tracker.pushEntry(info, nested),
      pop: (token) => tracker.popEntry(token),
      bind: (component, info) => tracker.bindEntry(component, info),
    }, "pi", tagged);
    expect(installRace(fake.target, "select", tagged)).toBe(true);
    return { tracker, fake, tagged };
  }

  it("a top-level select entry carries the handle the host method never saw", () => {
    const { tracker, fake } = wired();
    callSelect(fake.target)("Pick", ["alpha", "beta"], {});
    const info = tracker.entryFor({});
    expect(info?.kind).toBe("select");
    expect(info?.options).toEqual(["alpha", "beta"]);
    expect(info?.race).toBeDefined();
    // pushEntry took the handle before the host method ran, so the host's own
    // takePendingRace finds nothing, and a later one does too.
    expect(fake.seen.handles[0]).toBeUndefined();
    expect(takePendingRace()).toBeUndefined();
    // The outermost wrapper is the race: entry hooks must not re-wrap it.
    expect((fake.target.select as () => unknown).name).toBe("ptp-race:select");
    expect(info?.race?.answer("beta")).toBe(true);
  });

  it("a nested select leaves the handle to nothing and the entry race-free", () => {
    const { tracker, fake, tagged } = wired();
    // pi's confirm draws through the selector: a select call inside a confirm call.
    fake.target.confirm = (title: string) => (fake.target.select as (...a: unknown[]) => unknown)(title, ["Yes", "No"]);
    hookEntryMethods(fake.target, UI_CONTEXT_SPECS, {
      push: (info, nested) => tracker.pushEntry(info, nested),
      pop: (token) => tracker.popEntry(token),
      bind: (component, info) => tracker.bindEntry(component, info),
    }, "pi", tagged);
    (fake.target.confirm as (title: string) => unknown)("Sure?");
    const info = tracker.entryFor({});
    expect(info?.kind).toBe("confirm");
    expect(info?.race).toBeUndefined();
    expect(takePendingRace()).toBeUndefined();
  });
});
