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
 * Scope: single-select pickers only. Search, action-bar buttons, prefs rows
 * and multi-select are T3.2e/T3.2f.
 */
import type { DialogAdapter, DialogItem, DialogModel } from "../model.ts";

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
};

type PickerItemLike = { id?: unknown; label?: unknown; detail?: unknown; disabled?: unknown };

type PickerFound = { owner: object; keypath: string; props: PickerProps };

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

/** The picker node's props, trusted only as far as `items` being a usable list. */
function pickerProps(node: NativeNodeLike): PickerProps | undefined {
  if (node.k !== "picker" || !isObject(node.p)) return undefined;
  return node.p as PickerProps;
}

function walkNode(node: NativeNodeLike, keypath: string, owner: object, depth: number, visited: Set<object>): PickerFound | undefined {
  const props = pickerProps(node);
  if (props) return { owner, keypath, props };
  const children = Array.isArray(node.c) ? (node.c as unknown[]) : undefined;
  if (!children) return undefined;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!isObject(child)) continue;
    const component = asComponent(child);
    if (component) {
      const found = findPickerVisited(component, depth + 1, visited);
      if (found) return found;
      continue;
    }
    const childNode = child as NativeNodeLike;
    if (visited.has(childNode)) continue;
    visited.add(childNode);
    const segment = childNode.key === undefined ? String(i) : String(childNode.key);
    const found = walkNode(childNode, keypath === "" ? segment : `${keypath}/${segment}`, owner, depth, visited);
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
export function findPicker(component: object, depth = 0): PickerFound | undefined {
  return findPickerVisited(component, depth, new Set<object>());
}

function findPickerVisited(component: object, depth: number, visited: Set<object>): PickerFound | undefined {
  if (depth > MAX_COMPONENT_DEPTH || visited.has(component)) return undefined;
  visited.add(component);
  const root = describeTree(component);
  if (!root) return undefined;
  visited.add(root);
  return walkNode(root, "", component, depth, visited);
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

export const tspPickerAdapter: DialogAdapter = {
  id: "tsp-picker",

  detect(component, ctx) {
    return ctx.host === "omp" && findPicker(component) !== undefined;
  },

  read(component, ctx): DialogModel {
    const found = findPicker(component);
    if (!found) return { kind: "unsupported", what: "OMP 选择器已关闭或不再是选择器" };
    const { props } = found;
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
    return {
      kind: "select",
      title: typeof props.title === "string" ? props.title : "选择",
      items,
      total: typeof props.total === "number" ? props.total : items.length,
    };
  },

  act(component, action, ctx) {
    // Never act on a stale tree: the list may have been filtered underneath us.
    const found = findPicker(component);
    if (!found) return false;
    const { owner, keypath, props } = found;
    const target =
      action.type === "choose"
        ? { type: "activate" as const, key: keypath, item: action.key }
        : action.type === "cancel"
          ? { type: "action" as const, key: keypath, act: "close", mods: [] }
          : undefined;
    if (!target) return false;
    if (target.type === "activate") {
      const catalogue = Array.isArray(props.items) ? props.items : [];
      if (!catalogue.some((item) => isObject(item) && item.id === target.item)) return false;
    }
    const handle = (owner as Partial<Describable>).handleNativeEvent;
    if (typeof handle !== "function") return false;
    try {
      handle.call(owner, target);
      return true;
    } catch {
      return false;
    }
  },
};
