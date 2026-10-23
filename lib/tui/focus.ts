/**
 * FocusTracker (stage 2): the host's focus is the authority for "is a dialog
 * open?", for what that dialog *means*, and for the command scope end
 * condition. It only observes; DialogBroker is the consumer that acts.
 *
 * Three things happen here (§4.1):
 * - focus events: `ui.setFocus` / `setFocusInternal` hooks, plus a one-second
 *   verification read for the input path that bypasses both;
 * - semantic association: the entry hooks (`entry.ts`) push an `EntryInfo`
 *   while a dialog is being created, which is matched to the focused component
 *   here — no time windows;
 * - local input marking: the editor's own `handleInput` is wrapped once so a
 *   keystroke in the terminal is distinguishable from anything the plugin does.
 */
import { onHostState, hookMethod, isHostObject, type HostState } from "./host.ts";
import { hookEntryMethods, PI_ENTRY_SPECS, UI_CONTEXT_SPECS, OMP_ENTRY_SPECS, type EntrySink } from "./entry.ts";
import { isEditorShape, isFilteredList, isInputShape, isReadOnlyPanel, isSelectList, isSettingsList } from "./find-shape.ts";
import type { EntryInfo } from "./model.ts";
import { log } from "../logger.ts";

const focusLog = log.child("tui-focus");

export type FocusKind = "editor" | "inert" | "progress" | "dialog" | "unknown";

export type FocusInfo = {
  kind: FocusKind;
  component?: Record<string, unknown>;
  /** The container the dialog was mounted into; used to find titles only. */
  root?: Record<string, unknown>;
  /** How the value was obtained; useful in logs and tests. */
  source: "event" | "getter" | "field" | "none";
};

type FocusListener = (info: FocusInfo) => void;
type OpenListener = (component: Record<string, unknown>, info: FocusInfo) => void;
type CloseListener = (component: Record<string, unknown>, info: FocusInfo) => void;

/** How many verification reads must agree before a silent focus change counts. */
const VERIFY_SAMPLES = 2;
const VERIFY_MS = 1_000;
const MAX_PENDING_ENTRIES = 8;
const ENTRY_TTL_MS = 5_000;

function ctorName(value: Record<string, unknown>): string {
  try {
    return Object.getPrototypeOf(value)?.constructor?.name ?? "";
  } catch {
    return "";
  }
}

/** pi wraps the focus argument in `{component, overlayFocusRestore}`. */
function unwrapFocus(value: unknown): Record<string, unknown> | undefined {
  if (!isHostObject(value)) return undefined;
  const wrapped = value.component;
  if (isHostObject(wrapped)) return wrapped;
  return value;
}
/** Depth-limited containment check used by the mount lookup. */
function containsComponent(container: Record<string, unknown>, component: object, depth = 3): boolean {
  if (depth <= 0) return false;
  const children = container.children;
  if (!Array.isArray(children)) return false;
  for (const child of children) {
    if (child === component) return true;
    if (isHostObject(child) && containsComponent(child, component, depth - 1)) return true;
  }
  return false;
}


const DIALOG_NAME = /(Selector|Dialog|Input|Editor|Panel|List|Question|Permission|Approval|Confirm|Settings|Menu|Wizard|Form|Prompt)/i;

export class FocusTracker {
  private info: FocusInfo = { kind: "unknown", source: "none" };
  private editor?: Record<string, unknown>;
  private readonly listeners = new Set<FocusListener>();
  private readonly openedListeners = new Set<OpenListener>();
  private readonly closedListeners = new Set<CloseListener>();
  private readonly attached = new WeakSet<object>();
  private readonly entryByComponent = new WeakMap<object, EntryInfo>();
  /** Entries recorded by the entry hooks, innermost last (§4.1.2). */
  private pending: Array<{ info: EntryInfo; at: number }> = [];
  private readonly localInput = new Map<object, number>();
  private verifyTarget?: Record<string, unknown>;
  private verifyCount = 0;
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private readonly tagged = new WeakSet<object>();

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = onHostState((state) => this.attach(state));
    this.timer = setInterval(() => this.verify(), VERIFY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
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

  onOpened(listener: OpenListener): () => void {
    this.openedListeners.add(listener);
    return () => { this.openedListeners.delete(listener); };
  }

  onClosed(listener: CloseListener): () => void {
    this.closedListeners.add(listener);
    return () => { this.closedListeners.delete(listener); };
  }

  // --- entry association (§4.1.2) -------------------------------------------

  /** True when the entry was recorded; false when merged into a pending one. */
  pushEntry(info: EntryInfo): boolean {
    const top = this.pending[this.pending.length - 1];
    if (top && Date.now() - top.at < ENTRY_TTL_MS) {
      const nested = info.kind === "select" || info.kind === top.info.kind;
      if (nested) {
        // Nested entry (confirm → selector, tool context → mode delegate):
        // enrich the outer entry, never change its kind.
        if (info.options && !top.info.options) top.info.options = info.options;
        if (info.questions && !top.info.questions) top.info.questions = info.questions;
        if (info.secret) top.info.secret = true;
        if (info.approval && !top.info.approval) top.info.approval = info.approval;
        return false;
      }
    }
    this.pending.push({ info, at: Date.now() });
    while (this.pending.length > MAX_PENDING_ENTRIES) this.pending.shift();
    return true;
  }

  popEntry(pushed: boolean): void {
    if (!pushed) return;
    this.pending.pop();
  }

  /** The semantic entry of a component: recorded first, then stack top. */
  entryFor(component: Record<string, unknown>): EntryInfo | undefined {
    const recorded = this.entryByComponent.get(component);
    if (recorded) return recorded;
    const top = this.pending[this.pending.length - 1];
    if (!top || Date.now() - top.at > ENTRY_TTL_MS) return undefined;
    this.entryByComponent.set(component, top.info);
    return top.info;
  }

  /** Records an entry for a component produced outside a focus event. */
  bindEntry(component: object, info: EntryInfo): void {
    this.entryByComponent.set(component, info);
  }

  // --- local input marking (§4.1.3 / §4.2.4) --------------------------------

  /** True once per burst: the terminal user typed into this component. */
  consumeLocalInput(component: Record<string, unknown>): boolean {
    const stamped = this.localInput.get(component);
    if (stamped === undefined) return false;
    this.localInput.delete(component);
    // Two keystrokes within a second are one burst of typing.
    return Date.now() - stamped > 0;
  }

  private markLocalInput(component: Record<string, unknown>): void {
    this.localInput.set(component, Date.now());
  }

  private watchEditor(component: Record<string, unknown>): void {
    if (this.tagged.has(component)) return;
    const original = component.handleInput;
    if (typeof original !== "function") return;
    this.tagged.add(component);
    const tracker = this;
    const wrapped = function patchedHandleInput(this: unknown, ...args: unknown[]): unknown {
      // The plugin never calls the editor's handleInput, so this is local.
      tracker.markLocalInput(component);
      return (original as (...inputArgs: unknown[]) => unknown).apply(this, args);
    };
    try {
      component.handleInput = wrapped;
    } catch {
      // Read-only host object; draft protection degrades to "keep".
    }
  }

  // --- observation -----------------------------------------------------------

  private attach(state: HostState): void {
    this.lastState = state;
    this.editor = state.editor ?? state.defaultEditor;
    const ui = state.ui;
    if (this.editor) this.watchEditor(this.editor);
    if (!ui) return;
    this.attachUi(ui);
    this.attachEntryHooks(state);
    const getter = this.readCurrent(ui);
    if (getter) this.update(getter, "getter");
    else if (this.info.source === "none" && this.editor) this.update(this.editor, "field");
  }

  private attachUi(ui: Record<string, unknown>): void {
    const alreadyAttached = this.attached.has(ui);
    if (!alreadyAttached) {
      this.attached.add(ui);
      for (const name of ["setFocus", "setFocusInternal"]) {
        hookMethod(ui, name, "focus-tracker", (args) => {
          const component = unwrapFocus(args[0]);
          if (component) this.update(component, "event");
        });
      }
      // Overlay swaps that never reach `setFocus` are caught by the tick.
      for (const name of ["showOverlay", "hideOverlay"]) {
        hookMethod(ui, name, "focus-tracker-overlay", undefined, () => {
          const current = this.readCurrent(ui);
          if (current) this.update(current, "getter");
        });
      }
    }
  }

  /** Install the entry-method hooks for this host (§4.1.2). */
  private attachEntryHooks(state: HostState): void {
    const sink: EntrySink = {
      push: (info) => { this.pushEntry(info); return true; },
      pop: (pushed) => this.popEntry(pushed),
      bind: (component, info) => this.bindEntry(component, info),
    };
    const ui = state.ui;
    if (ui) hookEntryMethods(ui, UI_CONTEXT_SPECS, sink, state.host === "omp" ? "omp" : "pi", this.tagged);
    const runner = (state.session as Record<string, unknown> | undefined)?.extensionRunner as
      | { getUIContext?: () => unknown }
      | undefined;
    const toolUi = this.readUiContext(runner);
    if (toolUi && toolUi !== ui) {
      hookEntryMethods(toolUi, UI_CONTEXT_SPECS, sink, state.host === "omp" ? "omp" : "pi", this.tagged);
    }
    if (state.host === "omp") hookEntryMethods(state.mode, OMP_ENTRY_SPECS, sink, "omp", this.tagged);
    if (state.host === "pi") hookEntryMethods(state.mode, PI_ENTRY_SPECS, sink, "pi", this.tagged);
  }

  private readUiContext(runner?: { getUIContext?: () => unknown }): Record<string, unknown> | undefined {
    const getUi = runner?.getUIContext;
    if (typeof getUi !== "function") return undefined;
    try {
      const value = getUi.call(runner);
      // Our own routed UI (a proxy over the host context) must not be patched.
      if ((value as Record<string, unknown> | undefined)?.__piTelegramPlusRoutedUi === true) return undefined;
      return isHostObject(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private readCurrent(ui: Record<string, unknown>): Record<string, unknown> | undefined {
    for (const name of ["getFocused", "getFocus"]) {
      const getter = ui[name];
      if (typeof getter !== "function") continue;
      try {
        const value = unwrapFocus((getter as (this: unknown) => unknown).call(ui));
        if (value) return value;
      } catch {
        // The focus tree may not be initialized yet.
      }
    }
    const field = ui.focusedComponent ?? ui.focused;
    return isHostObject(field) ? field : undefined;
  }

  /**
   * Verification path (§4.1.3): pi's `focusedComponent` lags one event, so a
   * single disagreeing read is not trusted. Two consecutive reads of the same
   * other component mean the change really happened without an event.
   */
  private verify(): void {
    const ui = this.lastState?.ui;
    if (!ui) return;
    const read = this.readCurrent(ui);
    if (!read || read === this.info.component) {
      this.verifyTarget = undefined;
      this.verifyCount = 0;
      return;
    }
    if (this.verifyTarget === read) this.verifyCount += 1;
    else {
      this.verifyTarget = read;
      this.verifyCount = 1;
    }
    // Two agreeing reads, so a one-event-stale reading never closes a dialog.
    if (this.verifyCount < VERIFY_SAMPLES) return;
    this.verifyTarget = undefined;
    this.verifyCount = 0;
    this.update(read, "getter");
  }


  private lastState?: HostState;

  private update(component: Record<string, unknown>, source: FocusInfo["source"]): void {
    const previous = this.info;
    const kind = this.classify(component);
    if (previous.kind === kind && previous.component === component) return;
    const root = this.findRoot(component);
    this.info = { kind, component, root, source };
    focusLog.debug("focus changed", { kind, source, ctor: ctorName(component) });
    for (const listener of this.listeners) {
      try { listener(this.info); } catch (err) { focusLog.debug("focus listener failed", { err }); }
    }
    // Closing the old dialog is reported before opening the new one so the
    // Broker can retire a session even when focus jumps straight to a dialog.
    const previousDialog = previous.component && (previous.kind === "dialog" || previous.kind === "progress") ? previous.component : undefined;
    if (previousDialog && previousDialog !== component) {
      for (const listener of this.closedListeners) {
        try { listener(previousDialog, previous); } catch (err) { focusLog.debug("closed listener failed", { err }); }
      }
    }
    if (kind === "dialog" || kind === "progress") {
      for (const listener of this.openedListeners) {
        try { listener(component, this.info); } catch (err) { focusLog.debug("opened listener failed", { err }); }
      }
    }
  }

  /** Where the dialog was mounted: editor container, overlay, or chat feed. */
  private findRoot(component: Record<string, unknown>): Record<string, unknown> | undefined {
    const state = this.lastState;
    if (!state) return undefined;
    const editorContainer = state.mode ? (state.mode as Record<string, unknown>).editorContainer : undefined;
    const overlayStack = state.ui?.overlayStack;
    const overlay = Array.isArray(overlayStack) && overlayStack.length > 0 ? overlayStack[overlayStack.length - 1] : undefined;
    for (const candidate of [editorContainer, overlay, state.chat]) {
      if (!isHostObject(candidate)) continue;
      if (candidate === component || containsComponent(candidate, component)) return candidate;
    }
    return undefined;
  }

  private classify(component: Record<string, unknown>): FocusKind {
    const editor = this.editor;
    if (editor) {
      if (component === editor) return "editor";
      const editorInner = editor.editor;
      if (isHostObject(editorInner) && component === editorInner) return "editor";
    }
    if (typeof component.render !== "function") return "inert";
    if (typeof component.handleInput !== "function") {
      // A loader or a read-only view still owns focus, so chat text must not
      // fall through to the editor: treat it as a dialog with only a way out.
      return isReadOnlyPanel(component) ? "progress" : "inert";
    }
    const interactive: Record<string, unknown> = component;
    if (isSelectList(interactive) || isSettingsList(interactive) || isFilteredList(interactive)
      || isInputShape(interactive) || isEditorShape(interactive)) {
      return "dialog";
    }
    const name = ctorName(component);
    if (name.endsWith("Loader")) return "progress";
    if (component.signal !== undefined || component.abortController !== undefined) return "progress";
    if (DIALOG_NAME.test(name)) return "dialog";
    if (typeof component.options === "string" || Array.isArray(component.options)) return "dialog";
    if (typeof component.selectedIndex === "number") return "dialog";
    // Keys but no list, no input: a status/progress widget, not a dialog.
    return "progress";
  }
}