/**
 * Adapter P1: pi's built-in list selectors, read from their own fields
 * (§4.1.4). The generic `filteredRows` guess produces JSON labels and wrong
 * titles here, so each known component is described exactly instead.
 *
 * pi does not minify, so the constructor name is a stable identity, and TS
 * `private` only exists at compile time: the lists, cursors and current
 * markers are plain properties we can read (pi 1.4.0
 * `packages/coding-agent/src/modes/interactive/components/`).
 */
import type { DialogAdapter, DialogItem, DialogModel } from "../model.ts";
import { constructorName, resolveRowKey, rowKey, selectRow } from "./utils.ts";

type HostRecord = Record<string, unknown>;

const readNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const asRecord = (value: unknown): HostRecord => (typeof value === "object" && value !== null ? (value as HostRecord) : {});

/** `/fork` keeps whole messages; Telegram labels stay one readable line. */
const MESSAGE_LABEL_MAX = 60;

/** One known pi selector: how to reach its rows and how to present them. */
type PiListSpec = {
  items(component: HostRecord): unknown[];
  label(item: HostRecord): string;
  /** The row the host itself marks as its current value. */
  current?(component: HostRecord, item: HostRecord): boolean;
  /** Multi-select checkbox state. */
  checked?(item: HostRecord): boolean;
  title(component: HostRecord): string;
  multi?: boolean;
};

const messageLabel = (item: HostRecord): string => {
  const oneLine = text(item.text).replace(/\n/g, " ").trim();
  return oneLine.length > MESSAGE_LABEL_MAX ? `${oneLine.slice(0, MESSAGE_LABEL_MAX)}…` : oneLine;
};

const PI_LIST_SPECS: Record<string, PiListSpec> = {
  // `/model`: `filteredModels` rows are `{ provider, id, model }`.
  ModelSelectorComponent: {
    items: (c) => (Array.isArray(c.filteredModels) ? (c.filteredModels as unknown[]) : []),
    label: (item) => `${text(item.provider)}/${text(item.id)}`,
    current: (c, item) => {
      const current = asRecord(c.currentModel);
      return current.provider !== undefined
        && current.provider === item.provider
        && current.id === item.id;
    },
    title: () => "选择模型",
  },
  // `/scoped-models`: Enter toggles the row, ctrl+s persists, so it is a
  // multi-select on Telegram; `enabled` is the checkbox.
  ScopedModelsSelectorComponent: {
    items: (c) => (Array.isArray(c.filteredItems) ? (c.filteredItems as unknown[]) : []),
    label: (item) => text(item.fullId),
    checked: (item) => item.enabled === true,
    title: () => "Model Configuration",
    multi: true,
  },
  // `/login` and `/logout`: one provider list with two titles.
  OAuthSelectorComponent: {
    items: (c) => (Array.isArray(c.filteredProviders) ? (c.filteredProviders as unknown[]) : []),
    label: (item) => text(item.name),
    title: (c) => (c.mode === "login" ? "Select provider to configure" : "Select provider to logout"),
  },
  // `/trust`: the saved decision marks the current row.
  TrustSelectorComponent: {
    items: (c) => (Array.isArray(c.trustOptions) ? (c.trustOptions as unknown[]) : []),
    label: (item) => text(item.label),
    current: (c, item) => {
      const saved = asRecord(c.savedDecision);
      return item.trusted !== undefined && saved.decision === item.trusted && saved.path === item.savedPath;
    },
    title: () => "Project trust",
  },
  // `/fork` and `/clone`: the focus owner is the inner `UserMessageList`
  // (`UserMessageSelectorComponent.getMessageList()`).
  UserMessageList: {
    items: (c) => (Array.isArray(c.messages) ? (c.messages as unknown[]) : []),
    label: messageLabel,
    title: () => "选择消息",
  },
};

const specFor = (component: object): PiListSpec | undefined => PI_LIST_SPECS[constructorName(component)];

/** Live rows plus the terminal cursor, or undefined once the shape is gone. */
function rowsOf(component: object, spec: PiListSpec): { raw: HostRecord[]; labels: string[]; cursor: number } | undefined {
  const record = component as HostRecord;
  const items = spec.items(record);
  if (!Array.isArray(items)) return undefined;
  const raw = items.map(asRecord);
  return { raw, labels: raw.map((item) => spec.label(item)), cursor: readNumber(record.selectedIndex) };
}

export const piListAdapter: DialogAdapter = {
  id: "pi-list",

  detect(component, ctx) {
    if (ctx.host !== "pi") return false;
    const spec = specFor(component);
    return spec !== undefined && Array.isArray(spec.items(component as HostRecord));
  },

  read(component, ctx): DialogModel {
    const spec = specFor(component);
    const rows = spec ? rowsOf(component, spec) : undefined;
    if (!spec || !rows) {
      return { kind: "unsupported", what: "pi-list: component shape is gone" };
    }
    const items: DialogItem[] = rows.raw.map((item, index) => ({
      key: rowKey(index, rows.labels[index]),
      label: rows.labels[index],
      focused: index === rows.cursor,
      ...(spec.current ? { current: spec.current(component as HostRecord, item) } : {}),
      ...(spec.multi && spec.checked ? { checked: spec.checked(item) } : {}),
    }));
    return {
      kind: "select",
      title: spec.title(component as HostRecord),
      items,
      total: items.length,
      ...(spec.multi ? { multi: true } : {}),
    };
  },

  act(component, action, ctx) {
    const spec = specFor(component);
    if (!spec) return false;
    if (action.type === "cancel") return ctx.sendKey("esc");

    const multi = spec.multi === true;
    if (action.type === "submit") {
      // Scoped models: ctrl+s persists (the host's `app.models.save`), then
      // esc closes the dialog the way the terminal user leaves it.
      if (!multi) return false;
      if (!ctx.sendKey("ctrl-s")) return false;
      ctx.sendKey("esc");
      return true;
    }
    if (action.type !== "choose" && action.type !== "toggle") return false;
    // Enter means "pick" on a single-select and "tick" on a multi-select;
    // sending the wrong action would flip a checkbox or close the dialog.
    if ((action.type === "toggle") !== multi) return false;

    const rows = rowsOf(component, spec);
    if (!rows) return false;
    const target = resolveRowKey(rows.labels, action.key);
    if (target === undefined) return false;
    return selectRow(ctx.sendKey, rows.cursor, target);
  },
};
