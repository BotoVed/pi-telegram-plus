import { stripAnsi } from "./custom-dialogs.ts";
import { log } from "./logger.ts";

const bridgeLog = log.child("tui-bridge");

export type TuiHost = "pi" | "omp" | "unknown";

export type TuiCommand = {
  name: string;
  description?: string;
  aliases?: string[];
  source: "builtin" | "autocomplete" | "host";
};

export type TuiSnapshot = {
  /** ANSI-free rendered terminal text. */
  text: string;
  /** True when a selector/overlay owns focus instead of the editor. */
  interactive: boolean;
  host: TuiHost;
  width: number;
};

type HostObject = Record<string, unknown>;
type HostCallable = ((this: unknown, ...args: unknown[]) => unknown) & {
  __ptpBridgePatched?: boolean;
  __ptpBridgeSubmit?: boolean;
};

export type TuiBridgeAdapter = {
  ready(): Promise<void>;
  isAvailable(): boolean;
  getHost(): TuiHost;
  getCommands(): Promise<TuiCommand[]>;
  submit(text: string): boolean;
  snapshot(width: number): TuiSnapshot | undefined;
  key(name: string): boolean;
  write(text: string): boolean;
  isEditorFocused(): boolean;
  isInteractiveFocus(): boolean;
  onLocalSubmit(listener: (text: string) => void): () => void;
};

type BridgeState = {
  mode?: HostObject;
  ui?: HostObject;
  editor?: HostObject;
  host: TuiHost;
  hostCommands: TuiCommand[];
  suppressLocalSubmit: boolean;
  localSubscribers: Set<(text: string) => void>;
};

const state: BridgeState = {
  host: "unknown",
  hostCommands: [],
  suppressLocalSubmit: false,
  localSubscribers: new Set(),
};

const editorWrappers = new WeakMap<HostObject, { original: HostCallable; wrapped: HostCallable }>();

let installPromise: Promise<void> | undefined;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function asHostObject(value: unknown): HostObject | undefined {
  return value && typeof value === "object" ? (value as HostObject) : undefined;
}

function asHostConstructor(value: unknown): HostObject | undefined {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  const prototype = (value as { prototype?: unknown }).prototype;
  return asHostObject(prototype);
}

function asCallable(value: unknown): HostCallable | undefined {
  return typeof value === "function" ? (value as HostCallable) : undefined;
}

async function loadOmpMode(): Promise<HostObject | undefined> {
  try {
    const mod: unknown = await import("@oh-my-pi/pi-coding-agent/modes/interactive-mode");
    return asHostObject(mod);
  } catch {
    return undefined;
  }
}

async function loadPiMode(): Promise<HostObject | undefined> {
  try {
    const mod: unknown = await import("@earendil-works/pi-coding-agent");
    return asHostObject(mod);
  } catch {
    return undefined;
  }
}

async function loadOmpCommands(): Promise<TuiCommand[]> {
  try {
    const mod: unknown = await import("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry");
    const moduleObject = asHostObject(mod);
    return commandList(moduleObject?.BUILTIN_SLASH_COMMAND_DEFS, "builtin");
  } catch {
    return [];
  }
}

function patchMethod(prototype: HostObject, name: string, host: TuiHost): boolean {
  const original = asCallable(prototype[name]);
  if (!original || original.__ptpBridgePatched) return false;
  const wrapped: HostCallable = function patched(this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    captureMode(this, host);
    return result;
  };
  wrapped.__ptpBridgePatched = true;
  prototype[name] = wrapped;
  return true;
}

function captureMode(mode: unknown, host: TuiHost): void {
  const modeObject = asHostObject(mode);
  if (!modeObject) return;
  let editor = asHostObject(modeObject.editor ?? modeObject.defaultEditor ?? modeObject.input);
  const ui = asHostObject(modeObject.ui ?? modeObject.uiContext ?? modeObject.tui ?? modeObject.app);
  if (!editor && ui) {
    const getEditor = asCallable(ui.getEditor);
    if (getEditor) {
      try {
        editor = asHostObject(getEditor.call(ui));
      } catch {
        // Host may expose getEditor before initialization completes.
      }
    }
    editor ??= asHostObject(modeObject.editor ?? ui.editor ?? ui.input);
  }
  if (!editor && !ui) return;

  state.mode = modeObject;
  state.host = host;
  state.ui = ui;
  state.editor = editor;
  ensureWrappedEditor();
  bridgeLog.debug("captured TUI mode", { host, hasEditor: !!state.editor, hasUi: !!state.ui });
}

export function installTuiBridge(): Promise<void> {
  if (installPromise) return installPromise;
  installPromise = (async () => {
    const [omp, ompCommands, pi] = await Promise.all([
      loadOmpMode(),
      loadOmpCommands(),
      loadPiMode(),
    ]);
    state.hostCommands = ompCommands;
    const ompProto = asHostConstructor(omp?.InteractiveMode);
    if (ompProto) {
      patchMethod(ompProto, "initHooksAndCustomTools", "omp");
      patchMethod(ompProto, "render", "omp");
    }
    const piProto = asHostConstructor(pi?.InteractiveMode);
    if (piProto) {
      patchMethod(piProto, "setupEditorSubmitHandler", "pi");
      patchMethod(piProto, "initHooksAndCustomTools", "pi");
      patchMethod(piProto, "init", "pi");
      patchMethod(piProto, "run", "pi");
    }
    if (!ompProto && !piProto) bridgeLog.debug("TUI bridge unavailable: no InteractiveMode export");
  })();
  return installPromise;
}

function ensureWrappedEditor(): void {
  const editor = state.editor;
  if (!editor) return;
  const current = asCallable(editor.onSubmit);
  if (!current) return;

  const existing = editorWrappers.get(editor);
  if (existing?.wrapped === current) return;

  // If the host replaced onSubmit after we wrapped it, wrap the replacement.
  // Wrapper state is per editor so a new session never calls the previous
  // session's submit closure.
  const original = current;
  const wrapped: HostCallable = function patchedSubmit(this: unknown, ...args: unknown[]) {
    const text = typeof args[0] === "string" ? args[0] : "";
    if (!state.suppressLocalSubmit) {
      for (const listener of state.localSubscribers) {
        try {
          listener(text);
        } catch (err) {
          bridgeLog.debug("local submit listener failed", { err });
        }
      }
    }
    return original.apply(this, args);
  };
  wrapped.__ptpBridgeSubmit = true;
  editorWrappers.set(editor, { original, wrapped });
  editor.onSubmit = wrapped;
}

function focusedComponent(): HostObject | undefined {
  const ui = state.ui;
  if (!ui) return undefined;
  for (const name of ["getFocus", "getFocused"]) {
    const getter = asCallable(ui[name]);
    if (!getter) continue;
    try {
      const focused = asHostObject(getter.call(ui));
      if (focused) return focused;
    } catch {
      // A host can expose the getter before its focus tree is initialized.
    }
  }
  return asHostObject(ui.focusedComponent ?? ui.focused);
}

function isEditorFocused(): boolean {
  const focused = focusedComponent();
  if (!focused) return true;
  const editor = state.editor;
  if (!editor) return false;
  return focused === editor || focused === asHostObject(editor.editor);
}

function isInteractiveFocus(): boolean {
  const focused = focusedComponent();
  if (focused) return !isEditorFocused();

  // pi exposes extension overlays as mode fields. OMP exposes focus through
  // ui.getFocused(), handled above. No screen-text heuristics: normal output
  // can contain words such as "settings" or brackets.
  const mode = state.mode;
  if (!mode) return false;
  return [
    "extensionSelector",
    "extensionInput",
    "extensionEditor",
    "settingsSelector",
    "selector",
    "overlay",
  ].some((name) => asHostObject(mode[name]) !== undefined);
}
function renderScreen(width: number): string | undefined {
  const ui = state.ui;
  if (!ui) return undefined;
  const render = asCallable(ui.render);
  if (!render) return undefined;
  let lines: unknown;
  try {
    lines = render.call(ui, width);
  } catch (err) {
    bridgeLog.debug("TUI render failed", { err });
    return undefined;
  }
  if (!Array.isArray(lines)) return undefined;
  return lines.map((line) => stripAnsi(String(line))).join("\n");
}

function commandList(value: unknown, source: TuiCommand["source"]): TuiCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: TuiCommand[] = [];
  for (const item of value) {
    const command = asHostObject(item);
    if (!command) continue;
    const nameValue = command.name ?? command.value;
    if (typeof nameValue !== "string" || !nameValue.trim()) continue;
    const description = typeof command.description === "string" ? command.description : undefined;
    const aliases = Array.isArray(command.aliases)
      ? command.aliases.filter((alias): alias is string => typeof alias === "string")
      : undefined;
    commands.push({
      name: nameValue.trim(),
      description,
      source,
      ...(aliases?.length ? { aliases } : {}),
    });
  }
  return commands;
}

async function buildCommandCatalog(): Promise<TuiCommand[]> {
  await installTuiBridge();
  const commands: TuiCommand[] = [];
  const seen = new Set<string>();
  const add = (command: TuiCommand): void => {
    const name = command.name.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    commands.push({ ...command, name });
  };

  if (state.host === "omp") {
    for (const command of state.hostCommands) add(command);
  }

  const mode = state.mode;
  const editor = state.editor;
  const providers = [
    asHostObject(mode?.autocompleteProvider),
    asHostObject(editor?.autocompleteProvider),
  ];
  for (const provider of providers) {
    for (const command of commandList(provider?.commands, "autocomplete")) add(command);
  }

  const session = asHostObject(mode?.session);
  for (const source of [session?.slashCommands, session?.customCommands, session?.promptTemplates]) {
    for (const command of commandList(source, "host")) add(command);
  }
  bridgeLog.debug("command catalog built", { host: state.host, builtin: state.hostCommands.length, total: commands.length });
  return commands;
}

export async function getTuiCommands(): Promise<TuiCommand[]> {
  return buildCommandCatalog();
}

const KEY_SEQUENCES: Record<string, string> = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  esc: "\x1b",
  space: " ",
  tab: "\t",
};

function injectInput(sequence: string): boolean {
  ensureWrappedEditor();
  const ui = state.ui;
  if (!ui) return false;

  // These are host input-pipeline methods. terminal.write() is deliberately
  // excluded: it writes bytes to stdout and does not deliver keyboard input.
  for (const name of ["injectDebugInput", "handleInput", "input", "dispatchKey", "sendKey"]) {
    const input = asCallable(ui[name]);
    if (!input) continue;
    try {
      input.call(ui, sequence);
      return true;
    } catch {
      // Try the next host-specific input route.
    }
  }

  const focused = focusedComponent();
  const handleFocusedInput = focused ? asCallable(focused.handleInput) : undefined;
  if (handleFocusedInput) {
    try {
      handleFocusedInput.call(focused, sequence);
      const requestRender = asCallable(ui.requestRender);
      requestRender?.call(ui);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function injectKey(name: string): boolean {
  const sequence = KEY_SEQUENCES[name.toLowerCase()];
  return sequence !== undefined && injectInput(sequence);
}

function submitToHost(text: string): boolean {
  const editor = state.editor;
  if (!editor) return false;
  const setText = asCallable(editor.setText);
  if (setText) {
    try {
      setText.call(editor, text);
    } catch (err) {
      bridgeLog.debug("TUI setText failed", { err });
      return false;
    }
  }
  const submit = asCallable(editor.onSubmit);
  if (!submit) return false;
  state.suppressLocalSubmit = true;
  try {
    submit.call(editor, text);
  } catch (err) {
    bridgeLog.debug("TUI submit failed", { err });
    return false;
  } finally {
    state.suppressLocalSubmit = false;
  }
  return true;
}

export const tuiBridge: TuiBridgeAdapter = {
  async ready(): Promise<void> {
    await installTuiBridge();
    for (let attempt = 0; attempt < 120; attempt += 1) {
      ensureWrappedEditor();
      if (state.mode && state.editor && state.ui) return;
      await sleep(25);
    }
  },
  isAvailable: () => state.mode !== undefined && state.editor !== undefined && state.ui !== undefined,
  getHost: () => state.host,
  getCommands: () => getTuiCommands(),
  submit: (text: string) => submitToHost(text),
  snapshot(width: number): TuiSnapshot | undefined {
    ensureWrappedEditor();
    const text = renderScreen(width);
    if (text === undefined) return undefined;
    return { text, interactive: isInteractiveFocus(), host: state.host, width };
  },
  key: (name: string) => injectKey(name),
  write: (text: string) => text.length > 0 && injectInput(text),
  isEditorFocused,
  isInteractiveFocus,
  onLocalSubmit(listener: (text: string) => void): () => void {
    state.localSubscribers.add(listener);
    ensureWrappedEditor();
    return () => { state.localSubscribers.delete(listener); };
  },
};