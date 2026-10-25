/**
 * The TSP picker adapter reads OMP components through `describe` and answers
 * through `handleNativeEvent` (§4.11.3): no screen parsing, no keys. What
 * these tests pin is the keypath computation (reconcile.ts rules: keyed child
 * → its key, unkeyed child → its index, component boundary → restart at "")
 * and the props-to-model mapping, since both are the adapter's whole contract
 * with the host.
 */
import { describe, expect, it } from "vitest";
import { findPicker, tspPickerAdapter } from "../tui/adapters/tsp.ts";
import type { AdapterContext, DialogModel } from "../tui/model.ts";

type Node = { k: string; p?: unknown; c?: unknown[]; key?: string };

function ctxFor(host: "pi" | "omp" = "omp"): AdapterContext {
  return { host, sendKey: () => true, requestRender: () => undefined };
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

const asSelect = (model: DialogModel) => (model.kind === "select" ? model : expect.fail(`not a select: ${model.kind}`));

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
    expect(model.title).toBe("选择");
    expect(model.items.map((item) => item.key)).toEqual(["c"]);
    expect(model.total).toBe(1);
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
});
