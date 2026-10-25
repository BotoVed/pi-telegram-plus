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
import { extensionInputAdapter, extensionSelectAdapter } from "../tui/adapters/extension.ts";
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

function fakeHost(options?: { confirmViaSelector?: boolean }): FakeHost {
  const seen = { signals: [] as AbortSignal[], handles: [] as (RaceHandle | undefined)[], opts: [] as unknown[] };
  const settle: Array<(value: unknown) => void> = [];
  const reject: Array<(error: unknown) => void> = [];
  /** Every dialog method has the same shape: the third argument carries `signal`. */
  const open = (opts?: { signal?: AbortSignal }): unknown => {
    seen.signals.push((opts?.signal ?? null) as AbortSignal);
    seen.handles.push(takePendingRace());
    seen.opts.push(opts);
    const { promise, resolve, reject: fail } = Promise.withResolvers<unknown>();
    settle.push(resolve);
    reject.push(fail);
    return promise;
  };
  const target: Record<string, unknown> = {
    select(_title: string, _options: string[], opts?: { signal?: AbortSignal }) {
      return open(opts);
    },
    confirm(title: string, _message: string, opts?: { signal?: AbortSignal }) {
      if (options?.confirmViaSelector) return (target.select as (...a: unknown[]) => unknown)(title, ["Yes", "No"], opts);
      return open(opts);
    },
    input(_title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) {
      return open(opts);
    },
  };
  return { target, seen, settle, reject };
}

/** Calls the wrapped `select` on a fake target with a usable signature. */
function callSelect(target: Record<string, unknown>) {
  return (title: string, options: string[], opts?: Record<string, unknown>): Promise<unknown> =>
    (target.select as (title: string, options: string[], opts?: Record<string, unknown>) => Promise<unknown>)(title, options, opts);
}

/** Calls the wrapped `confirm` on a fake target with a usable signature. */
function callConfirm(target: Record<string, unknown>) {
  return (title: string, message: string, opts?: Record<string, unknown>): Promise<unknown> =>
    (target.confirm as (title: string, message: string, opts?: Record<string, unknown>) => Promise<unknown>)(title, message, opts);
}

/** Calls the wrapped `input` on a fake target with a usable signature. */
function callInput(target: Record<string, unknown>) {
  return (title: string, placeholder?: string, opts?: Record<string, unknown>): Promise<unknown> =>
    (target.input as (title: string, placeholder?: string, opts?: Record<string, unknown>) => Promise<unknown>)(title, placeholder, opts);
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

  it("confirm: a plugin answer wins, a host answer wins when it is first", async () => {
    const { target, seen, settle } = fakeHost();
    expect(installRace(target, "confirm", new WeakSet<object>())).toBe(true);
    const pluginWins = callConfirm(target)("Sure?", "Delete it", {});
    expect(seen.handles[0]?.settled).toBe(false);
    expect(seen.handles[0]?.answer(true)).toBe(true);
    await expect(pluginWins).resolves.toBe(true);
    expect(seen.signals[0]?.aborted).toBe(true);
    // The terminal user answering first still wins: pi cancels with `false`.
    const hostWins = callConfirm(target)("Sure?", "Delete it", {});
    settle[1]?.(false);
    await expect(hostWins).resolves.toBe(false);
    expect(seen.handles[1]?.settled).toBe(true);
    expect(seen.handles[1]?.answer(true)).toBe(false);
    expect(seen.signals[1]?.aborted).toBe(false);
  });

  it("input: a plugin answer wins, a host answer wins when it is first", async () => {
    const { target, seen, settle } = fakeHost();
    expect(installRace(target, "input", new WeakSet<object>())).toBe(true);
    const pluginWins = callInput(target)("Name", "your name", {});
    expect(seen.handles[0]?.answer("hello")).toBe(true);
    await expect(pluginWins).resolves.toBe("hello");
    expect(seen.signals[0]?.aborted).toBe(true);
    // Cancelling an input is `undefined`, what the host would have returned.
    const hostWins = callInput(target)("Name", "your name", {});
    settle[1]?.(undefined);
    await expect(hostWins).resolves.toBeUndefined();
    expect(seen.handles[1]?.settled).toBe(true);
    expect(seen.handles[1]?.answer("late")).toBe(false);
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
    for (const method of ["select", "confirm", "input"] as const) {
      expect(installRace(target, method, tagged)).toBe(true);
      expect(installRace(target, method, tagged)).toBe(false);
      expect((target[method] as () => unknown).name).toBe(`ptp-race:${method}`);
    }
    callSelect(target)("Pick", ["alpha"], {});
    expect(seen.handles[0]).toBeDefined();
  });
});

describe("extensionSelectAdapter with a race handle", () => {
  function raceCtx(race: RaceHandle | undefined, kind: EntryInfo["kind"] = "select") {
    const sendKey = vi.fn(() => true);
    const entry: EntryInfo = { kind, source: "pi", title: "Pick", options: ["alpha", "beta"], race };
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

  it("confirm yes answers the extension call with true, without keys", () => {
    const { handle, answer } = live();
    const { ctx, sendKey } = raceCtx(handle, "confirm");
    expect(extensionSelectAdapter.act({}, { type: "confirm", yes: true }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith(true);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("confirm no answers with false", () => {
    const { handle, answer } = live();
    const { ctx, sendKey } = raceCtx(handle, "confirm");
    expect(extensionSelectAdapter.act({}, { type: "confirm", yes: false }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith(false);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("confirm cancel answers with false, the value pi's own cancel returns", () => {
    const { handle, answer } = live();
    const { ctx, sendKey } = raceCtx(handle, "confirm");
    expect(extensionSelectAdapter.act({}, { type: "cancel" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith(false);
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("a settled confirm handle never answers", () => {
    const answer = vi.fn(() => false);
    const { ctx } = raceCtx({ answer, settled: true }, "confirm");
    extensionSelectAdapter.act({}, { type: "confirm", yes: true }, ctx);
    expect(answer).not.toHaveBeenCalled();
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

describe("extensionInputAdapter with a race handle", () => {
  function inputCtx(race: RaceHandle | undefined) {
    const sendKey = vi.fn(() => true);
    const entry: EntryInfo = { kind: "input", source: "pi", title: "Name", placeholder: "your name", race };
    const ctx = { host: "pi", entry, sendKey, requestRender: vi.fn() } as AdapterContext;
    // A component the fallback *could* type into, so a stray keystroke path shows up.
    const handleInput = vi.fn();
    return { ctx, sendKey, handleInput, component: { getValue: () => "", handleInput } };
  }

  it("submit answers the extension call with the text, without typing", () => {
    const answer = vi.fn(() => true);
    const { ctx, sendKey, handleInput, component } = inputCtx({ answer, settled: false });
    expect(extensionInputAdapter.act(component, { type: "submit", text: "hello" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith("hello");
    expect(handleInput).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("an empty submit answers with the empty string", () => {
    const answer = vi.fn(() => true);
    const { ctx, sendKey, handleInput, component } = inputCtx({ answer, settled: false });
    expect(extensionInputAdapter.act(component, { type: "submit" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith("");
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("cancel answers with undefined, without keys", () => {
    const answer = vi.fn(() => true);
    const { ctx, sendKey, handleInput, component } = inputCtx({ answer, settled: false });
    expect(extensionInputAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(answer).toHaveBeenCalledWith(undefined);
    expect(handleInput).not.toHaveBeenCalled();
    expect(sendKey).not.toHaveBeenCalled();
  });

  it("a settled handle types into the field and presses Enter as before", () => {
    const answer = vi.fn(() => false);
    const { ctx, sendKey, handleInput, component } = inputCtx({ answer, settled: true });
    expect(extensionInputAdapter.act(component, { type: "submit", text: "hi" }, ctx)).toBe(true);
    expect(answer).not.toHaveBeenCalled();
    expect(handleInput).toHaveBeenCalled();
    expect(sendKey).toHaveBeenCalledWith("enter");
  });
});

describe("FocusTracker takes the pending race into the entry", () => {
  function wired(options?: { confirmViaSelector?: boolean }) {
    const tracker = new FocusTracker();
    const tagged = new WeakSet<object>();
    const fake = fakeHost(options);
    // The entry wrapper first, then the race wrapper on the outside - exactly
    // the order `attachEntryHooks` installs on the tool UI context.
    hookEntryMethods(fake.target, UI_CONTEXT_SPECS, {
      push: (info, nested) => tracker.pushEntry(info, nested),
      pop: (token) => tracker.popEntry(token),
      bind: (component, info) => tracker.bindEntry(component, info),
    }, "pi", tagged);
    for (const method of ["select", "confirm", "input"] as const) {
      expect(installRace(fake.target, method, tagged)).toBe(true);
    }
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

  it("pi's nested selector merges into the confirm entry that holds the handle", () => {
    const { tracker, fake } = wired({ confirmViaSelector: true });
    callConfirm(fake.target)("Sure?", "Delete it", {});
    const info = tracker.entryFor({});
    expect(info?.kind).toBe("confirm");
    // The inner selector enriched the outer entry instead of becoming its own.
    expect(info?.options).toEqual(["Yes", "No"]);
    // The handle on the entry is the outer confirm's: the inner select call has
    // one of its own, but a nested push never takes it, so it is dropped.
    expect(info?.race).toBeDefined();
    expect(info?.race).not.toBe(fake.seen.handles[1]);
    expect(info?.race?.answer(true)).toBe(true);
    expect((fake.target.confirm as () => unknown).name).toBe("ptp-race:confirm");
    expect(takePendingRace()).toBeUndefined();
  });
});
