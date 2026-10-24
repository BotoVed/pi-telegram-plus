/**
 * OMP's `askDialog` keeps its real state in a closure, so this adapter infers the
 * option cursor it sends keys from (§4.6.4). The inference is what these tests pin:
 * the host parks the cursor on the recommended option when a question opens, so the
 * arrow keys for a tapped row must be counted from there. Counting from the top
 * instead sends the answer back one row away from the row the user pressed.
 */
import { describe, expect, it } from "vitest";
import { askDialogAdapter } from "../tui/adapters/ask.ts";
import type { AdapterContext, AskQuestion, EntryInfo } from "../tui/model.ts";

function context(questions: AskQuestion[]) {
  const keys: string[] = [];
  const entry: EntryInfo = { kind: "ask", method: "askDialog", source: "omp", questions };
  const ctx: AdapterContext = {
    host: "omp",
    entry,
    sendKey: (name: string) => {
      keys.push(name);
      return true;
    },
    requestRender: () => undefined,
  };
  // A fresh component per case: the adapter keeps its guess per component instance.
  return { component: {} as Record<string, unknown>, ctx, keys };
}

const colour: AskQuestion = {
  id: "colour",
  question: "Pick a color for the acceptance run",
  options: [{ label: "red" }, { label: "green" }, { label: "blue" }],
  recommended: 1,
};

describe("omp ask dialog adapter", () => {
  it("marks the recommended row as the row the host is on", () => {
    const { component, ctx } = context([colour]);
    const model = askDialogAdapter.read(component, ctx);
    expect(model.kind).toBe("questionnaire");
    const items = model.kind === "questionnaire" ? model.questions[0]?.items ?? [] : [];
    expect(items.map((item) => item.focused)).toEqual([false, true, false]);
  });

  it("counts arrow keys from the recommended row, not from the top", () => {
    const { component, ctx, keys } = context([colour]);
    expect(askDialogAdapter.act(component, { type: "choose", key: "0:blue" }, ctx)).toBe(true);
    expect(keys).toEqual(["down", "enter"]);
  });

  it("moves up when the tapped row sits above the recommended one", () => {
    const { component, ctx, keys } = context([colour]);
    expect(askDialogAdapter.act(component, { type: "choose", key: "0:red" }, ctx)).toBe(true);
    expect(keys).toEqual(["up", "enter"]);
  });

  it("starts the next question on its own recommended row", () => {
    const size: AskQuestion = {
      id: "size",
      question: "How large?",
      options: [{ label: "small" }, { label: "large" }],
      recommended: 1,
    };
    const { component, ctx, keys } = context([colour, size]);
    expect(askDialogAdapter.act(component, { type: "choose", key: "1:small" }, ctx)).toBe(true);
    // Reaching question two means Tab, then one Up from the row it opens on.
    expect(keys).toEqual(["tab", "up", "enter"]);
  });
});
