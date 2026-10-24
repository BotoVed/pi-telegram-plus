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
import { hookEntryMethods, PI_ENTRY_SPECS } from "../tui/entry.ts";
import { FocusTracker } from "../tui/focus.ts";
import type { AdapterContext, EntryInfo } from "../tui/model.ts";

beforeAll(() => {
  host.initTheme("dark");
});

/** The sink `FocusTracker.attachEntryHooks` installs, rebuilt to drive one seam. */
function trackerSink(tracker: FocusTracker) {
  return {
    push: (info: EntryInfo) => tracker.pushEntry(info),
    pop: (pushed: boolean) => tracker.popEntry(pushed),
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
