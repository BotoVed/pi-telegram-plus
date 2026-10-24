/**
 * Contract tests against the real host dialog components (§7.1).
 *
 * These build the same classes pi instantiates and assert what happens to the
 * component, not what our code intended: after the injected keys the host must
 * resolve the same value a terminal user would have got. A host upgrade that
 * renames a field, re-points a keybinding, or changes what a render looks like
 * therefore fails here instead of showing a dead button in Telegram.
 *
 * Nothing here mocks a component. Where a fixture is hand-built it is a fake
 * *render*, to pin the decoder, never a fake dialog.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as host from "@earendil-works/pi-coding-agent";
import { pickAdapter } from "../tui/adapters/index.ts";
import { renderText, setOmpVersion } from "../tui/adapters/utils.ts";
import { sendKeyTo } from "../tui/keys.ts";
import type { AdapterContext, DialogModel, EntryInfo } from "../tui/model.ts";

// pi-tui builds colours while the component is constructed, and its loader reads
// pi-tui's own theme singleton. Both are undefined until the theme is seeded.
beforeAll(() => {
  host.initTheme("dark");
  // The frame-reading adapters are gated to the OMP version this capture came
  // from (§4.6.6 exception 2); the suite below runs as that verified version.
  setOmpVersion("18.12.5");
});

type KeyLog = { target: string; data: string }[];

/**
 * Wrap every `handleInput` in the tree, so a test can see which object the keys
 * really reached — the focused wrapper, or the list it delegates to. A wrapper
 * that forwards to its own child (pi's loader does) is one injection, not two,
 * so a nested call is not logged a second time.
 */
function recordKeys(root: unknown): KeyLog {
  const keys: KeyLog = [];
  const seen = new Set<unknown>();
  const skip = new Set(["ui", "tui", "theme", "keybindings", "session", "abortController"]);
  let nested = 0;
  const frontier: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];
  while (frontier.length > 0) {
    const { node, depth } = frontier.pop() as { node: object; depth: number };
    if (seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    const original = record.handleInput;
    if (typeof original === "function") {
      const name = (record.constructor as { name?: string } | undefined)?.name ?? "anonymous";
      record.handleInput = (data: string) => {
        if (nested === 0) keys.push({ target: name, data });
        nested += 1;
        try {
          (original as (input: string) => void).call(record, data);
        } finally {
          nested -= 1;
        }
      };
    }
    if (depth >= 3) continue;
    for (const [field, value] of Object.entries(record)) {
      if (skip.has(field) || typeof value === "function") continue;
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === "object") frontier.push({ node: item, depth: depth + 1 });
      } else if (value && typeof value === "object") {
        frontier.push({ node: value, depth: depth + 1 });
      }
    }
  }
  return keys;
}

/** The same AdapterContext the Broker builds, minus the Telegram half. */
function harness(component: unknown, entry?: EntryInfo, hostName: "pi" | "omp" = "pi") {
  const keys = recordKeys(component);
  const ctx: AdapterContext = {
    host: hostName,
    root: component as object,
    entry,
    sendKey: (name) => sendKeyTo(component, name),
    snapshot: (width) => renderText(component, width),
    requestRender: () => {},
  };
  return { ctx, keys, bytes: () => keys.map((entry2) => entry2.data) };
}

function expectSelect(model: DialogModel) {
  if (model.kind !== "select") throw new Error(`expected a select model, got ${model.kind}`);
  return model;
}

describe("selector over a plain options list", () => {
  it("reads the options and marks where the terminal cursor is", () => {
    const component = new host.ExtensionSelectorComponent("Pick env", ["dev", "staging", "prod", "local"], () => {}, () => {});
    const { ctx } = harness(component);

    const model = expectSelect(pickAdapter(component, ctx)!.read(component, ctx));

    expect(model.title).toBe("Pick env");
    expect(model.items.map((item) => item.label)).toEqual(["dev", "staging", "prod", "local"]);
    expect(model.items.map((item) => item.key)).toEqual(["0:dev", "1:staging", "2:prod", "3:local"]);
    expect(model.items.map((item) => item.focused)).toEqual([true, false, false, false]);
  });

  it("choosing an option walks the cursor with arrow keys and submits it", () => {
    const resolved: string[] = [];
    const component = new host.ExtensionSelectorComponent("Pick env", ["dev", "staging", "prod", "local"], (value: string) => resolved.push(value), () => {});
    const { ctx, keys } = harness(component);
    const adapter = pickAdapter(component, ctx)!;

    const done = adapter.act(component, { type: "choose", key: "2:prod" }, ctx);

    // Two steps down, then enter: the component moves its own cursor, so the
    // terminal mirror and the host state cannot disagree (§4.1.3).
    expect(done).toBe(true);
    expect(keys.map((entry) => entry.data)).toEqual(["\u001b[B", "\u001b[B", "\r"]);
    expect(resolved).toEqual(["prod"]);
  });

  it("cancels with escape", () => {
    const cancelled: string[] = [];
    const component = new host.ExtensionSelectorComponent("Deploy?", ["Yes", "No"], () => {}, () => cancelled.push("cancelled"));
    const { ctx, bytes } = harness(component);

    expect(pickAdapter(component, ctx)!.act(component, { type: "cancel" }, ctx)).toBe(true);
    expect(bytes()).toEqual(["\u001b"]);
    expect(cancelled).toEqual(["cancelled"]);
  });
});

describe("selector that delegates keys to the list it wraps", () => {
  it("reads ShowImages through its inner SelectList and resolves a boolean", () => {
    const resolved: unknown[] = [];
    const component = new host.ShowImagesSelectorComponent(false, (value: boolean) => resolved.push(value), () => {});
    // The wrapper owns focus but binds no key of its own, so a key sent to the
    // focused component has to be routed into the list it wraps.
    expect((component as unknown as Record<string, unknown>).handleInput).toBeUndefined();
    const { ctx, keys } = harness(component);
    const adapter = pickAdapter(component, ctx)!;
    expect(adapter.id).toBe("ext-select");

    const model = expectSelect(adapter.read(component, ctx));
    expect(model.items.map((item) => item.label)).toEqual(["Yes", "No"]);
    expect(model.items[0].description).toBe("Show images inline in terminal");
    expect(model.items.map((item) => item.focused)).toEqual([false, true]);

    expect(adapter.act(component, { type: "choose", key: "0:Yes" }, ctx)).toBe(true);
    expect(keys.map((entry) => entry.target)).toEqual(["SelectList", "SelectList"]);
    expect(resolved).toEqual([true]);
  });

  it("resolves the theme the button named, not the row it happened to sit on", () => {
    const resolved: string[] = [];
    const component = new host.ThemeSelectorComponent("dark", (name: string) => resolved.push(name), () => {}, () => {});
    const { ctx } = harness(component);
    const adapter = pickAdapter(component, ctx)!;

    const model = expectSelect(adapter.read(component, ctx));
    const light = model.items.find((item) => item.label === "light");
    const dark = model.items.find((item) => item.label === "dark");
    expect(light).toBeDefined();
    expect(dark?.description).toBe("(current)");

    expect(adapter.act(component, { type: "choose", key: light!.key }, ctx)).toBe(true);
    expect(resolved).toEqual(["light"]);
  });
});

describe("one-line text input", () => {
  const entry: EntryInfo = { kind: "input", title: "Name", source: "pi", method: "showExtensionInput" };

  it("reports the live value of the input as prefill", () => {
    const component = new host.ExtensionInputComponent("Name", "", () => {}, () => {});
    for (const character of "fish") (component as any).input.handleInput(character);
    const { ctx } = harness(component, entry);

    const model = pickAdapter(component, ctx)!.read(component, ctx);
    if (model.kind !== "input") throw new Error(`expected an input model, got ${model.kind}`);

    expect(model.title).toBe("Name");
    expect(model.prefill).toBe("fish");
    expect(model.secret).toBe(false);
  });

  it("types a reply into the input and submits it", () => {
    const resolved: string[] = [];
    const component = new host.ExtensionInputComponent("Name", "", (value: string) => resolved.push(value), () => {});
    const { ctx, keys } = harness(component, entry);
    const adapter = pickAdapter(component, ctx)!;
    expect(adapter.id).toBe("ext-input");

    expect(adapter.act(component, { type: "submit", text: "guppy" }, ctx)).toBe(true);

    // ctrl+u clears what the terminal had typed, so a reply replaces it instead
    // of continuing it.
    expect(keys[0].data).toBe("\u0015");
    expect(keys[keys.length - 1].data).toBe("\r");
    expect(resolved).toEqual(["guppy"]);
  });
});

describe("mirroring a render instead of a model", () => {
  it("decodes a render that returns one string per line", () => {
    const component = { render: () => ["alpha", "  beta"] };
    const { ctx } = harness(component);

    const model = pickAdapter(component, ctx)!.read(component, ctx);
    if (model.kind !== "snapshot") throw new Error(`expected a snapshot model, got ${model.kind}`);

    expect(model.text).toBe("alpha\n  beta");
  });

  it("treats a loading spinner as a read-only panel and leaves escape working", () => {
    const tui = { requestRender: () => {} };
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const component = new host.BorderedLoader(tui as never, theme as never, "Working...");
    try {
      const { ctx, bytes } = harness(component);
      const adapter = pickAdapter(component, ctx)!;
      expect(adapter.id).toBe("info-panel");

      const model = adapter.read(component, ctx);
      if (model.kind !== "progress") throw new Error(`expected a progress model, got ${model.kind}`);

      expect(model.text).toContain("Working...");
      // Colors are stripped, so the mirror survives a theme switch.
      expect(model.text).not.toMatch(/\u001b\[/);
      expect(model.cancellable).toBe(true);

      expect(adapter.act(component, { type: "cancel" }, ctx)).toBe(true);
      expect(bytes()).toEqual(["\u001b"]);
      expect((component as any).loader.aborted).toBe(true);
    } finally {
      component.dispose();
    }
  });
});

/**
 * OMP's hook dialogs: the entry call carries the options, but the component that
 * owns focus keeps its rows in private fields, so the only place the list and its
 * cursor exist is the frame the component draws. The frames below are OMP's own
 * text, taken from the stage-0 capture (`docs/host-probe/omp-18.12.5.json`,
 * `focusTypes[*].rendered`); only the container around them is built here.
 */
function capturedFrame(marker: string): string {
  const probe = JSON.parse(
    readFileSync(new URL("../../docs/host-probe/omp-18.12.5.json", import.meta.url), "utf8"),
  ) as { frameSamples?: { rendered?: string }[] };
  for (const sample of probe.frameSamples ?? []) {
    const frame = sample.rendered ?? "";
    if (frame.includes(marker)) return frame;
  }
  throw new Error(`the capture has no frame containing ${marker}`);
}

/** Move the frame's `❯` onto `label`, leaving OMP's own text otherwise intact. */
function frameWithCursor(frame: string, labels: string[], cursor: number): string {
  const label = labels[cursor];
  return frame
    .split("\n")
    .map((line) => (line.includes("❯") ? line.replace("❯", " ") : line))
    .map((line) => {
      const content = line.replace(/^\s*│\s*/, "").replace(/\s*│\s*$/, "").trim();
      return label !== undefined && content === label ? line.replace(label, `❯ ${label}`) : line;
    })
    .join("\n");
}

/** A focus owner with unreadable rows that answers the arrow keys its frame advertises. */
function framedDialog(frame: string, labels: string[]) {
  const picked: string[] = [];
  let cursor = 0;
  const component: Record<string, unknown> = {
    // Rows with private state: nothing an adapter can read from the outside.
    children: labels.map(() => ({})),
    render: () => frameWithCursor(frame, labels, cursor),
    handleInput(data: string) {
      if (data === "\u001b[B") cursor = Math.min(cursor + 1, labels.length - 1);
      else if (data === "\u001b[A") cursor = Math.max(cursor - 1, 0);
      else if (data === "\r") picked.push(labels[cursor] ?? "");
    },
  };
  return { component, picked };
}

describe("a dialog whose rows live in private fields", () => {
  const selectLabels = ["alpha", "beta", "gamma"];
  const selectEntry: EntryInfo = { kind: "select", title: "PROBE_SELECT_TITLE", options: selectLabels, source: "omp" };

  function ompDialog(frameMarker: string, labels: string[], entry: EntryInfo) {
    const dialog = framedDialog(capturedFrame(frameMarker), labels);
    return { ...dialog, ...harness(dialog.component, entry, "omp") };
  }

  it("reads the choices from the entry and marks the row the frame marks", () => {
    const { component, ctx } = ompDialog("PROBE_SELECT_TITLE", selectLabels, selectEntry);

    const adapter = pickAdapter(component, ctx)!;
    expect(adapter.id).toBe("ext-select");
    const model = expectSelect(adapter.read(component, ctx));

    expect(model.items.map((item) => item.label)).toEqual(selectLabels);
    expect(model.items.findIndex((item) => item.focused)).toBe(0);
  });

  it("chooses a row by walking the cursor the frame shows", () => {
    const { component, ctx, bytes, picked } = ompDialog("PROBE_SELECT_TITLE", selectLabels, selectEntry);
    const adapter = pickAdapter(component, ctx)!;

    expect(adapter.act(component, { type: "choose", key: "2:gamma" }, ctx)).toBe(true);

    expect(picked).toEqual(["gamma"]);
    expect(bytes()).toEqual(["\u001b[B", "\u001b[B", "\r"]);
  });

  it("answers a confirm through the rows the host drew", () => {
    const entry: EntryInfo = { kind: "confirm", title: "PROBE_CONFIRM_TITLE", message: "PROBE_CONFIRM_MESSAGE", source: "omp" };
    const { component, ctx, picked } = ompDialog("PROBE_CONFIRM_TITLE", ["Yes", "No"], entry);
    const adapter = pickAdapter(component, ctx)!;

    const model = adapter.read(component, ctx);
    expect(model.kind).toBe("confirm");
    expect(adapter.act(component, { type: "confirm", yes: false }, ctx)).toBe(true);

    expect(picked).toEqual(["No"]);
  });

  it("refuses when the frame no longer shows the option it was asked to pick", () => {
    const { component, ctx, bytes } = ompDialog("PROBE_SELECT_TITLE", ["alpha", "beta"], {
      ...selectEntry,
      options: ["alpha", "beta", "delta"],
    });
    const adapter = pickAdapter(component, ctx)!;

    // "delta" is not on screen: the Broker has to redraw instead of guessing a row.
    expect(adapter.act(component, { type: "choose", key: "2:delta" }, ctx)).toBe(false);
    expect(bytes()).toEqual([]);
  });

  it("counts steps through the rows the frame shows, not the whole option list", () => {
    const frame = ["╭ Pick ────╮", "│ beta     │", "│ gamma    │", "│ delta    │", "╰──────────╯"].join("\n");
    const entry: EntryInfo = {
      kind: "select",
      title: "Pick",
      options: ["alpha", "beta", "gamma", "delta", "epsilon"],
      source: "omp",
    };
    const { component, picked } = framedDialog(frame, ["beta", "gamma", "delta"]);
    const { ctx } = harness(component, entry, "omp");
    const adapter = pickAdapter(component, ctx)!;

    // The terminal filtered five options down to three: the arrows move between the rows on
    // screen, so delta is two Downs away even though the entry lists it fourth.
    expect(adapter.act(component, { type: "choose", key: "3:delta" }, ctx)).toBe(true);
    expect(picked).toEqual(["delta"]);
  });

  it("matches option strings the host pads with indentation and a state mark", () => {
    // OMP hands the extension host option strings that already carry their own indentation
    // and its own "this is the current value" dot, while the frame draws the cursor mark in
    // front of them: the two only agree once that decoration is ignored.
    const options = ["  hidden", "● brief", "  full"];
    const frame = [
      "╭─ 🔧 Tool rendering ────────────────────────────────╮",
      "│                                                  │",
      "│  ❯   hidden                                     │",
      "│    ● brief                                     │",
      "│      full                                      │",
      "│ ↑/↓ navigate  ⏎ select  ⎋ cancel               │",
      "╰──────────────────────────────────────────────╯",
    ].join("\n");
    const picked: string[] = [];
    let cursor = 0;
    const component: Record<string, unknown> = {
      children: options.map(() => ({})),
      render: () => frame,
      handleInput(data: string) {
        if (data === "\u001b[B") cursor = Math.min(cursor + 1, options.length - 1);
        else if (data === "\u001b[A") cursor = Math.max(cursor - 1, 0);
        else if (data === "\r") picked.push(options[cursor] ?? "");
      },
    };
    const entry: EntryInfo = { kind: "select", title: "Tool rendering", options, source: "omp" };
    const { ctx } = harness(component, entry, "omp");
    const adapter = pickAdapter(component, ctx)!;

    expect(adapter.act(component, { type: "choose", key: `1:${options[1]}` }, ctx)).toBe(true);
    expect(picked).toEqual([options[1]]);
  });
});

describe("OMP frame version gate", () => {
  const gateLabels = ["alpha", "beta", "gamma"];
  const gateEntry: EntryInfo = { kind: "select", title: "PROBE_SELECT_TITLE", options: gateLabels, source: "omp" };

  afterEach(() => {
    setOmpVersion("18.12.5");
  });

  function gatedOmpDialog() {
    const dialog = framedDialog(capturedFrame("PROBE_SELECT_TITLE"), gateLabels);
    return { ...dialog, ...harness(dialog.component, gateEntry, "omp") };
  }

  it("models the frame rows on a verified OMP version", () => {
    setOmpVersion("18.12.5");
    const { component, ctx } = gatedOmpDialog();
    const adapter = pickAdapter(component, ctx)!;

    const model = expectSelect(adapter.read(component, ctx));

    expect(model.items.map((item) => item.label)).toEqual(gateLabels);
  });

  it("mirrors the screen instead of the frame on an unverified OMP version", () => {
    setOmpVersion("18.13.0");
    const { component, ctx, picked } = gatedOmpDialog();
    const adapter = pickAdapter(component, ctx)!;

    expect(adapter.read(component, ctx).kind).toBe("snapshot");
    expect(adapter.act(component, { type: "choose", key: "2:gamma" }, ctx)).toBe(false);
    expect(picked).toEqual([]);
  });

  it("mirrors the screen when the OMP version cannot be determined", () => {
    setOmpVersion(undefined);
    const { component, ctx, picked } = gatedOmpDialog();
    const adapter = pickAdapter(component, ctx)!;

    expect(adapter.read(component, ctx).kind).toBe("snapshot");
    expect(adapter.act(component, { type: "choose", key: "2:gamma" }, ctx)).toBe(false);
    expect(picked).toEqual([]);
  });

  it("leaves pi dialogs unaffected by the OMP version", () => {
    setOmpVersion("18.13.0");
    const component = new host.ExtensionSelectorComponent("Pick env", ["dev", "staging"], () => {}, () => {});
    const { ctx } = harness(component);
    const adapter = pickAdapter(component, ctx)!;

    expect(expectSelect(adapter.read(component, ctx)).items.map((item) => item.label)).toEqual(["dev", "staging"]);
  });
});
