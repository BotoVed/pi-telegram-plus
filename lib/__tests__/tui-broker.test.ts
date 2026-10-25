/**
 * DialogBroker behaviour (§4.5).
 *
 * The broker is the only place a Telegram tap or message turns into host input,
 * so these tests drive a hand-built focus view (the `FocusSource` seam) plus a
 * fake Bot API, and check what actually reaches each side: which chat the
 * dialog is mirrored to, which bytes reach `handleInput`, and what happens to
 * the message once somebody has answered.
 */
import { describe, expect, it } from "vitest";
import { DialogBroker } from "../tui/broker.ts";
import type { BrokerDeps } from "../tui/broker.ts";
import type { FocusInfo } from "../tui/focus.ts";
import type { EntryInfo } from "../tui/model.ts";
import type { TelegramTurn } from "../types.ts";
import type { CommandScope } from "../tui/origin.ts";

const turn = (chatId: number, sourceMessageId = 7): TelegramTurn => ({
  chatId,
  sourceMessageId,
  queuedAttachments: [],
});

function fakeTransport() {
  const sent: Array<{ chatId: number; text: string; rows: unknown[][] }> = [];
  const edits: Array<{ chatId: number; messageId: number; text: string; rows: unknown[][] }> = [];
  const removed: number[] = [];
  const deleted: number[] = [];
  return {
    sent,
    edits,
    removed,
    deleted,
    sendButtons: async (chatId: number, text: string, rows: unknown[][]) => {
      sent.push({ chatId, text, rows });
      return { message_id: 100 + sent.length };
    },
    editButtons: async (chatId: number, messageId: number, text: string, rows: unknown[][]) => {
      edits.push({ chatId, messageId, text, rows });
    },
    sendText: async (chatId: number, text: string) => {
      sent.push({ chatId, text, rows: [] });
      return [{ message_id: 300 + sent.length }];
    },
    removeInlineKeyboard: async (_chatId: number, messageId: number) => {
      removed.push(messageId);
    },
    deleteMessage: async (_chatId: number, messageId: number) => {
      deleted.push(messageId);
    },
  };
}

/** A focus view the test drives by hand: the three members the broker reads. */
function fakeFocus(entry?: EntryInfo) {
  const listeners = new Set<(info: FocusInfo) => void>();
  const editor = { getText: () => "", setText: () => undefined, handleInput: () => undefined };
  let info: FocusInfo = { kind: "editor", component: editor, source: "field" };
  const emit = (next: FocusInfo) => {
    info = next;
    for (const listener of [...listeners]) listener(info);
  };
  return {
    current: () => info,
    entryFor: () => entry,
    onChange: (listener: (info: FocusInfo) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openDialog(component: Record<string, unknown>) {
      emit({ kind: "dialog", component, source: "event" });
    },
    closeToEditor() {
      emit({ kind: "editor", component: editor, source: "event" });
    },
    emitProgress(component: Record<string, unknown>) {
      emit({ kind: "progress", component, source: "event" });
    },
  };
}

function makeBroker(options: {
  turns?: TelegramTurn[];
  entry?: EntryInfo;
  scope?: CommandScope;
} = {}) {
  const transport = fakeTransport();
  const written: string[] = [];
  const focus = fakeFocus(options.entry);
  const broker = new DialogBroker({
    transport: transport as unknown as BrokerDeps["transport"],
    focus,
    origin: { active: () => options.scope } as unknown as BrokerDeps["origin"],
    activeChatId: () => 42,
    activeTurns: () => options.turns ?? [],
    writeText: (text: string) => {
      written.push(text);
      return true;
    },
    enabled: () => true,
  });
  broker.start();
  return { broker, transport, written, focus };
}

/** A three-row selector shaped like pi's extension selector. */
function selector(focus: { closeToEditor: () => void }) {
  const keys: string[] = [];
  const component: Record<string, unknown> = {
    options: ["alpha", "beta", "gamma"],
    selectedIndex: 0,
    handleInput: (input: string) => {
      keys.push(input);
      // A real selector resolves on Enter and hands focus back to the editor.
      if (input === "\r") focus.closeToEditor();
    },
  };
  return { component, keys };
}

/** Flush the fire-and-forget Bot API calls; nothing here waits on the clock. */
const settle = async () => {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
};

describe("dialog broker", () => {
  it("mirrors a host dialog onto the chat that owns the running turn", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const { component } = selector(focus);
    focus.openDialog(component);
    await settle();

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.chatId).toBe(42);
    expect(transport.sent[0]?.text).toContain("beta");
    expect(transport.sent[0]?.rows.length).toBeGreaterThan(0);

    const session = broker.current();
    expect(session?.adapter?.id).toBe("ext-select");
    expect(session?.telegram).toEqual({ chatId: 42, messageThreadId: undefined, messageId: 101 });
    // Only the chat that can see the dialog routes its text to the session.
    expect(broker.sessionFor(42)).toBeDefined();
    expect(broker.sessionFor(7)).toBeUndefined();
    expect(session?.keyMap.get(0)?.get("0.1")).toBe("1:beta");
  });

  it("tracks a purely local dialog without touching Telegram", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [] });
    const { component } = selector(focus);
    focus.openDialog(component);
    await settle();

    expect(transport.sent).toHaveLength(0);
    expect(broker.hasActive()).toBe(true);
    // No chat owns it, so no Telegram message may claim it.
    expect(broker.sessionFor(42)).toBeUndefined();
  });

  it("walks the host key path on a row tap and retires the message", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();

    const session = broker.current();
    const arg = [...(session?.keyMap.get(0) ?? [])].find(([, key]) => key === "1:beta")?.[0];
    expect(arg).toBeDefined();

    const result = broker.handleCallback(42, undefined, {
      sessionId: session?.id ?? "",
      generation: 0,
      op: "c",
      arg,
    });
    await settle();

    // Cursor sits on alpha, so reaching beta is one arrow key plus Enter.
    expect(keys).toEqual(["\x1b[B", "\r"]);
    expect(result).toEqual({ handled: true });
    expect(broker.current()).toBeUndefined();
    expect(transport.edits).toHaveLength(1);
    expect(transport.edits[0]?.text).toContain("beta");
    // The summary line keeps no keyboard.
    expect(transport.edits[0]?.rows).toEqual([]);
  });

  it("keeps the dialog's message when the overlay wrapper takes the focus", async () => {
    const entry: EntryInfo = {
      kind: "select",
      title: "Pick env",
      options: ["alpha", "beta", "gamma"],
      source: "pi",
      method: "select",
    };
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)], entry });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();
    const session = broker.current();
    const arg = [...(session?.keyMap.get(0) ?? [])].find(([, key]) => key === "1:beta")?.[0];
    expect(arg).toBeDefined();

    // OMP hands focus to the overlay wrapper that holds the dialog; the wrapper is what
    // receives keys afterwards, but the user is still being asked the same question.
    const wrapper = {
      children: [component],
      render: () => "",
      handleInput: (input: string) => { keys.push(input); },
    };
    focus.openDialog(wrapper);
    await settle();

    // One question, one message: the handoff must not draw a second dialog nor retire
    // the first, or every keyboard already shown becomes a dead button.
    expect(transport.sent).toHaveLength(1);
    expect(broker.current()?.focus).toBe(wrapper);

    const result = broker.handleCallback(42, undefined, {
      sessionId: session?.id ?? "",
      generation: 0,
      op: "c",
      arg,
    });
    await settle();
    expect(result).toEqual({ handled: true });
    expect(keys).toEqual(["\x1b[B", "\r"]);
  });

  it("keeps the buttons already shown when only the terminal's cursor moved", async () => {
    const entry: EntryInfo = {
      kind: "select",
      title: "Pick env",
      options: ["alpha", "beta", "gamma"],
      source: "pi",
      method: "select",
    };
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)], entry });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();
    const session = broker.current();
    const arg = [...(session?.keyMap.get(0) ?? [])].find(([, key]) => key === "1:beta")?.[0];
    expect(arg).toBeDefined();

    // The local user arrows down to gamma and the host repaints (focus flickers to the
    // spinner and back). The cursor mark sits inside the button labels, but no button's
    // meaning changed, so the keyboard the chat is looking at must still work.
    component.selectedIndex = 2;
    focus.emitProgress({});
    focus.openDialog(component);
    await settle();

    expect(session?.generation).toBe(0);
    expect(transport.sent).toHaveLength(1);

    const result = broker.handleCallback(42, undefined, {
      sessionId: session?.id ?? "",
      generation: 0,
      op: "c",
      arg,
    });
    await settle();

    expect(result).toEqual({ handled: true });
    // gamma is marked now, so beta is reached by walking up from it and pressing Enter.
    expect(keys).toEqual(["\x1b[A", "\r"]);
  });

  it("redraws instead of acting when the callback is stale", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();

    const session = broker.current();
    const result = broker.handleCallback(42, undefined, {
      sessionId: session?.id ?? "",
      generation: 7,
      op: "c",
      arg: "0.1",
    });
    await settle();

    expect(result.toast).toContain("列表已变化");
    expect(keys).toEqual([]);
    expect(broker.hasActive()).toBe(true);
  });

  it("feeds typed text to the dialog's input and hides a secret answer", async () => {
    const { broker, transport, written, focus } = makeBroker({
      turns: [turn(42)],
      entry: { kind: "input", title: "Paste the token", secret: true, source: "pi" },
    });
    const keys: string[] = [];
    const component: Record<string, unknown> = {
      getValue: () => "",
      handleInput: (input: string) => keys.push(input),
    };
    focus.openDialog(component);
    await settle();

    const session = broker.current();
    expect(session?.adapter?.id).toBe("ext-input");
    expect(broker.waitsForText(42)).toBe(true);

    const result = broker.handleText(session!, "hunter2", 55);
    await settle();

    expect(result.handled).toBe(true);
    // The answer is typed into the component's own field rather than written
    // blind to the terminal, which also keeps the secret out of a raw keystroke
    // stream shared with the editor.
    expect(written).toEqual([]);
    expect(keys).toEqual(["\x15", ..."hunter2", "\r"]);
    // The answer was a secret: the raw message is deleted, not just ignored.
    expect(transport.deleted).toContain(55);
    expect(session?.pendingInput).toBeUndefined();

    // The input still owns the keyboard, so a second message is still dialog
    // input - but the secret flow is over, so nothing is hidden this time.
    const followUp = broker.handleText(session!, "again", 56);
    await settle();
    expect(followUp.handled).toBe(true);
    expect(written).toEqual([]);
    expect(transport.deleted).toEqual([55]);
  });

  it("cancels the dialog before /stop interrupts anything", async () => {
    const { broker, focus } = makeBroker({ turns: [turn(42)] });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();

    expect(broker.cancelFor(42)).toBe(true);
    expect(keys).toEqual(["\x1b"]);
    expect(broker.hasActive()).toBe(false);
  });

  it("reports a terminal-side answer and drops the keyboard", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const { component } = selector(focus);
    focus.openDialog(component);
    await settle();

    // The terminal user picks a row: focus leaves before Telegram ever taps.
    focus.closeToEditor();
    await settle();

    expect(transport.edits).toHaveLength(1);
    expect(transport.edits[0]?.text).toContain("已在终端处理");
    expect(broker.current()).toBeUndefined();
    // A late tap on the dead keyboard must not reach the host.
    const result = broker.handleCallback(42, undefined, { sessionId: "gone", generation: 0, op: "c", arg: "0.1" });
    expect(result).toEqual({ handled: true, toast: "已在终端处理", clear: true });
  });

  it("mirrors a dialog onto the chat whose command scope is running", async () => {
    // No Telegram turn is active: only the running command scope can tie this
    // dialog to a chat, and it draws on the ack message the scope carries.
    const scope = {
      id: "s1",
      origin: { chatId: 7, messageThreadId: 3, sourceMessageId: 21 },
      telegramMessageId: 555,
      ended: false,
    } as unknown as CommandScope;
    const { broker, transport, focus } = makeBroker({ scope });
    const { component } = selector(focus);
    focus.openDialog(component);
    await settle();

    expect(transport.sent).toHaveLength(0);
    expect(transport.edits).toHaveLength(1);
    expect(transport.edits[0]?.chatId).toBe(7);
    expect(transport.edits[0]?.messageId).toBe(555);
    // The scope wins over the chat the user last touched.
    expect(broker.sessionFor(7, 3)).toBeDefined();
    expect(broker.sessionFor(42)).toBeUndefined();
  });

  it("does not open a session for a progress panel", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    // A spinner takes the keyboard only so Esc can interrupt: drawing a keyboard for
    // it would put a message in the chat before the real dialog has even opened, and
    // that message then swallows whatever the user types for the dialog.
    focus.emitProgress({ deps: {}, handleInput: () => undefined });
    await settle();

    expect(transport.sent).toHaveLength(0);
    expect(broker.hasActive()).toBe(false);
    expect(broker.sessionFor(42)).toBeUndefined();
  });

  it("keeps a dialog answerable while a progress panel holds the keyboard", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();
    const session = broker.current();
    const arg = [...(session?.keyMap.get(0) ?? [])].find(([, key]) => key === "1:beta")?.[0];
    expect(arg).toBeDefined();

    // The host focuses its spinner so Esc can interrupt the turn. The question behind it is
    // still open, so withdrawing the keyboard here would strand a message the user can no
    // longer answer - the OMP ask dialog loses exactly this way.
    focus.emitProgress({ deps: {}, handleInput: () => undefined });
    await settle();

    expect(transport.sent).toHaveLength(1);
    expect(transport.edits).toHaveLength(0);
    expect(broker.current()).toBe(session);

    const result = broker.handleCallback(42, undefined, {
      sessionId: session?.id ?? "",
      generation: 0,
      op: "c",
      arg,
    });
    await settle();
    expect(result).toEqual({ handled: true });
    expect(keys).toEqual(["\x1b[B", "\r"]);
  });

  it("refuses to answer a dialog this chat was never shown", async () => {
    const entry: EntryInfo = {
      kind: "select",
      title: "Pick env",
      options: ["alpha", "beta", "gamma"],
      source: "pi",
      method: "select",
    };
    const { broker, transport, focus } = makeBroker({ entry });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();
    expect(broker.hasActive()).toBe(true);

    // The terminal opened this question and nobody in this chat was ever shown it (§4.3 rule 3).
    // The host queues every later command behind it, so the arriving command is refused with an
    // explanation; the broker must not press Esc on a question this chat does not own.
    expect(broker.abandonFor(42)).toEqual({ kind: "blocked", title: "Pick env" });
    await settle();

    expect(keys).toEqual([]);
    expect(transport.sent).toHaveLength(0);
    expect(broker.hasActive()).toBe(true);
    // Still blocked: nothing was answered, so the next command is refused the same way.
    expect(broker.abandonFor(42)).toEqual({ kind: "blocked", title: "Pick env" });
  });

  it("leaves an abandoned message for the command that arrived", async () => {
    const entry: EntryInfo = {
      kind: "select",
      title: "Bot name",
      options: ["work", "home"],
      source: "pi",
      method: "select",
    };
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)], entry });
    const { component } = selector(focus);
    focus.openDialog(component);
    await settle();
    expect(transport.sent).toHaveLength(1);

    expect(broker.abandonFor(42)).toEqual({ kind: "closed", title: "Bot name" });
    await settle();

    // The command that arrived draws its own answer on this very message (one scope, one
    // message), so the broker strips the dead keyboard and writes nothing over the text.
    expect(transport.edits).toHaveLength(0);
    expect(transport.removed).toEqual([101]);
    expect(broker.current()).toBeUndefined();
  });

  it("quietly retires a dialog the host already closed", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(42)] });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();
    expect(transport.sent).toHaveLength(1);

    // The terminal answered. A command arriving afterwards must not press Esc again or claim
    // that it closed a question - the notice would land where the command's own answer goes.
    focus.closeToEditor();
    await settle();
    expect(broker.abandonFor(42)).toEqual({ kind: "nothing" });
    await settle();

    expect(keys).toEqual([]);
    // The only edit is the "answered in the terminal" line the close itself writes.
    expect(transport.edits).toHaveLength(1);
    expect(broker.current()).toBeUndefined();
  });

  it("leaves another chat's dialog alone when this one sends a command", async () => {
    const { broker, transport, focus } = makeBroker({ turns: [turn(7)] });
    const { component, keys } = selector(focus);
    focus.openDialog(component);
    await settle();
    expect(transport.sent[0]?.chatId).toBe(7);

    // Not this chat's question: no Esc, no keyboard taken away, and the arriving command is
    // refused instead of queued behind a dialog it may not answer.
    expect(broker.abandonFor(42).kind).toBe("blocked");
    await settle();

    expect(keys).toEqual([]);
    expect(transport.removed).toEqual([]);
    expect(broker.hasActive()).toBe(true);
  });
});
