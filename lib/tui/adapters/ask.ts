/**
 * Adapter #4 — OMP's `askDialog` (§4.6.4).
 *
 * OMP keeps this dialog's real state (active question, cursor, answers) inside
 * a closure: a fresh `ask()` call reuses the same component instance and the
 * component keeps its previous answers, and there is nothing on the component
 * to read. So the adapter keeps its own copy per component instance and drives
 * the dialog with the keys the terminal legend advertises — Tab between
 * questions, arrows inside one, Enter to advance, Esc to cancel.
 *
 * The tracked cursor is inferred, not read: it starts on the row the host highlights when it
 * opens a question - its recommended option, which is why an unseeded guess picked the row after
 * the one the user tapped - and is then moved by every action this adapter sends. Every action
 * therefore ends with a redraw from the model, and a question list that changed underneath us is
 * reported rather than acted on.
 */
import type { AskQuestion, DialogAdapter, DialogModel, Question } from "../model.ts";
import { selectRow } from "./utils.ts";

type AskState = {
  /** Signature of the question list, so a reused component starts over. */
  signature: string;
  active: number;
  /** One cursor per question, seeded where the host parks it: the recommended row. */
  cursor: number[];
  answers: Map<string, string[]>;
};

const states = new WeakMap<object, AskState>();

const rowKeyOf = (questionIndex: number, label: string) => `${questionIndex}:${label}`;

function stateFor(component: object, questions: AskQuestion[]): AskState {
  const signature = questions.map((question) => `${question.id}|${question.options.length}|${question.multi === true}`).join(";");
  const existing = states.get(component);
  if (existing && existing.signature === signature) return existing;
  const fresh: AskState = { signature, active: 0, cursor: questions.map((question) => question.recommended ?? 0), answers: new Map() };
  states.set(component, fresh);
  return fresh;
}

export const askDialogAdapter: DialogAdapter = {
  id: "omp-ask",

  detect(_component, ctx) {
    return ctx.entry?.kind === "ask" && (ctx.entry?.questions?.length ?? 0) > 0;
  },

  read(component, ctx): DialogModel {
    const questions = ctx.entry?.questions ?? [];
    const state = stateFor(component, questions);
    const model: Question[] = questions.map((question, index) => {
      const chosen = state.answers.get(question.id) ?? [];
      return {
        id: question.id,
        prompt: question.question,
        multi: question.multi === true,
        allowCustom: question.allowCustom !== false,
        answered: chosen.length > 0,
        items: question.options.map((option, optionIndex) => ({
          key: rowKeyOf(index, option.label),
          label: option.label,
          description: option.description,
          checked: chosen.includes(option.label),
          current: question.recommended === optionIndex,
          focused: state.active === index && (state.cursor[index] ?? 0) === optionIndex,
        })),
      };
    });
    return {
      kind: "questionnaire",
      title: ctx.entry?.title ?? "Questionnaire",
      questions: model,
      active: Math.min(state.active, Math.max(0, model.length - 1)),
      canSubmit: model.length > 0 && model.every((question) => question.answered),
    };
  },

  act(component, action, ctx) {
    const questions = ctx.entry?.questions ?? [];
    if (questions.length === 0) return false;
    const state = stateFor(component, questions);

    if (action.type === "cancel") {
      states.delete(component);
      return ctx.sendKey("esc");
    }

    if (action.type === "question") {
      const target = action.index;
      if (target < 0 || target >= questions.length || target === state.active) return target !== state.active;
      const steps = Math.abs(target - state.active);
      const name = target > state.active ? "tab" : "shift-tab";
      for (let step = 0; step < steps; step += 1) {
        if (!ctx.sendKey(name)) return false;
      }
      state.active = target;
      state.cursor[target] = questions[target]?.recommended ?? 0;
      return true;
    }

    if (action.type === "choose" || action.type === "toggle") {
      const separator = action.key.indexOf(":");
      if (separator < 0) return false;
      const questionIndex = Number.parseInt(action.key.slice(0, separator), 10);
      const label = action.key.slice(separator + 1);
      const question = Number.isInteger(questionIndex) ? questions[questionIndex] : undefined;
      if (!question) return false;
      const target = question.options.findIndex((option) => option.label === label);
      if (target < 0) return false;

      if (questionIndex !== state.active && !this.act(component, { type: "question", index: questionIndex }, ctx)) {
        return false;
      }
      const key = question.multi === true ? "space" : "enter";
      if (!selectRow(ctx.sendKey, state.cursor[questionIndex] ?? 0, target, key)) return false;

      if (question.multi === true) {
        const chosen = new Set(state.answers.get(question.id) ?? []);
        if (chosen.has(label)) chosen.delete(label);
        else chosen.add(label);
        state.answers.set(question.id, [...chosen]);
      } else {
        state.answers.set(question.id, [label]);
        // Enter commits the answer and moves to the next question, where the host again
        // parks the option cursor on that question's recommended row.
        state.active = Math.min(questions.length - 1, questionIndex + 1);
        state.cursor[state.active] = questions[state.active]?.recommended ?? 0;
      }
      return true;
    }

    if (action.type === "submit") {
      // Everything is answered: Enter is the dialog's own submit key.
      return ctx.sendKey("enter");
    }

    return false;
  },
};
