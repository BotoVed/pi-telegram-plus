/**
 * The TSP picker adapter reads OMP components through `describe` and answers
 * through `handleNativeEvent` (§4.11.3): no screen parsing, no keys. What
 * these tests pin is the keypath computation (reconcile.ts rules: keyed child
 * → its key, unkeyed child → its index, component boundary → restart at "")
 * and the props-to-model mapping, since both are the adapter's whole contract
 * with the host.
 * The prefs tests pin the settings-page mapping and the §4.12 race hand-off.
 */
import { describe, expect, it } from "vitest";
import { findPicker, tspPickerAdapter, tspPrefsAdapter } from "../tui/adapters/tsp.ts";
import type { AdapterContext, DialogModel } from "../tui/model.ts";

type Node = { k: string; p?: unknown; c?: unknown[]; key?: string };

function ctxFor(host: "pi" | "omp" = "omp"): AdapterContext {
  return { host, sendKey: () => true, requestRender: () => undefined };
}

function racedCtx(host: "pi" | "omp" = "omp"): AdapterContext {
  return {
    host,
    entry: { kind: "select", source: host, race: { answer: () => true, settled: false } },
    sendKey: () => true,
    requestRender: () => undefined,
  };
}

/** ctx whose requestRender is counted: 3E pins that act asks the terminal to
 * repaint after a native event lands (the host does not tick its UI itself). */
function countingCtx(host: "pi" | "omp" = "omp") {
  let renders = 0;
  const ctx: AdapterContext = { host, sendKey: () => true, requestRender: () => { renders += 1; } };
  return { ctx, renders: () => renders };
}

function makeComponent(tree: unknown, opts: { throws?: boolean } = {}) {
  const events: unknown[] = [];
  return {
    events,
    describe: () => {
      if (opts.throws) throw new Error("describe blew up");
      return tree;
    },
    handleNativeEvent: (event: unknown) => {
      events.push(event);
    },
  };
}

const pickerProps = {
  title: "Models",
  items: [
    { id: "a", label: "alpha" },
    { id: "b", label: [{ t: "be" }, { t: "ta" }], detail: "the {t} one" },
  ],
  selected: "b",
  current: ["a"],
};

const prefsProps = {
  title: "Settings",
  pages: [
    { id: "general", label: "General" },
    { id: "models", label: "Models" },
    { id: "keys", label: "Keys", disabled: "Terminal required" },
  ],
  page: "models",
  sections: [
    {
      id: "s1",
      title: "Inference",
      rows: [
        { id: "think", label: "Thinking", control: { k: "switch", on: true } },
        { id: "off", label: "Off item", disabled: "Locked", control: { k: "switch", on: false } },
      ],
    },
    {
      id: "s2",
      title: "Appearance",
      rows: [
        {
          id: "theme",
          label: "Theme",
          control: { k: "choice", value: "dark", options: [{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }] },
        },
        { id: "width", label: "Width", control: { k: "number", value: 80 } },
      ],
    },
  ],
};

const asSelect = (model: DialogModel) => (model.kind === "select" ? model : expect.fail(`not a select: ${model.kind}`));

const asSettings = (model: DialogModel) => (model.kind === "settings" ? model : expect.fail(`not settings: ${model.kind}`));

const asInfo = (model: DialogModel) => (model.kind === "info" ? model : expect.fail(`not info: ${model.kind}`));

describe("tsp picker keypath", () => {
  it("uses the empty keypath when the component's root node is the picker", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    const found = findPicker(component);
    expect(found?.keypath).toBe("");
    expect(found?.owner).toBe(component);
  });

  it("uses the child's key when the picker sits in a keyed slot", () => {
    const component = makeComponent({ k: "frame", c: [{ k: "text" }, { key: "picker", k: "picker", p: pickerProps }] });
    expect(findPicker(component)?.keypath).toBe("picker");
  });

  it("uses the child's index when the picker slot has no key", () => {
    const component = makeComponent({ k: "frame", c: [{ k: "text" }, { k: "picker", p: pickerProps }] });
    expect(findPicker(component)?.keypath).toBe("1");
  });

  it("restarts the keypath at the child component's root and hands events to it", () => {
    const inner = makeComponent({ k: "layer", c: [{ key: "picker", k: "picker", p: pickerProps }] });
    const outer = makeComponent({ k: "dock", c: [{ k: "text" }, inner] });
    const found = findPicker(outer);
    expect(found?.owner).toBe(inner);
    expect(found?.keypath).toBe("picker");
    expect(tspPickerAdapter.act(outer, { type: "choose", key: "a" }, ctxFor())).toBe(true);
    expect(inner.events).toEqual([{ type: "activate", key: "picker", item: "a" }]);
    expect(outer.events).toEqual([]);
  });

  it("declines when describe throws", () => {
    const component = makeComponent(null, { throws: true });
    expect(tspPickerAdapter.detect(component, ctxFor())).toBe(false);
  });

  it("declines on the pi host even for a describable picker", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    expect(tspPickerAdapter.detect(component, ctxFor("pi"))).toBe(false);
  });
});

describe("tsp picker read", () => {
  it("follows order, dropping ids absent from items and group headers", () => {
    const props = {
      items: [
        { id: "a", label: "alpha" },
        { id: "b", label: "beta" },
        { id: "c", label: "gamma" },
      ],
      order: ["c", "gone", { group: "g", label: "Group" }, "a"],
    };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor()));
    expect(model.items.map((item) => item.key)).toEqual(["c", "a"]);
  });

  it("flattens span text and maps selected/current onto the rows", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    const model = asSelect(tspPickerAdapter.read(component, ctxFor()));
    expect(model.title).toBe("Models");
    expect(model.total).toBe(2);
    expect(model.items).toEqual([
      { key: "a", label: "alpha", current: true, focused: false },
      { key: "b", label: "beta", description: "the {t} one", current: false, focused: true },
    ]);
  });

  it("skips disabled rows and defaults the title", () => {
    const props = {
      items: [
        { id: "a", label: "alpha", disabled: "needs a key" },
        { id: "b", label: "beta", disabled: true },
        { id: "c", label: "gamma" },
      ],
    };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor()));
    expect(model.title).toBe("Select");
    expect(model.items.map((item) => item.key)).toEqual(["c"]);
    expect(model.total).toBe(1);
  });

  it("follows an open action strip instead of the list", () => {
    const props = {
      title: "Models",
      items: [{ id: "m", label: "mock/mock-model" }],
      strip: {
        label: "Purpose mock/mock-model",
        items: [
          { id: "default", label: "default" },
          { id: "small", label: [{ t: "small " }, { t: "model" }], on: true },
          { id: "plan", label: "plan", on: false },
        ],
        selected: "small",
      },
    };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor()));
    expect(model.title).toBe("Purpose mock/mock-model");
    expect(model.total).toBe(3);
    expect(model.items).toEqual([
      { key: "strip:0", label: "default", current: false, focused: false },
      { key: "strip:1", label: "small model", current: true, focused: true },
      { key: "strip:2", label: "plan", current: false, focused: false },
    ]);
  });

  it("defaults the strip title and treats a chip-less or null strip as none", () => {
    const noLabel = { items: [{ id: "a", label: "alpha" }], strip: { items: [{ id: "x", label: "x" }] } };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: noLabel }), ctxFor()));
    expect(model.title).toBe("Choose a role");
    expect(model.items[0]?.focused).toBe(false);
    // The name-entry strip has no chips: the list stays visible.
    const nameStrip = { ...pickerProps, strip: { label: "Name", items: [] } };
    const list = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: nameStrip }), ctxFor()));
    expect(list.title).toBe("Models");
    expect(list.items.map((item) => item.key)).toEqual(["a", "b"]);
    const nulled = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: { ...pickerProps, strip: null } }), ctxFor()));
    expect(nulled.title).toBe("Models");
  });

  it("shows the picker's empty text as a closable info model when no item is visible", () => {
    const component = makeComponent({ k: "picker", p: { title: "Agents", items: [], empty: "No agents are running." } });
    const model = asInfo(tspPickerAdapter.read(component, ctxFor()));
    expect(model).toEqual({ kind: "info", title: "Agents", text: "No agents are running.", closable: true });
    // A list that is only disabled rows is invisible too.
    const disabled = asInfo(tspPickerAdapter.read(makeComponent({ k: "picker", p: { items: [{ id: "a", label: "a", disabled: true }] } }), ctxFor()));
    expect(disabled.text).toBe("Nothing to show");
  });

  it("prefers empty over message, flattens span text, and keeps a non-empty list a select", () => {
    const both = asInfo(tspPickerAdapter.read(makeComponent({ k: "picker", p: { items: [], empty: "Empty wins", message: "M" } }), ctxFor()));
    expect(both.text).toBe("Empty wins");
    const viaMessage = asInfo(tspPickerAdapter.read(makeComponent({ k: "picker", p: { items: [], message: [{ t: "No " }, { t: "agents" }] } }), ctxFor()));
    expect(viaMessage.text).toBe("No agents");
    expect(viaMessage.title).toBe("Select");
    const list = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: pickerProps }), ctxFor()));
    expect(list.kind).toBe("select");
  });
});

describe("tsp picker act", () => {
  it("answers choose with an activate event on the picker's keypath", () => {
    const component = makeComponent({ k: "frame", c: [{ key: "picker", k: "picker", p: pickerProps }] });
    expect(tspPickerAdapter.act(component, { type: "choose", key: "b" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "activate", key: "picker", item: "b" }]);
  });

  it("refuses an id that is no longer in the list", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    expect(tspPickerAdapter.act(component, { type: "choose", key: "zzz" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("answers cancel with a close action", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    expect(tspPickerAdapter.act(component, { type: "cancel" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "", act: "close", mods: [] }]);
  });

  it("refuses actions the picker protocol has no shape for", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    expect(tspPickerAdapter.act(component, { type: "submit", text: "x" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("re-reads the tree on every action instead of trusting a stale one", () => {
    let tree: unknown = { k: "picker", p: pickerProps };
    const component = makeComponent(null);
    component.describe = () => tree;
    expect(tspPickerAdapter.act(component, { type: "choose", key: "a" }, ctxFor())).toBe(true);
    tree = { k: "text" };
    expect(tspPickerAdapter.act(component, { type: "cancel" }, ctxFor())).toBe(false);
  });

  it("reports failure when the host rejects the event", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    component.handleNativeEvent = () => {
      throw new Error("not interactive");
    };
    expect(tspPickerAdapter.act(component, { type: "cancel" }, ctxFor())).toBe(false);
  });

  it("answers a strip choice with a strip action carrying the chip index", () => {
    const props = {
      ...pickerProps,
      strip: { items: [{ id: "default", label: "default" }, { id: "small", label: "small" }] },
    };
    const component = makeComponent({ k: "frame", c: [{ key: "picker", k: "picker", p: props }] });
    expect(tspPickerAdapter.act(component, { type: "choose", key: "strip:1" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "picker", act: "strip", value: "1", mods: [] }]);
  });

  it("refuses a strip index the host no longer offers", () => {
    const props = { ...pickerProps, strip: { items: [{ id: "default", label: "default" }] } };
    const component = makeComponent({ k: "picker", p: props });
    expect(tspPickerAdapter.act(component, { type: "choose", key: "strip:1" }, ctxFor())).toBe(false);
    expect(tspPickerAdapter.act(component, { type: "choose", key: "strip:" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("still activates plain ids while a strip is open", () => {
    const props = { ...pickerProps, strip: { items: [{ id: "default", label: "default" }] } };
    const component = makeComponent({ k: "picker", p: props });
    expect(tspPickerAdapter.act(component, { type: "choose", key: "b" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "activate", key: "", item: "b" }]);
  });

  it("asks the host to redraw after a native event lands, never after a refused one", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    const ctx = countingCtx();
    expect(tspPickerAdapter.act(component, { type: "choose", key: "zzz" }, ctx.ctx)).toBe(false);
    expect(ctx.renders()).toBe(0);
    expect(tspPickerAdapter.act(component, { type: "choose", key: "a" }, ctx.ctx)).toBe(true);
    expect(ctx.renders()).toBe(1);
  });

  it("still reports success when the redraw request throws", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    const ctx: AdapterContext = { host: "omp", sendKey: () => true, requestRender: () => { throw new Error("no renderer"); } };
    expect(tspPickerAdapter.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "", act: "close", mods: [] }]);
  });
});

describe("tsp picker tabs, scopes and action bar", () => {
  const treeProps = {
    title: "Tree",
    items: [{ id: "m1", label: "msg one" }],
    tabs: [
      { id: "default", label: "Default" },
      { id: "no-tools", label: [{ t: "No " }, { t: "tools" }] },
      { id: "all", label: "All" },
    ],
    tab: "no-tools",
  };

  it("turns tabs into extra actions with the active one marked", () => {
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: treeProps }), ctxFor()));
    expect(model.extraActions).toEqual([
      { label: "Default", key: "tab:0" },
      { label: "● No tools", key: "tab:1" },
      { label: "All", key: "tab:2" },
    ]);
  });

  it("answers a tab key with a tab action carrying the entry's id", () => {
    const component = makeComponent({ k: "frame", c: [{ key: "picker", k: "picker", p: treeProps }] });
    expect(tspPickerAdapter.act(component, { type: "key", name: "tab:1" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "picker", act: "tab", value: "no-tools", mods: [] }]);
  });

  it("refuses a tab index the host no longer offers", () => {
    const component = makeComponent({ k: "picker", p: treeProps });
    expect(tspPickerAdapter.act(component, { type: "key", name: "tab:3" }, ctxFor())).toBe(false);
    expect(tspPickerAdapter.act(component, { type: "key", name: "tab:" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("marks the active scope, skips disabled entries and answers scope keys", () => {
    const scopes = [
      { id: "cur", label: "Current" },
      { id: "sub", label: "Subtree", disabled: "terminal only" },
      { id: "all", label: "All" },
    ];
    const props = { title: "Tree", items: [{ id: "m1", label: "msg one" }], scopes, scope: "all" };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor()));
    expect(model.extraActions).toEqual([
      { label: "Current", key: "scope:0" },
      { label: "● All", key: "scope:2" },
    ]);
    const component = makeComponent({ k: "picker", p: props });
    expect(tspPickerAdapter.act(component, { type: "key", name: "scope:2" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "", act: "scope", value: "all", mods: [] }]);
    // An entry disabled since the draw: the press is refused.
    const turnedOff = makeComponent({
      k: "picker",
      p: { ...props, scopes: [scopes[0], scopes[1], { id: "all", label: "All", disabled: true }] },
    });
    expect(tspPickerAdapter.act(turnedOff, { type: "key", name: "scope:2" }, ctxFor())).toBe(false);
    expect(turnedOff.events).toEqual([]);
  });

  it("turns action-bar entries into keys, hiding close, cancel and disabled", () => {
    const props = {
      title: "Tree",
      items: [{ id: "m1", label: "msg one" }],
      actions: [
        { id: "switch", label: "Switch" },
        { id: "summarize", label: [{ t: "Summarize & " }, { t: "switch" }] },
        { id: "label", label: "Label", disabled: "no label key" },
        { id: "cancel", label: "Cancel" },
        { id: "close", label: "Close" },
      ],
    };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor()));
    expect(model.extraActions).toEqual([
      { label: "Switch", key: "act:0" },
      { label: "Summarize & switch", key: "act:1" },
    ]);
    const component = makeComponent({ k: "picker", p: props });
    expect(tspPickerAdapter.act(component, { type: "key", name: "act:0" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "", act: "switch", mods: [] }]);
    // Disabled entries and the hidden close/cancel ids are refused on act too.
    expect(tspPickerAdapter.act(component, { type: "key", name: "act:2" }, ctxFor())).toBe(false);
    expect(tspPickerAdapter.act(component, { type: "key", name: "act:3" }, ctxFor())).toBe(false);
    expect(tspPickerAdapter.act(component, { type: "key", name: "act:4" }, ctxFor())).toBe(false);
    expect(component.events).toHaveLength(1);
  });
});

describe("tsp picker search", () => {
  /** A picker component whose own input box records every delivered chunk. */
  function typingComponent(props: unknown) {
    const keys: string[] = [];
    return {
      keys,
      describe: () => ({ k: "picker", p: props }),
      handleNativeEvent: () => undefined,
      handleInput: (data: string) => {
        keys.push(data);
      },
    };
  }

  it("advertises the search box and types the query into the picker input", () => {
    const component = typingComponent({ title: "Tree", items: [{ id: "a", label: "a" }], query: "" });
    const model = asSelect(tspPickerAdapter.read(component, ctxFor()));
    expect(model.search).toEqual({ query: "" });
    expect(tspPickerAdapter.act(component, { type: "search", query: "abc" }, ctxFor())).toBe(true);
    expect(component.keys).toEqual(["\x15", "a", "b", "c"]);
  });

  it("keeps search absent without a query, and refuses typing without an input", () => {
    const model = asSelect(
      tspPickerAdapter.read(makeComponent({ k: "picker", p: { items: [{ id: "a", label: "a" }], query: null } }), ctxFor()),
    );
    expect(model.search).toBeUndefined();
    const mute = makeComponent({ k: "picker", p: { items: [{ id: "a", label: "a" }], query: "" } });
    expect(tspPickerAdapter.act(mute, { type: "search", query: "x" }, ctxFor())).toBe(false);
  });
});

describe("tsp picker empty state with controls", () => {
  it("keeps tabs as buttons over an empty list, empty text in the title", () => {
    const props = {
      title: "Tree",
      items: [],
      empty: [{ t: "2 entries " }, { t: "hidden by the filter" }],
      tabs: [{ id: "default", label: "Default" }, { id: "all", label: "All" }],
      tab: "default",
    };
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: props }), ctxFor()));
    expect(model.title).toBe("Tree — 2 entries hidden by the filter");
    expect(model.items).toEqual([]);
    expect(model.total).toBe(0);
    expect(model.extraActions).toEqual([
      { label: "● Default", key: "tab:0" },
      { label: "All", key: "tab:1" },
    ]);
  });

  it("keeps a search-only empty picker a select with its search box", () => {
    const model = asSelect(tspPickerAdapter.read(makeComponent({ k: "picker", p: { items: [], query: "abc" } }), ctxFor()));
    expect(model.search).toEqual({ query: "abc" });
    expect(model.items).toEqual([]);
  });

  it("stays info when an empty list has no tabs, scopes, actions or search", () => {
    const model = asInfo(
      tspPickerAdapter.read(makeComponent({ k: "picker", p: { title: "Agents", items: [], empty: "No agents." } }), ctxFor()),
    );
    expect(model).toEqual({ kind: "info", title: "Agents", text: "No agents.", closable: true });
  });
});

describe("tsp race hand-off (§4.12)", () => {
  it("declines a picker while the extension dialog race is live", () => {
    const component = makeComponent({ k: "picker", p: pickerProps });
    expect(tspPickerAdapter.detect(component, racedCtx())).toBe(false);
  });

  it("declines a prefs page while the race is live", () => {
    const component = makeComponent({ k: "prefs", p: prefsProps });
    expect(tspPrefsAdapter.detect(component, racedCtx())).toBe(false);
  });

  it("still detects when the entry carries no race", () => {
    const ctx: AdapterContext = {
      ...ctxFor(),
      entry: { kind: "select", source: "omp" },
    };
    expect(tspPrefsAdapter.detect(makeComponent({ k: "prefs", p: prefsProps }), ctx)).toBe(true);
  });
});

describe("tsp prefs read", () => {
  it("maps pages, switches, choices and read-only controls onto the settings model", () => {
    const component = makeComponent({ k: "frame", c: [{ key: "prefs", k: "prefs", p: prefsProps }] });
    expect(tspPrefsAdapter.detect(component, ctxFor())).toBe(true);
    const model = asSettings(tspPrefsAdapter.read(component, ctxFor()));
    expect(model.title).toBe("Settings");
    // The current page and every disabled page/row is left out.
    expect(model.items).toEqual([
      { key: "page:general", label: "📄 General", hasSubmenu: true },
      { key: "think", label: "Thinking", value: "On", values: ["On", "Off"] },
      { key: "theme", label: "Theme", value: "Dark", values: ["Dark", "Light"] },
      { key: "width", label: "Width", value: "(change it in the terminal)" },
    ]);
  });
});

describe("tsp prefs act", () => {
  it("answers a page submenu with a page action on the prefs keypath", () => {
    const component = makeComponent({ k: "frame", c: [{ key: "body", k: "prefs", p: prefsProps }] });
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "page:general" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "body", act: "page", value: "general", mods: [] }]);
  });

  it("refuses a page that is gone or disabled", () => {
    const component = makeComponent({ k: "prefs", p: prefsProps });
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "page:keys" }, ctxFor())).toBe(false);
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "page:nope" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("answers a switch cycle with the requested boolean change", () => {
    const component = makeComponent({ k: "prefs", p: prefsProps });
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "think", value: "On" }, ctxFor())).toBe(true);
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "think", value: "Off" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([
      { type: "change", key: "", item: "think", value: true },
      { type: "change", key: "", item: "think", value: false },
    ]);
  });

  it("flips a switch when no value is given", () => {
    const component = makeComponent({ k: "prefs", p: prefsProps });
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "think" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "change", key: "", item: "think", value: false }]);
  });

  it("maps a choice label back onto its option value", () => {
    const component = makeComponent({ k: "prefs", p: prefsProps });
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "theme", value: "Light" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "change", key: "", item: "theme", value: "light" }]);
  });

  it("cycles to the next option when no value is given", () => {
    const component = makeComponent({ k: "prefs", p: prefsProps });
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "theme" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "change", key: "", item: "theme", value: "light" }]);
  });

  it("answers cancel with a close action that carries no value", () => {
    const component = makeComponent({ k: "prefs", p: prefsProps });
    expect(tspPrefsAdapter.act(component, { type: "cancel" }, ctxFor())).toBe(true);
    expect(component.events).toEqual([{ type: "action", key: "", act: "close", mods: [] }]);
  });

  it("refuses rows the page does not have and values it cannot map", () => {
    const component = makeComponent({ k: "prefs", p: prefsProps });
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "gone" }, ctxFor())).toBe(false);
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "width" }, ctxFor())).toBe(false);
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "think", value: "Maybe" }, ctxFor())).toBe(false);
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "theme", value: "Purple" }, ctxFor())).toBe(false);
    expect(tspPrefsAdapter.act(component, { type: "submit", text: "x" }, ctxFor())).toBe(false);
    expect(component.events).toEqual([]);
  });

  it("re-reads the tree on every action instead of trusting a stale one", () => {
    let tree: unknown = { k: "prefs", p: prefsProps };
    const component = makeComponent(null);
    component.describe = () => tree;
    expect(tspPrefsAdapter.act(component, { type: "cycle", key: "think", value: "Off" }, ctxFor())).toBe(true);
    tree = { k: "text" };
    expect(tspPrefsAdapter.act(component, { type: "cancel" }, ctxFor())).toBe(false);
  });

  it("asks the host to redraw after a page switch lands", () => {
    const component = makeComponent({ k: "prefs", p: prefsProps });
    const ctx = countingCtx();
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "page:nope" }, ctx.ctx)).toBe(false);
    expect(ctx.renders()).toBe(0);
    expect(tspPrefsAdapter.act(component, { type: "submenu", key: "page:general" }, ctx.ctx)).toBe(true);
    expect(ctx.renders()).toBe(1);
  });
});
