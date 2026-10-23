/**
 * FocusTracker (stage 1): the host's focus is the authority for "is a dialog
 * open?" and for the command scope end condition. It only observes; the
 * DialogBroker in stage 3 is the first consumer that acts on dialog focus.
 */
import { onHostState, hookMethod, isHostObject, type HostState } from "./host.ts";
import { log } from "../logger.ts";

const focusLog = log.child("tui-focus");

export type FocusKind = "editor" | "inert" | "dialog" | "progress" | "unknown";

export type FocusInfo = {
  kind: FocusKind;
  component?: Record<string, unknown>;
  /** How the value was obtained; useful in logs and tests. */
  source: "event" | "getter" | "field" | "none";
};

type FocusListener = (info: FocusInfo) => void;

const DIALOG_NAME = /(Selector|Dialog|Input|Editor|Panel|List|Question|Permission|Approval|Confirm|Settings|Menu|Wizard|Form|Prompt)/i;
const DIALOG_FIELDS = [
  "items", "filteredItems", "filteredModels", "filteredProviders", "filteredSessions",
  "options", "selectedIndex", "onSelect", "onSelectCallback", "callbacks", "children",
];

function ctorName(value: Record<string, unknown>): string {
  try {
    return Object.getPrototypeOf(value)?.constructor?.name ?? value.constructor?.name ?? "";
  } catch {
    return "";
  }
}

function own(value: Record<string, unknown>, name: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(value, name);
  } catch {
    return false;
  }
}

/** pi wraps the focus argument in `{component, overlayFocusRestore}`. */
function unwrapFocus(value: unknown): Record<string, unknown> | undefined {
  if (!isHostObject(value)) return undefined;
  const wrapped = value.component;
  if (isHostObject(wrapped)) return wrapped;
  return value;
}

export class FocusTracker {
  private info: FocusInfo = { kind: "unknown", source: "none" };
  private editor?: Record<string, unknown>;
  private readonly listeners = new Set<FocusListener>();
  private readonly attached = new WeakSet<object>();
  private unsubscribe?: () => void;

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = onHostState((state) => this.attach(state));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  current(): FocusInfo {
    return this.info;
  }

  isEditor(): boolean {
    return this.info.kind === "editor" || this.info.kind === "unknown";
  }

  isDialog(): boolean {
    return this.info.kind === "dialog" || this.info.kind === "progress";
  }

  onChange(listener: FocusListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private attach(state: HostState): void {
    this.editor = state.editor ?? state.defaultEditor;
    const ui = state.ui;
    if (!ui) return;
    this.attachUi(ui);
    const getter = this.readCurrent(ui);
    if (getter) this.update(getter, "getter");
    else if (this.info.source === "none" && this.editor) {
      this.update(this.editor, "field");
    }
  }

  private attachUi(ui: Record<string, unknown>): void {
    if (this.attached.has(ui)) return;
    this.attached.add(ui);
    for (const name of ["setFocus", "setFocusInternal"]) {
      hookMethod(ui, name, "focus-tracker", (args) => {
        const component = unwrapFocus(args[0]);
        if (component) this.update(component, "event");
      });
    }
    // OMP exposes getFocused(); pi has no getter, so wrap showOverlay/hideOverlay
    // to refresh after the host returns focus without a setFocus call.
    for (const name of ["showOverlay", "hideOverlay"]) {
      hookMethod(ui, name, "focus-tracker-overlay", undefined, () => {
        const current = this.readCurrent(ui);
        if (current) this.update(current, "getter");
      });
    }
  }

  private readCurrent(ui: Record<string, unknown>): Record<string, unknown> | undefined {
    for (const name of ["getFocused", "getFocus"]) {
      const getter = ui[name];
      if (typeof getter !== "function") continue;
      try {
        const value = (getter as (this: unknown) => unknown).call(ui);
        if (isHostObject(value)) return value;
      } catch {
        // focus tree may not be initialized yet
      }
    }
    const field = ui.focusedComponent ?? ui.focused;
    return isHostObject(field) ? field : undefined;
  }

  private update(component: Record<string, unknown>, source: FocusInfo["source"]): void {
    const kind = this.classify(component);
    if (this.info.kind === kind && this.info.component === component) return;
    this.info = { kind, component, source };
    focusLog.debug("focus changed", { kind, source, ctor: ctorName(component) });
    for (const listener of this.listeners) {
      try { listener(this.info); } catch (err) { focusLog.debug("focus listener failed", { err }); }
    }
  }

  private classify(component: Record<string, unknown>): FocusKind {
    const editor = this.editor;
    if (editor) {
      if (component === editor) return "editor";
      const editorInner = editor.editor;
      if (isHostObject(editorInner) && component === editorInner) return "editor";
    }
    const handleInput = component.handleInput;
    const render = component.render;
    if (typeof handleInput !== "function" && typeof render !== "function") return "inert";
    const name = ctorName(component);
    if (DIALOG_NAME.test(name)) return "dialog";
    if (typeof handleInput === "function") {
      for (const field of DIALOG_FIELDS) {
        if (own(component, field)) return "dialog";
      }
      return "progress";
    }
    // Render-only components (Text/Markdown output) are not dialogs.
    if (typeof render === "function") return "inert";
    return "unknown";
  }
}
