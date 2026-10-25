/**
 * OMP dialogs that describe themselves through TSP must classify as dialogs
 * (§4.11.3). OMP's model picker and settings page carry `signal` /
 * `abortController` exactly like a loader does, so the loader rule in
 * `FocusTracker.classify` used to file them under "progress" - and the broker
 * opens no session for "progress", so `/model` and `/settings` reached Telegram
 * as nothing but a command receipt.
 */
import { describe, expect, it } from "vitest";
import { describesDialog } from "../tui/adapters/tsp.ts";
import { FocusTracker, type FocusKind } from "../tui/focus.ts";

/** OMP's model picker: keys, a render, a cancellation signal, a TSP description. */
function pickerLike(described: unknown) {
  return {
    abortController: new AbortController(),
    render: () => "",
    handleInput: () => undefined,
    describe: () => described,
    handleNativeEvent: () => undefined,
  };
}

const PICKER_TREE = { k: "picker", p: { title: "Model", items: [{ id: "a", label: "alpha" }] } };
const PREFS_TREE = { k: "prefs", p: { title: "Settings", sections: [{ id: "s", title: "General" }] } };
const OTHER_TREE = { k: "text", p: { t: "working" }, c: [{ k: "text", p: { t: "..." } }] };

/** OMP's login dialog: a `signal` like a loader's, a text field via TSP. */
function loginLike(described: unknown, opts: { handleNativeEvent?: boolean } = {}) {
  const component: Record<string, unknown> = {
    signal: new AbortController().signal,
    render: () => "",
    handleInput: () => undefined,
    describe: () => described,
  };
  if (opts.handleNativeEvent !== false) component.handleNativeEvent = () => undefined;
  return component;
}

const INPUT_TREE = { k: "box", p: {}, c: [{ k: "label", p: { t: "Paste your API key" } }, { k: "input", p: { placeholder: "sk-..." } }] };

/** A host UI the test drives directly, on the named host. */
function fakeHost(host: "pi" | "omp") {
  const editor = { render: () => "", handleInput: () => undefined };
  const ui: { focused: unknown; setFocus: (component: unknown) => void } = {
    focused: undefined,
    setFocus(component) { ui.focused = component; },
  };
  const tracker = new FocusTracker();
  // `attach` is private; drive it directly like the gateway tests do.
  const attached = tracker as unknown as { attach(state: unknown): void };
  attached.attach({ host, ui, editor, mode: {} });
  const kinds: FocusKind[] = [];
  tracker.onChange((info) => kinds.push(info.kind));
  return { tracker, ui, kinds };
}

describe("an OMP component that describes a picker or prefs page is a dialog", () => {
  it("classifies the picker that carries an abortController as a dialog", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(pickerLike(PICKER_TREE));
    expect(kinds.at(-1)).toBe("dialog");
  });

  it("classifies the settings page that carries an abortController as a dialog", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(pickerLike(PREFS_TREE));
    expect(kinds.at(-1)).toBe("dialog");
  });

  it("keeps a component whose description holds neither kind on progress", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(pickerLike(OTHER_TREE));
    expect(kinds.at(-1)).toBe("progress");
  });

  it("on the pi host an abortController still means progress, described picker or not", () => {
    const { ui, kinds } = fakeHost("pi");
    ui.setFocus(pickerLike(PICKER_TREE));
    expect(kinds.at(-1)).toBe("progress");
  });
});

describe("an OMP component that describes a text field is a dialog", () => {
  it("classifies the login dialog that carries a signal as a dialog", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(loginLike(INPUT_TREE));
    expect(kinds.at(-1)).toBe("dialog");
  });

  it("keeps a signal-carrying component with no input node on progress", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(loginLike(OTHER_TREE));
    expect(kinds.at(-1)).toBe("progress");
  });

  it("keeps an input description without handleNativeEvent on progress", () => {
    const { ui, kinds } = fakeHost("omp");
    ui.setFocus(loginLike(INPUT_TREE, { handleNativeEvent: false }));
    expect(kinds.at(-1)).toBe("progress");
  });

  it("on the pi host a described input still means progress", () => {
    const { ui, kinds } = fakeHost("pi");
    ui.setFocus(loginLike(INPUT_TREE));
    expect(kinds.at(-1)).toBe("progress");
  });
});

describe("describesDialog", () => {
  it("finds the kind in a nested component's own description", () => {
    const inner = pickerLike(PREFS_TREE);
    expect(describesDialog({ describe: () => ({ k: "box", p: {}, c: [inner] }), handleNativeEvent: () => undefined })).toBe(true);
  });

  it("accepts a described text field whose root routes events", () => {
    expect(describesDialog(loginLike(INPUT_TREE))).toBe(true);
  });

  it("is false for a describe that throws or a component that has none", () => {
    expect(describesDialog({ describe: () => { throw new Error("no tree"); }, handleNativeEvent: () => undefined })).toBe(false);
    expect(describesDialog({ render: () => "", handleInput: () => undefined })).toBe(false);
  });
});
