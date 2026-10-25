/**
 * Adapter T3.2d: OMP components that describe themselves through the Tern
 * Surface Protocol (§4.11.3).
 *
 * OMP's picker-shaped components implement `describe(cx)` (a semantic tree of
 * `NativeNode`s) and `handleNativeEvent(event)` (structured events keyed by a
 * node's keypath inside its owner component). Reading the tree and answering
 * with events means this adapter never looks at the screen and never sends
 * keys - the two things §4.11 forbids.
 *
 * Keypath rules (pi-tui `native/reconcile.ts`): a component's root node has
 * keypath `""`; a child's segment is its `key`, or its index when unkeyed,
 * joined with `/`. A child `Component` is a boundary: its nodes live in its
 * own namespace, so the keypath restarts at `""` and events go to the child.
 *
 * Scope: single-select pickers and settings pages. While an extension dialog
 * is racing the host (§4.12), both adapters decline - the race owns the entry.
 * While a picker's action strip is open (the model hub's role chips after
 * activating a model), the picker adapter shows and answers the strip, not
 * the list; a strip without chips (name entry) stays with the terminal.
 * Multi-select is T3.2f.
 */
import type { DialogAdapter, DialogItem, DialogModel } from "../model.ts";
import { setInputValue } from "../keys.ts";

/** What a component may consult while describing itself (§4.11.3); never a clock. */
const DESCRIBE_CONTEXT = {
  cols: 80,
  reduceMotion: true,
  dark: true,
  hour12: false,
  supports: () => true,
  feature: () => false,
};

/** How deep we follow component boundaries before giving up. */
const MAX_COMPONENT_DEPTH = 4;

type HostRecord = Record<string, unknown>;

/** A described node, matched by shape only (the host may load its own copy). */
type NativeNodeLike = HostRecord & { k?: unknown; p?: unknown; c?: unknown; key?: unknown };

/** The picker props this adapter reads (`TspPickerProps` in pi-wire). */
type PickerProps = {
  title?: unknown;
  items?: readonly PickerItemLike[];
  order?: readonly unknown[];
  selected?: unknown;
  current?: readonly unknown[];
  total?: unknown;
  /** The chip strip docked above the action bar; null when absent. */
  strip?: unknown;
  /** Shown in place of the list when it holds no visible items (`TspText`). */
  empty?: unknown;
  /** Status line above the list (`TspText`); fallback for `empty`. */
  message?: unknown;
  /** Tab row above the list (`TspPickerProps.tabs`); `tab` is the active id. */
  tabs?: readonly PickerEntryLike[];
  tab?: unknown;
  /** Scope filter row; `scope` is the active id, entries may be disabled. */
  scopes?: readonly PickerEntryLike[];
  scope?: unknown;
  /** Action bar below the list (e.g. `/tree`'s Switch / Label / Filter). */
  actions?: readonly PickerEntryLike[];
  /** Search box contents; null/absent means the picker has no search box. */
  query?: unknown;
};

/** Tab, scope or action-bar entry: an id, a `TspText` label, optional disable. */
type PickerEntryLike = { id?: unknown; label?: unknown; disabled?: unknown };

type PickerItemLike = { id?: unknown; label?: unknown; detail?: unknown; disabled?: unknown };

/** The picker's action strip: chips the user picks after activating an item. */
type StripChipLike = { id?: unknown; label?: unknown; on?: unknown };

type StripLike = { label?: unknown; items: readonly StripChipLike[]; selected?: unknown };

/** The settings-page props (`TspPrefsProps` in pi-wire). */
type PrefsProps = {
  title?: unknown;
  pages?: readonly PrefsPageLike[];
  page?: unknown;
  sections?: readonly PrefsSectionLike[];
  focus?: unknown;
};

type PrefsPageLike = { id?: unknown; label?: unknown; disabled?: unknown };

type PrefsSectionLike = { id?: unknown; title?: unknown; rows?: unknown };

type PrefsRowLike = { id?: unknown; label?: unknown; hint?: unknown; disabled?: unknown; control?: unknown };

/** The described kinds this file drives, and the props each one carries. */
type NodePropsByKind = { picker: PickerProps; prefs: PrefsProps };

type NodeKind = keyof NodePropsByKind;

type NodeFound<K extends NodeKind> = { owner: object; keypath: string; props: NodePropsByKind[K] };

type Describable = object & {
  describe(cx: unknown): unknown;
  handleNativeEvent(event: unknown): unknown;
};

const isObject = (value: unknown): value is HostRecord => typeof value === "object" && value !== null;

/** A child slot that is another component: its own describe, its own events. */
function asComponent(value: unknown): Describable | undefined {
  if (!isObject(value)) return undefined;
  const candidate = value as Partial<Describable>;
  if (typeof candidate.describe !== "function" || typeof candidate.handleNativeEvent !== "function") return undefined;
  return value as Describable;
}

/** `TspText`: a plain string, or spans whose `t` pieces concatenate. */
function tspText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((span) => (isObject(span) && typeof span.t === "string" ? span.t : "")).join("");
  }
  return "";
}

function describeTree(component: object): NativeNodeLike | undefined {
  const describe = (component as Partial<Describable>).describe;
  if (typeof describe !== "function") return undefined;
  try {
    const node = describe.call(component, DESCRIBE_CONTEXT);
    return isObject(node) ? (node as NativeNodeLike) : undefined;
  } catch {
    // A describe that throws is "nothing described": never take the dialog down.
    return undefined;
  }
}

/** A node of the wanted kind; props trusted only as far as each adapter's own checks. */
function nodeProps<K extends NodeKind>(node: NativeNodeLike, kind: K): NodePropsByKind[K] | undefined {
  if (node.k !== kind || !isObject(node.p)) return undefined;
  return node.p as NodePropsByKind[K];
}

function walkNode<K extends NodeKind>(node: NativeNodeLike, keypath: string, owner: object, kind: K, depth: number, visited: Set<object>): NodeFound<K> | undefined {
  const props = nodeProps(node, kind);
  if (props) return { owner, keypath, props };
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : undefined;
  if (!children) return undefined;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!isObject(child)) continue;
    const component = asComponent(child);
    if (component) {
      const found = findNodeVisited(component, kind, depth + 1, visited);
      if (found) return found;
      continue;
    }
    const childNode = child as NativeNodeLike;
    if (visited.has(childNode)) continue;
    visited.add(childNode);
    const segment = childNode.key === undefined ? String(i) : String(childNode.key);
    const found = walkNode(childNode, keypath === "" ? segment : `${keypath}/${segment}`, owner, kind, depth, visited);
    if (found) return found;
  }
  return undefined;
}

/**
 * The first `picker` node in `component`'s own description, or in one of the
 * components it nests (up to {@link MAX_COMPONENT_DEPTH} boundaries deep). The
 * returned `owner` is the component whose `handleNativeEvent` takes events for
 * that node, and `keypath` is relative to that owner.
 */
export function findPicker(component: object, depth = 0): NodeFound<"picker"> | undefined {
  return findNode(component, "picker", depth);
}

/**
 * The first node of `kind` in `component`'s own description, or in one of the
 * components it nests (up to {@link MAX_COMPONENT_DEPTH} boundaries deep).
 */
function findNode<K extends NodeKind>(component: object, kind: K, depth = 0): NodeFound<K> | undefined {
  return findNodeVisited(component, kind, depth, new Set<object>());
}

function findNodeVisited<K extends NodeKind>(component: object, kind: K, depth: number, visited: Set<object>): NodeFound<K> | undefined {
  if (depth > MAX_COMPONENT_DEPTH || visited.has(component)) return undefined;
  visited.add(component);
  const root = describeTree(component);
  if (!root) return undefined;
  visited.add(root);
  return walkNode(root, "", component, kind, depth, visited);
}

/**
 * True when `component` describes itself as a picker or a settings page - i.e.
 * the TSP adapters below could drive it. Focus classification uses this to tell
 * an OMP dialog (model picker, settings page) from a spinner: OMP's dialogs
 * carry `signal`/`abortController` fields like a loader does. A `describe` that
 * throws describes nothing, so this is false.
 */
export function describesDialog(component: object): boolean {
  return findNode(component, "picker") !== undefined || findNode(component, "prefs") !== undefined;
}

/** The catalogue id list, honouring `order` (string entries that exist) when present. */
function visibleItems(props: PickerProps): PickerItemLike[] {
  const items = Array.isArray(props.items) ? (props.items as readonly PickerItemLike[]) : [];
  const byId = new Map<string, PickerItemLike>();
  for (const item of items) {
    if (isObject(item) && typeof item.id === "string") byId.set(item.id, item);
  }
  const ordered: PickerItemLike[] = [];
  if (Array.isArray(props.order)) {
    for (const entry of props.order) {
      if (typeof entry !== "string") continue;
      const item = byId.get(entry);
      if (item) ordered.push(item);
    }
  } else {
    ordered.push(...byId.values());
  }
  return ordered.filter((item) => !item.disabled);
}

/** Prefix of the synthetic keys that address a strip chip by index. */
const STRIP_KEY_PREFIX = "strip:";

/**
 * The picker's open action strip, or undefined when there is nothing to pick:
 * a null/absent strip, or one without chips (the name-entry strip wants
 * typing, not choosing, so we leave it to the terminal).
 */
function pickerStrip(props: PickerProps): StripLike | undefined {
  if (!isObject(props.strip)) return undefined;
  const strip = props.strip as Partial<StripLike>;
  if (!Array.isArray(strip.items) || strip.items.length === 0) return undefined;
  return strip as StripLike;
}

/**
 * Prefixes of the synthetic extraAction keys addressing picker entries by
 * index (tab row, scope row, action bar). The key travels verbatim inside
 * callback_data (64-byte Bot API cap) while host ids are unbounded, so the
 * key carries the array index and `act` re-resolves it against live props.
 */
const TAB_KEY_PREFIX = "tab:";
const SCOPE_KEY_PREFIX = "scope:";
const BAR_KEY_PREFIX = "act:";

/** Action-bar ids the renderer's own cancel row already covers. */
const BAR_HIDDEN_IDS: Record<string, true> = { close: true, cancel: true };

/** The tab / scope / action-bar buttons Telegram shows beside the list. */
function pickerExtraActions(props: PickerProps): { label: string; key: string }[] {
  const extras: { label: string; key: string }[] = [];
  if (Array.isArray(props.tabs)) {
    props.tabs.forEach((tab, index) => {
      if (!isObject(tab) || typeof tab.id !== "string") return;
      const marker = props.tab === tab.id ? "● " : "";
      extras.push({ label: `${marker}${tspText(tab.label)}`, key: `${TAB_KEY_PREFIX}${index}` });
    });
  }
  if (Array.isArray(props.scopes)) {
    props.scopes.forEach((scope, index) => {
      if (!isObject(scope) || typeof scope.id !== "string" || scope.disabled) return;
      const marker = props.scope === scope.id ? "● " : "";
      extras.push({ label: `${marker}${tspText(scope.label)}`, key: `${SCOPE_KEY_PREFIX}${index}` });
    });
  }
  if (Array.isArray(props.actions)) {
    props.actions.forEach((entry, index) => {
      // close/cancel are covered by the renderer's own cancel row.
      if (!isObject(entry) || typeof entry.id !== "string" || entry.disabled) return;
      if (BAR_HIDDEN_IDS[entry.id]) return;
      extras.push({ label: tspText(entry.label), key: `${BAR_KEY_PREFIX}${index}` });
    });
  }
  return extras;
}

/** The entry a synthetic key's index points at, with a usable string id. */
function entryAt(list: readonly unknown[] | undefined, raw: string): { id: string; disabled?: unknown } | undefined {
  if (!Array.isArray(list) || !/^\d+$/.test(raw)) return undefined;
  const entry = list[Number(raw)];
  return isObject(entry) && typeof entry.id === "string" ? (entry as { id: string; disabled?: unknown }) : undefined;
}

/**
 * The native event for a `tab:` / `scope:` / `act:` key, re-resolved against
 * the live props on every press: an out-of-range index, or an entry that is
 * now disabled (scopes, bar actions), is refused. A bar entry fires its own
 * id as the action name; tabs and scopes fire `tab` / `scope` carrying the
 * id as value (the OMP picker events).
 */
function pickerBarEvent(keypath: string, props: PickerProps, name: string): unknown {
  if (name.startsWith(TAB_KEY_PREFIX)) {
    const tab = entryAt(props.tabs, name.slice(TAB_KEY_PREFIX.length));
    return tab ? { type: "action", key: keypath, act: "tab", value: tab.id, mods: [] } : undefined;
  }
  if (name.startsWith(SCOPE_KEY_PREFIX)) {
    const scope = entryAt(props.scopes, name.slice(SCOPE_KEY_PREFIX.length));
    return scope && !scope.disabled ? { type: "action", key: keypath, act: "scope", value: scope.id, mods: [] } : undefined;
  }
  if (name.startsWith(BAR_KEY_PREFIX)) {
    const entry = entryAt(props.actions, name.slice(BAR_KEY_PREFIX.length));
    // Same exclusion as read: a stale `act:` key must not resurrect close/cancel.
    if (!entry || entry.disabled || BAR_HIDDEN_IDS[entry.id]) return undefined;
    return { type: "action", key: keypath, act: entry.id, mods: [] };
  }
  return undefined;
}

export const tspPickerAdapter: DialogAdapter = {
  id: "tsp-picker",

  detect(component, ctx) {
    if (ctx.entry?.race) return false; // §4.12: the race owns a raced extension dialog.
    return ctx.host === "omp" && findPicker(component) !== undefined;
  },

  read(component, ctx): DialogModel {
    const found = findPicker(component);
    if (!found) return { kind: "unsupported", what: "OMP picker closed or no longer a picker" };
    const { props } = found;
    const strip = pickerStrip(props);
    if (strip) {
      // The strip is open (e.g. the model hub's role chips after activating a
      // model): the terminal shows the chips, so Telegram shows the chips.
      const items: DialogItem[] = strip.items.map((chip, index) => ({
        key: `${STRIP_KEY_PREFIX}${index}`,
        label: tspText(chip.label),
        current: chip.on === true,
        focused: typeof strip.selected === "string" && strip.selected === chip.id,
      }));
      return {
        kind: "select",
        title: tspText(strip.label) || "Choose a role",
        items,
        total: items.length,
      };
    }
    const currentIds = Array.isArray(props.current) ? props.current : [];
    const items: DialogItem[] = visibleItems(props).map((item) => {
      const description = item.detail === undefined ? undefined : tspText(item.detail);
      return {
        key: item.id as string,
        label: tspText(item.label),
        ...(description ? { description } : {}),
        current: currentIds.includes(item.id),
        focused: props.selected === item.id,
      };
    });
    const extraActions = pickerExtraActions(props);
    const search = typeof props.query === "string" ? { query: props.query } : undefined;
    const title = typeof props.title === "string" ? props.title : "Select";
    if (items.length === 0) {
      const text = tspText(props.empty) || tspText(props.message) || "Nothing to show";
      if (extraActions.length === 0 && !search) {
        // Nothing to choose and nothing to switch/filter/search by either
        // (e.g. `/hub` with no running agents): an info card whose only
        // action is close; `act` maps cancel onto the picker's `close`.
        return { kind: "info", title, text, closable: true };
      }
      // Tabs, scopes, bar actions and search still apply to an empty result
      // (e.g. `/tree` filtered down to nothing): stay a select with no rows
      // so those buttons survive, with the empty-state text in the title.
      return {
        kind: "select",
        title: `${title} — ${text}`,
        items: [],
        total: 0,
        ...(search ? { search } : {}),
        ...(extraActions.length > 0 ? { extraActions } : {}),
      };
    }
    return {
      kind: "select",
      title,
      items,
      total: typeof props.total === "number" ? props.total : items.length,
      ...(search ? { search } : {}),
      ...(extraActions.length > 0 ? { extraActions } : {}),
    };
  },

  act(component, action, ctx) {
    // Never act on a stale tree: the list may have been filtered underneath us.
    const found = findPicker(component);
    if (!found) return false;
    const { owner, keypath, props } = found;
    if (action.type === "search") {
      // The picker filters through its own input box: replace its contents
      // and let the host re-filter the list.
      if (!setInputValue(component, action.query)) return false;
      try {
        ctx.requestRender();
      } catch {
        // A host without a live renderer has nothing to redraw; the text landed.
      }
      return true;
    }
    let target: unknown;
    if (action.type === "choose" && action.key.startsWith(STRIP_KEY_PREFIX)) {
      const raw = action.key.slice(STRIP_KEY_PREFIX.length);
      const index = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      const strip = pickerStrip(props);
      if (!strip || !Number.isInteger(index) || index >= strip.items.length) return false;
      target = { type: "action", key: keypath, act: "strip", value: String(index), mods: [] };
    } else if (action.type === "choose") {
      const catalogue = Array.isArray(props.items) ? props.items : [];
      if (!catalogue.some((item) => isObject(item) && item.id === action.key)) return false;
      target = { type: "activate", key: keypath, item: action.key };
    } else if (action.type === "key") {
      target = pickerBarEvent(keypath, props, action.name);
    } else if (action.type === "cancel") {
      target = { type: "action", key: keypath, act: "close", mods: [] };
    }
    if (!target) return false;
    const handle = (owner as Partial<Describable>).handleNativeEvent;
    if (typeof handle !== "function") return false;
    try {
      handle.call(owner, target);
    } catch {
      return false;
    }
    // The native event mutates host state without a UI tick; ask the host to
    // redraw so the terminal catches up with what Telegram just showed (3E).
    try {
      ctx.requestRender();
    } catch {
      // A host without a live renderer has nothing to redraw; the act landed.
    }
    return true;
  },
};

/** The live page's rows, in section order (the host only describes that page). */
function prefsRows(props: PrefsProps): PrefsRowLike[] {
  const sections = Array.isArray(props.sections) ? (props.sections as readonly PrefsSectionLike[]) : [];
  const rows: PrefsRowLike[] = [];
  for (const section of sections) {
    if (!isObject(section) || !Array.isArray(section.rows)) continue;
    for (const row of section.rows as readonly unknown[]) {
      if (isObject(row) && typeof (row as PrefsRowLike).id === "string") rows.push(row as PrefsRowLike);
    }
  }
  return rows;
}

/** A choice control's usable options: entries carrying a string `value`. */
function choiceOptions(control: HostRecord): { value: string; label: string }[] {
  const options = Array.isArray(control.options) ? (control.options as readonly unknown[]) : [];
  const usable: { value: string; label: string }[] = [];
  for (const option of options) {
    if (isObject(option) && typeof option.value === "string") usable.push({ value: option.value, label: tspText(option.label) });
  }
  return usable;
}

/** One prefs row as a settings item; controls we cannot edit stay read-only. */
function prefsRowItem(row: PrefsRowLike): DialogItem & { values?: string[] } {
  const key = row.id as string;
  const label = tspText(row.label);
  const control = isObject(row.control) ? row.control : undefined;
  if (control?.k === "switch") {
    return { key, label, value: control.on === true ? "On" : "Off", values: ["On", "Off"] };
  }
  if (control?.k === "choice") {
    const options = choiceOptions(control);
    const current = options.find((option) => option.value === control.value);
    return {
      key,
      label,
      value: current ? current.label : typeof control.value === "string" ? control.value : "",
      values: options.map((option) => option.label),
    };
  }
  return { key, label, value: "(change it in the terminal)" };
}

/** The change event for cycling a settings row, or undefined when unmappable. */
function prefsChangeEvent(keypath: string, props: PrefsProps, rowKey: string, wanted?: string): unknown {
  const row = prefsRows(props).find((candidate) => candidate.id === rowKey);
  if (!row) return undefined;
  const control = isObject(row.control) ? row.control : undefined;
  if (!control) return undefined;
  if (control.k === "switch") {
    let next: boolean;
    if (wanted === "On") next = true;
    else if (wanted === "Off") next = false;
    else if (wanted === undefined) next = control.on !== true;
    else return undefined;
    return { type: "change", key: keypath, item: rowKey, value: next };
  }
  if (control.k === "choice") {
    const options = choiceOptions(control);
    if (options.length === 0) return undefined;
    if (wanted !== undefined) {
      const chosen = options.find((option) => option.label === wanted);
      if (!chosen) return undefined;
      return { type: "change", key: keypath, item: rowKey, value: chosen.value };
    }
    const current = options.findIndex((option) => option.value === control.value);
    return { type: "change", key: keypath, item: rowKey, value: options[(current + 1) % options.length].value };
  }
  return undefined;
}

export const tspPrefsAdapter: DialogAdapter = {
  id: "tsp-prefs",

  detect(component, ctx) {
    if (ctx.entry?.race) return false; // §4.12: the race owns a raced extension dialog.
    return ctx.host === "omp" && findNode(component, "prefs") !== undefined;
  },

  read(component, ctx): DialogModel {
    const found = findNode(component, "prefs");
    if (!found) return { kind: "unsupported", what: "OMP settings page closed or no longer a settings page" };
    const { props } = found;
    const currentPage = typeof props.page === "string" ? props.page : "";
    const items: (DialogItem & { values?: string[]; hasSubmenu?: boolean })[] = [];
    const pages = Array.isArray(props.pages) ? (props.pages as readonly PrefsPageLike[]) : [];
    for (const page of pages) {
      if (!isObject(page) || typeof page.id !== "string" || page.disabled) continue;
      if (page.id === currentPage) continue;
      items.push({ key: `page:${page.id}`, label: `📄 ${tspText(page.label)}`, hasSubmenu: true });
    }
    for (const row of prefsRows(props)) {
      if (row.disabled) continue;
      items.push(prefsRowItem(row));
    }
    return {
      kind: "settings",
      title: typeof props.title === "string" ? props.title : "Settings",
      items,
    };
  },

  act(component, action, ctx) {
    // Never act on a stale tree: the page may have been switched underneath us.
    const found = findNode(component, "prefs");
    if (!found) return false;
    const { owner, keypath, props } = found;
    let target: unknown;
    if (action.type === "submenu" && action.key.startsWith("page:")) {
      const pageId = action.key.slice("page:".length);
      const pages = Array.isArray(props.pages) ? (props.pages as readonly PrefsPageLike[]) : [];
      if (!pages.some((page) => isObject(page) && page.id === pageId && !page.disabled)) return false;
      target = { type: "action", key: keypath, act: "page", value: pageId, mods: [] };
    } else if (action.type === "cycle") {
      target = prefsChangeEvent(keypath, props, action.key, action.value);
      if (!target) return false;
    } else if (action.type === "cancel") {
      target = { type: "action", key: keypath, act: "close", mods: [] };
    } else {
      return false;
    }
    const handle = (owner as Partial<Describable>).handleNativeEvent;
    if (typeof handle !== "function") return false;
    try {
      handle.call(owner, target);
    } catch {
      return false;
    }
    // Same as the picker: the page/row state changed under the terminal; the
    // host only repaints on request (3E).
    try {
      ctx.requestRender();
    } catch {
      // ignore
    }
    return true;
  },
};
