/**
 * The UI race (§4.12, decision 53): when an extension calls `ui.select`, the
 * host still draws its dialog, but a Telegram answer goes straight into the
 * extension's own call instead of steering the host component with keystrokes.
 * The wrapper races the plugin-side `RaceHandle` against the host's promise:
 * whoever answers first wins, and a Telegram win aborts the host dialog
 * through the `signal` handed to the original call (measured ~2 ms to close
 * on both hosts, S25).
 *
 * The wrapper goes on *outside* the entry wrapper (`entry.ts`): it registers
 * its handle before the entry wrapper runs, so `FocusTracker.pushEntry` can
 * attach it to the entry the very same call pushes.
 */

export type RaceHandle = {
  /** Answer from Telegram: the first call settles the race with `value`, aborts the host dialog and returns true; later calls return false. */
  answer(value: unknown): boolean;
  readonly settled: boolean;
};

/** The handle of the race call currently running synchronously. */
let pendingRace: RaceHandle | undefined;

/** Wrappers installed so far, so `installRace` never wraps the same function twice. */
const raced = new WeakSet<object>();

/**
 * Take the handle registered by the race wrapper whose host call is running
 * right now (the entry wrapper calls this while pushing), so a later
 * `takePendingRace` finds nothing. Cleared by the wrapper as soon as the host
 * method returns synchronously, whatever it returned.
 */
export function takePendingRace(): RaceHandle | undefined {
  const handle = pendingRace;
  pendingRace = undefined;
  return handle;
}

/**
 * Wrap `target[method]` in the race. Skips a function that is already a race
 * wrapper, so the per-tick `attachEntryHooks` stays idempotent. Both the old
 * function and the wrapper go into `tagged` so `hookEntryMethods` never
 * re-wraps the race back under an entry layer. Returns whether a new wrapper
 * was installed.
 */
export function installRace(
  target: Record<string, unknown>,
  method: "select",
  tagged: WeakSet<object>,
): boolean {
  const current = target[method];
  if (typeof current !== "function") return false;
  if (raced.has(current as object)) return false;
  const call = current as (...args: unknown[]) => unknown;
  const wrapped = function ptpRace(this: unknown, ...args: unknown[]): unknown {
    const controller = new AbortController();
    const opts = args[2] && typeof args[2] === "object" ? (args[2] as Record<string, unknown>) : undefined;
    const caller = opts?.signal;
    const signal = caller instanceof AbortSignal
      ? AbortSignal.any([caller, controller.signal])
      : controller.signal;
    const plugin = Promise.withResolvers<unknown>();
    let settled = false;
    const handle: RaceHandle = {
      get settled(): boolean { return settled; },
      answer(value: unknown): boolean {
        if (settled) return false;
        settled = true;
        plugin.resolve(value);
        controller.abort();
        return true;
      },
    };
    let result: unknown;
    pendingRace = handle;
    try {
      result = call.call(this, args[0], args[1], { ...(opts ?? {}), signal });
    } finally {
      pendingRace = undefined;
    }
    const host = Promise.resolve(result).then(
      (value) => { settled = true; return value; },
      (error: unknown) => { settled = true; throw error; },
    );
    // A plugin answer wins and the host's late `undefined` is dropped; a host
    // answer (or rejection) wins when the user was faster - errors keep
    // propagating to the extension exactly as they would without the race.
    return Promise.race([plugin.promise, host]);
  };
  Object.defineProperty(wrapped, "name", { value: "ptp-race:select" });
  raced.add(wrapped);
  tagged.add(current as object);
  tagged.add(wrapped);
  try {
    target[method] = wrapped;
  } catch {
    // Frozen host object: this dialog stays keystroke-driven.
    return false;
  }
  return true;
}
