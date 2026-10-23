import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandGateway, isOutputOnlyCommand } from "../tui/gateway.ts";
import { OriginTracker, IDLE_MS } from "../tui/origin.ts";
import { OutputCapture, renderComponent } from "../tui/output.ts";
import { FocusTracker } from "../tui/focus.ts";
import type { TuiBridgeAdapter } from "../tui-bridge.ts";

afterEach(() => {
  vi.useRealTimers();
});

function fakeTransport() {
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  const sends: Array<{ chatId: number; text: string }> = [];
  return {
    edits,
    sends,
    sendText: vi.fn(async (chatId: number, text: string) => {
      sends.push({ chatId, text });
      return [{ message_id: sends.length }];
    }),
    editText: vi.fn(async (chatId: number, messageId: number, text: string) => {
      edits.push({ chatId, messageId, text });
    }),
    sendDocument: vi.fn(async () => undefined),
  };
}

function fakeBridge(result: Promise<unknown>): TuiBridgeAdapter {
  return {
    ready: async () => undefined,
    isAvailable: () => true,
    getHost: () => "pi",
    getCommands: async () => [],
    submit: () => true,
    submitResult: () => ({ ok: true, result }),
    readEditorText: () => "",
    writeEditorText: () => true,
    snapshot: () => undefined,
    key: () => true,
    write: () => true,
    isEditorFocused: () => true,
    isInteractiveFocus: () => false,
    onLocalSubmit: () => () => undefined,
  };
}

describe("stage 1 output-only gateway", () => {
  it("keeps pi and OMP whitelists host-specific", () => {
    expect(isOutputOnlyCommand("pi", "session")).toBe(true);
    expect(isOutputOnlyCommand("pi", "compact")).toBe(true);
    expect(isOutputOnlyCommand("pi", "settings")).toBe(false);
    expect(isOutputOnlyCommand("omp", "status")).toBe(false);
    expect(isOutputOnlyCommand("omp", "settings")).toBe(false);
    expect(isOutputOnlyCommand("unknown", "session")).toBe(false);
  });

  it("renders text, markdown and arbitrary components", () => {
    expect(renderComponent({ text: "plain" })).toBe("plain");
    expect(renderComponent({ text: "a\nb" })).toBe("<pre>a\nb</pre>");
    expect(renderComponent({ markdown: "**bold**" })).toContain("<b>bold</b>");
    expect(renderComponent({ render: () => ["a", "b"] })).toBe("<pre>a\nb</pre>");
    expect(renderComponent({ render: () => [] })).toBeUndefined();
  });

  it("ends an idle scope and restores the saved draft", async () => {
    vi.useFakeTimers();
    let draft = "draft text";
    const writes: string[] = [];
    const origin = new OriginTracker({
      isEditorFocused: () => true,
      readDraft: () => draft,
      writeDraft: (text) => { writes.push(text); draft = text; return true; },
    });
    const ended: string[] = [];
    origin.onEnd((scope, reason) => ended.push(`${scope.label}:${reason}`));
    const scope = origin.begin({ chatId: 1 }, "session", "/session", "draft text");
    origin.markSubmitDone(scope);
    draft = ""; // host cleared the editor after submission
    await vi.advanceTimersByTimeAsync(IDLE_MS - 100);
    expect(ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(ended).toEqual(["session:idle"]);
    expect(writes).toContain("draft text");
  });

  it("does not overwrite text the user typed during the scope", async () => {
    vi.useFakeTimers();
    let draft = "saved";
    const writes: string[] = [];
    const origin = new OriginTracker({
      isEditorFocused: () => true,
      readDraft: () => draft,
      writeDraft: (text) => { writes.push(text); return true; },
    });
    const scope = origin.begin({ chatId: 1 }, "session", "/session", "saved");
    origin.markSubmitDone(scope);
    draft = "typed by user";
    await vi.advanceTimersByTimeAsync(IDLE_MS + 200);
    expect(scope.localEdited).toBe(true);
    expect(writes).toEqual([]);
  });

  it("submits a whitelisted command, captures output and reports completion", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    let draft = "draft text";
    let resolveSubmit: (() => void) | undefined;
    const submitPromise = new Promise<void>((resolve) => { resolveSubmit = resolve; });
    const origin = new OriginTracker({
      isEditorFocused: () => true,
      readDraft: () => draft,
      writeDraft: (text) => { draft = text; return true; },
    });
    const focus = new FocusTracker();
    const output = new OutputCapture(transport, origin);
    const bridge = fakeBridge(submitPromise);
    const gateway = new CommandGateway({
      bridge,
      origin,
      output,
      focus,
      isEnabled: () => true,
      hostName: () => "pi",
      hostState: () => ({ host: "pi", mode: {}, editor: {} }),
      readDraft: () => draft,
    });
    gateway.start();

    const handled = await gateway.run({
      name: "session",
      args: "",
      origin: { chatId: 7 },
      transport,
    });
    expect(handled).toBe(true);
    expect(transport.sends[0]?.text).toContain("/session");
    draft = "";
    resolveSubmit?.();
    await vi.advanceTimersByTimeAsync(IDLE_MS + 1000);
    await Promise.resolve();

    expect(transport.edits.length).toBeGreaterThan(0);
    expect(transport.edits[transport.edits.length - 1]?.text).toContain("✓ 完成");
    expect(draft).toBe("draft text");
    gateway.dispose();
  });

  it("accumulates deferred output without erasing earlier entries", async () => {
    vi.useFakeTimers();
    const transport = fakeTransport();
    const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
    const output = new OutputCapture(transport, origin);
    const scope = origin.begin({ chatId: 1 }, "session", "/session", "");
    output.bind(scope, { chatId: 1, messageId: 9, ackHtml: "<b>▶️ /session</b>" });
    (output as unknown as { push(html: string): void }).push("first");
    await vi.advanceTimersByTimeAsync(800);
    expect(transport.edits.at(-1)?.text).toContain("first");
    (output as unknown as { push(html: string): void }).push("second");
    await vi.advanceTimersByTimeAsync(1100);
    const text = transport.edits.at(-1)?.text ?? "";
    expect(text).toContain("first");
    expect(text).toContain("second");
    output.finish();
    await vi.advanceTimersByTimeAsync(20);
    expect(transport.edits.at(-1)?.text).toContain("✓ 完成");
    origin.end(scope, "idle");
  });

  it("does not claim a non-whitelisted command", async () => {
    const transport = fakeTransport();
    const origin = new OriginTracker({ isEditorFocused: () => true, readDraft: () => "", writeDraft: () => true });
    const gateway = new CommandGateway({
      bridge: fakeBridge(Promise.resolve()),
      origin,
      output: new OutputCapture(transport, origin),
      focus: new FocusTracker(),
      isEnabled: () => true,
      hostName: () => "pi",
      hostState: () => ({ host: "pi", mode: {}, editor: {} }),
    });
    expect(gateway.handles("settings")).toBe(false);
    expect(await gateway.run({ name: "settings", args: "", origin: { chatId: 1 }, transport })).toBe(false);
    expect(transport.sends).toEqual([]);
  });
});
