/**
 * Entry-hook association tests (§4.1.2).
 *
 * An entry call has to leave its meaning attached to the component the host just
 * built. The pending entry is popped the moment the call returns - pi's `show*`
 * methods return a promise that settles only when the user answers - so a dialog
 * whose focus the tracker notices on a later tick would otherwise reach the
 * adapters with no entry at all and fall back to a snapshot of arrow keys.
 *
 * The dialog here is pi's real component; only the mode that builds it is faked.
 */
import { beforeAll, describe, expect, it } from "vitest";
import * as host from "@earendil-works/pi-coding-agent";
import { pickAdapter } from "../tui/adapters/index.ts";
import { extensionInputAdapter } from "../tui/adapters/extension.ts";
import { entryFromCall, hookEntryMethods, OMP_ENTRY_SPECS, PI_ENTRY_SPECS } from "../tui/entry.ts";
import { FocusTracker } from "../tui/focus.ts";
import type { AdapterContext, EntryInfo } from "../tui/model.ts";

beforeAll(() => {
  host.initTheme("dark");
});

/** The sink `FocusTracker.attachEntryHooks` installs, rebuilt to drive one seam. */
function trackerSink(tracker: FocusTracker) {
  return {
    push: (info: EntryInfo, nested: boolean) => tracker.pushEntry(info, nested),
    pop: (token: object | undefined) => tracker.popEntry(token),
    bind: (component: object, info: EntryInfo) => tracker.bindEntry(component, info),
  };
}

/** A host mode that builds its input the way pi does: assign the field, resolve later. */
class FakeMode {
  extensionInput: unknown = undefined;

  showExtensionInput(title: string, placeholder?: string): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
      this.extensionInput = new host.ExtensionInputComponent(
        title,
        placeholder ?? "",
        (value: string) => resolve(value),
        () => resolve(undefined),
      );
    });
  }
}

function context(entry?: EntryInfo): AdapterContext {
  return { host: "pi", entry, sendKey: () => true, requestRender: () => {} };
}

describe("entry hooks record the dialog on the component (§4.1.2)", () => {
  it("keeps the input entry readable after the call has returned", () => {
    const tracker = new FocusTracker();
    const mode = new FakeMode();
    hookEntryMethods(
      mode as unknown as Record<string, unknown>,
      PI_ENTRY_SPECS,
      trackerSink(tracker),
      "pi",
      new WeakSet<object>(),
    );

    // The promise stays pending: this is exactly the window a mirrored dialog lives in.
    void mode.showExtensionInput("Bot name", "unique label");
    const component = mode.extensionInput as Record<string, unknown>;

    expect(component).toBeInstanceOf(host.ExtensionInputComponent);
    expect(tracker.entryFor(component)).toMatchObject({ kind: "input", title: "Bot name" });
    expect(pickAdapter(component, context(tracker.entryFor(component)))?.id).toBe("ext-input");
  });
});

describe("an entry lives as long as the host's dialog (§4.1.2)", () => {
  it("stays readable after the call returns and is retired when the dialog resolves", async () => {
    const tracker = new FocusTracker();
    let resolve!: (value: string) => void;
    const mode: Record<string, unknown> = {
      // OMP's shape: the call returns at once, focus lands on a later tick.
      showExtensionInput: () => new Promise<string>((done) => { resolve = done; }),
    };
    hookEntryMethods(
      mode,
      PI_ENTRY_SPECS.filter((spec) => spec.method === "showExtensionInput"),
      trackerSink(tracker),
      "pi",
      new WeakSet<object>(),
    );

    const dialog = mode.showExtensionInput as () => Promise<string>;
    const resolving = dialog();
    const focusedLater = { render: () => "", handleInput: () => {} };

    expect(tracker.entryFor(focusedLater)).toMatchObject({ kind: "input" });

    resolve("done");
    await resolving;

    expect(tracker.entryFor({ render: () => "", handleInput: () => {} })).toBeUndefined();
  });
});

describe("the overlay wrapper holding the dialog answers for it (§4.1.2)", () => {
  const entry = { kind: "select", title: "Pick env", options: ["dev", "prod"], source: "omp", method: "select" } as EntryInfo;

  it("passes the entry down to a wrapper that takes focus next", () => {
    const tracker = new FocusTracker();
    const record = tracker.pushEntry(entry, false);
    const dialog = { render: () => "", handleInput: () => undefined };
    expect(tracker.entryFor(dialog)).toMatchObject({ kind: "select" });

    // OMP hands focus to the overlay wrapper a beat after the dialog inside it has
    // claimed the entry, and the wrapper is what receives the keys from then on.
    const wrapper = { children: [dialog], render: () => "", handleInput: () => undefined };
    expect(tracker.entryFor(wrapper)).toMatchObject({ kind: "select" });

    // Something else that takes focus meanwhile - a loader beside the dialog - is not
    // the thing being asked about, and must not be able to claim it.
    const loader = { children: [{}, {}], signal: {}, render: () => "", handleInput: () => undefined };
    expect(tracker.entryFor(loader)).toBeUndefined();

    tracker.popEntry(record);
  });
});

describe("input adapter reads the entry as the authority", () => {
  const entry = { kind: "input", title: "Retry count (0-10)", source: "pi" } as EntryInfo;

  it("claims an input dialog whose field is not built yet", () => {
    expect(extensionInputAdapter.detect({}, context(entry))).toBe(true);
    expect(extensionInputAdapter.read({}, context(entry))).toMatchObject({ kind: "input", title: "Retry count (0-10)" });
  });

  it("leaves dialogs of another kind to their own adapters", () => {
    const select = { kind: "select", title: "Pick env", options: ["dev"], source: "pi" } as EntryInfo;
    expect(extensionInputAdapter.detect({}, context(select))).toBe(false);
    expect(extensionInputAdapter.detect({}, context(undefined))).toBe(false);
  });
});

describe("OMP read-only panels are recorded as panel entries (§4.6.5 #12)", () => {
  const panelEntry = (method: string, args: unknown[]): EntryInfo | undefined => {
    const spec = OMP_ENTRY_SPECS.find((candidate) => candidate.method === method);
    expect(spec).toBeDefined();
    return entryFromCall(spec!, args, "omp");
  };

  it("keeps the title showCommandReport carries", () => {
    const info = panelEntry("showCommandReport", [{ title: "MCP Server Management", body: {} }]);
    expect(info).toMatchObject({ kind: "panel", title: "MCP Server Management", method: "showCommandReport" });
  });

  it("still records the panel when showCommandReport sends no title", () => {
    const info = panelEntry("showCommandReport", [{ body: {} }]);
    expect(info?.kind).toBe("panel");
    expect(info?.title).toBeUndefined();
  });

  it("names the panels that take no title argument", () => {
    expect(panelEntry("showUsageDashboard", [[]])).toMatchObject({ kind: "panel", title: "Usage" });
    expect(panelEntry("showDebugSelector", [])).toMatchObject({ kind: "panel", title: "Debug" });
    expect(panelEntry("showExtensionsDashboard", [])).toMatchObject({ kind: "panel", title: "Extensions" });
    expect(panelEntry("showAgentsDashboard", [])).toMatchObject({ kind: "panel", title: "Agents" });
  });
});
