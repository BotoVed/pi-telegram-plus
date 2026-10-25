/**
 * Telegram renderer for dialog models (§4.7).
 *
 * One model in, one message + keyboard out. Buttons never carry item identity:
 * they encode a page and an index, and the Broker resolves that against the
 * *live* model, so a stale button can never act on the wrong row. Every
 * callback also carries the generation it was drawn for.
 *
 * Ops (§4.7.1): `c` choose, `t` toggle, `v` cycle value, `m` submenu,
 * `q` switch question, `p` page, `s` search, `y`/`n` confirm, `a` approval,
 * `i` free text, `k` terminal key, `x` cancel.
 */
import { encodeDialogCallback } from "../callback-protocol.ts";
import type { TelegramButton } from "../types.ts";
import type { DialogItem, DialogModel } from "./model.ts";

/** §4.7.2: ten items per page, one button per row. */
export const PAGE_SIZE = 10;
export const BUTTONS_PER_ROW = 3;
const MAX_LABEL = 45;

export type RenderedDialog = {
  text: string;
  rows: TelegramButton[][];
  /** callback argument -> item/option key, resolved against the live model. */
  keyMap: Map<string, string>;
  page: number;
  pages: number;
};

export type RenderContext = {
  sessionId: string;
  generation: number;
  page?: number;
  redact?: (text: string) => string;
};

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

function clean(value: string | undefined): string {
  if (!value) return "";
  return value.replace(ANSI, "").replace(CONTROL, "");
}

function shorten(value: string, limit: number): string {
  const text = clean(value).replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function chunk(buttons: TelegramButton[]): TelegramButton[][] {
  const rows: TelegramButton[][] = [];
  for (let index = 0; index < buttons.length; index += BUTTONS_PER_ROW) {
    rows.push(buttons.slice(index, index + BUTTONS_PER_ROW));
  }
  return rows;
}

function button(label: string, ctx: RenderContext, op: string, arg?: string): TelegramButton | undefined {
  try {
    return { text: label, value: encodeDialogCallback(ctx.sessionId, ctx.generation, op, arg) };
  } catch {
    // Past the 64-byte Bot API limit: drop the button rather than throw.
    return undefined;
  }
}

function keep(buttons: (TelegramButton | undefined)[]): TelegramButton[] {
  return buttons.filter((built): built is TelegramButton => built !== undefined);
}

function itemLabel(item: DialogItem, multi = false): string {
  const checkbox = multi || item.checked === true ? (item.checked ? "☑" : "☐") : "";
  const cursor = item.focused ? "▸" : "";
  const current = item.current ? "✓" : "";
  const marker = [checkbox, cursor, current].filter((part) => part !== "").join("");
  const value = item.value ? `: ${shorten(item.value, 18)}` : "";
  return shorten(`${marker}${marker ? " " : ""}${item.label}${value}`, MAX_LABEL);
}

/** Item buttons, one per row, labelled with cursor/state markers. */
function itemButtons(items: DialogItem[], page: number, ctx: RenderContext, op: string) {
  const rows: TelegramButton[][] = [];
  const keyMap = new Map<string, string>();
  items.forEach((item, index) => {
    const arg = `${page}.${index}`;
    const built = button(itemLabel(item, op === "t"), ctx, op, arg);
    if (!built) return;
    rows.push([built]);
    keyMap.set(arg, item.key);
  });
  return { rows, keyMap };
}

function pageButtons(total: number, page: number, ctx: RenderContext): TelegramButton[] {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return [];
  const previous = page > 0 ? button("◀ 上一页", ctx, "p", String(page - 1)) : undefined;
  const next = page < pages - 1 ? button("下一页 ▶", ctx, "p", String(page + 1)) : undefined;
  return keep([previous, button(`${page + 1}/${pages}`, ctx, "p", String((page + 1) % pages)), next]);
}

function cancelRow(ctx: RenderContext, label = "取消"): TelegramButton[] {
  const cancel = button(label, ctx, "x");
  return cancel ? [cancel] : [];
}

function header(title: string, subtitle: string | undefined, body: string[]): string {
  const lines = [`<b>${escapeHtml(shorten(title, 80))}</b>`];
  if (subtitle) lines.push(`<i>${escapeHtml(subtitle)}</i>`);
  lines.push("");
  return `${lines.join("\n")}${body.join("")}`;
}

function listText(title: string, subtitle: string | undefined, items: DialogItem[], page: number, multi = false): string {
  const body = items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE).map((item) => `${escapeHtml(itemLabel(item, multi))}\n`);
  return header(title, subtitle, body);
}

function renderSelect(model: Extract<DialogModel, { kind: "select" }>, ctx: RenderContext): RenderedDialog {
  const page = Math.max(0, ctx.page ?? 0);
  const total = model.total || model.items.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const window = model.items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const { rows, keyMap } = itemButtons(window, page, ctx, model.multi ? "t" : "c");
  const actions: TelegramButton[] = [];
  if (model.multi) {
    const submit = button("⏎ 提交", ctx, "k", "enter");
    if (submit) actions.push(submit);
  }
  if (model.search) {
    const search = button(`🔍 ${shorten(model.search.query || "搜索", 20)}`, ctx, "s");
    if (search) actions.push(search);
  }
  for (const extra of model.extraActions ?? []) {
    const built = button(shorten(extra.label, MAX_LABEL), ctx, "k", extra.key);
    if (built) actions.push(built);
  }
  actions.push(...cancelRow(ctx));
  const nav = pageButtons(total, page, ctx);
  if (nav.length > 0) rows.push(nav);
  rows.push(actions);
  const subtitle = `第 ${page + 1}/${pages} 页 · 共 ${total} 项`;
  return {
    text: listText(
      model.title,
      model.search ? `${subtitle} · 🔍 ${shorten(model.search.query || "(全部)", 20)}` : subtitle,
      model.items,
      page,
      model.multi,
    ),
    rows,
    keyMap,
    page,
    pages,
  };
}

/** Settings rows: two-valued rows switch directly, longer value lists cycle. */
function renderSettings(model: Extract<DialogModel, { kind: "settings" }>, ctx: RenderContext): RenderedDialog {
  if (model.submenu) {
    const inner = renderDialog(model.submenu.model, { ...ctx, page: 0 });
    const rows = inner.rows.slice();
    rows.push(cancelRow(ctx, "↩ 返回"));
    const keyMap = new Map<string, string>();
    // Keys are the exact callback arguments of the buttons drawn above, so the
    // Broker can look one up without knowing this is a nested view.
    for (const [key, value] of inner.keyMap) keyMap.set(key, value);
    return { text: `${inner.text}\n<i>子菜单 · 返回发 Esc</i>`, rows, keyMap, page: 0, pages: 1 };
  }
  const page = Math.max(0, ctx.page ?? 0);
  const pages = Math.max(1, Math.ceil(model.items.length / PAGE_SIZE));
  const window = model.items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const rows: TelegramButton[][] = [];
  const keyMap = new Map<string, string>();
  window.forEach((item, index) => {
    const values = item.values ?? [];
    if (item.hasSubmenu) {
      const arg = `${page}.${index}`;
      const built = button(`▸ ${shorten(`${item.label}${item.value ? `: ${item.value}` : ""}`, MAX_LABEL)}`, ctx, "m", arg);
      if (!built) return;
      rows.push([built]);
      keyMap.set(arg, item.key);
      return;
    }
    if (values.length === 2) {
      values.forEach((value, position) => {
        const arg = `${page}.${index}.${position}`;
        const built = button(`${item.value === value ? "◉" : "○"} ${item.label}: ${shorten(value, MAX_LABEL - 12)}`, ctx, "v", arg);
        if (!built) return;
        rows.push([built]);
        keyMap.set(arg, `${item.key}=${value}`);
      });
      return;
    }
    const arg = `${page}.${index}`;
    const built = button(itemLabel(item), ctx, values.length > 2 ? "v" : "t", arg);
    if (!built) return;
    rows.push([built]);
    keyMap.set(arg, item.key);
  });
  const nav = pageButtons(model.items.length, page, ctx);
  if (nav.length > 0) rows.push(nav);
  rows.push(cancelRow(ctx));
  return {
    text: listText(model.title, `第 ${page + 1}/${pages} 页 · 共 ${model.items.length} 项`, model.items, page),
    rows,
    keyMap,
    page,
    pages,
  };
}

function renderQuestionnaire(model: Extract<DialogModel, { kind: "questionnaire" }>, ctx: RenderContext): RenderedDialog {
  const activeIndex = Math.max(0, Math.min(model.active, model.questions.length - 1));
  const active = model.questions[activeIndex];
  if (!active) {
    return { text: header(model.title, undefined, ["(没有可显示的问题)"]), rows: [cancelRow(ctx)], keyMap: new Map(), page: 0, pages: 1 };
  }
  const status = model.questions
    .map((question, index) => `${index === activeIndex ? "▸" : ""}${index + 1}${question.answered ? "✓" : "·"}`)
    .join(" ");
  const body = `${escapeHtml(shorten(active.prompt, 300))}\n`;
  const { rows, keyMap } = itemButtons(active.items, 0, ctx, active.multi ? "t" : "c");
  const switchRow = keep([
    activeIndex > 0 ? button("◀ 上一题", ctx, "q", String(activeIndex - 1)) : undefined,
    button(`第 ${activeIndex + 1}/${model.questions.length} 题`, ctx, "q", String((activeIndex + 1) % model.questions.length)),
    activeIndex < model.questions.length - 1 ? button("下一题 ▶", ctx, "q", String(activeIndex + 1)) : undefined,
  ]);
  if (switchRow.length > 0) rows.unshift(switchRow);
  const actions: TelegramButton[] = [];
  if (active.allowCustom) {
    const custom = button("✏️ 自己输入", ctx, "i");
    if (custom) actions.push(custom);
  }
  if (model.canSubmit) {
    const submit = button("⏎ 提交全部", ctx, "k", "enter");
    if (submit) actions.push(submit);
  }
  actions.push(...cancelRow(ctx));
  rows.push(actions);
  return { text: header(model.title, status, [body]), rows, keyMap, page: 0, pages: 1 };
}

function renderApproval(model: Extract<DialogModel, { kind: "approval" }>, ctx: RenderContext): RenderedDialog {
  const body = model.detail ? `<pre>${escapeHtml(clean(model.detail).slice(0, 900))}</pre>\n` : "";
  const buttons: TelegramButton[] = [];
  const keyMap = new Map<string, string>();
  model.options.forEach((option, index) => {
    const built = button(shorten(option.label, MAX_LABEL), ctx, "a", String(index));
    if (!built) return;
    buttons.push(built);
    keyMap.set(String(index), option.key);
  });
  buttons.push(...cancelRow(ctx));
  return { text: header(model.title, undefined, [body]), rows: chunk(buttons), keyMap, page: 0, pages: 1 };
}

function renderConfirm(model: Extract<DialogModel, { kind: "confirm" }>, ctx: RenderContext): RenderedDialog {
  const body = model.message ? `${escapeHtml(shorten(model.message, 900))}\n` : "";
  const rows = [keep([button("✅ 是", ctx, "y"), button("❌ 否", ctx, "n")]), cancelRow(ctx)];
  return { text: header(model.title, undefined, [body]), rows, keyMap: new Map(), page: 0, pages: 1 };
}

function renderInput(model: Extract<DialogModel, { kind: "input" }>, ctx: RenderContext): RenderedDialog {
  const body = [
    model.placeholder ? `<pre>${escapeHtml(shorten(model.placeholder, 300))}</pre>\n` : "",
    model.secret ? "<i>秘密输入：直接发送一条消息，机器人不会回显它。</i>\n" : "",
    "直接发送一条消息作为输入；点“取消”放弃。",
  ];
  return { text: header(model.title, undefined, body), rows: [cancelRow(ctx)], keyMap: new Map(), page: 0, pages: 1 };
}

function renderProgress(model: Extract<DialogModel, { kind: "progress" }>, ctx: RenderContext): RenderedDialog {
  const body = `⏳ ${escapeHtml(shorten(model.text, 900))}\n`;
  return {
    text: header("运行中", undefined, [body]),
    rows: model.cancellable ? [cancelRow(ctx)] : [],
    keyMap: new Map(),
    page: 0,
    pages: 1,
  };
}

/** Read-only panel: the text plus one way out (§4.6.5 #12). */
function renderInfo(model: Extract<DialogModel, { kind: "info" }>, ctx: RenderContext): RenderedDialog {
  const body = `<pre>${escapeHtml(clean(model.text).slice(0, 3000))}</pre>\n`;
  return {
    text: header(model.title ?? "终端信息", undefined, [body]),
    rows: [cancelRow(ctx, "关闭")],
    keyMap: new Map(),
    page: 0,
    pages: 1,
  };
}

/** §4.6.5 #13: an unrecognised dialog is announced, never mirrored. */
function renderUnsupported(model: Extract<DialogModel, { kind: "unsupported" }>, ctx: RenderContext): RenderedDialog {
  const body = `终端上有一个 Telegram 无法处理的对话框（${escapeHtml(shorten(clean(model.what), 120))}），请在终端处理。\n`;
  return {
    text: header(model.title ?? "Telegram 无法处理的对话框", undefined, [body]),
    rows: [cancelRow(ctx, "取消")],
    keyMap: new Map(),
    page: 0,
    pages: 1,
  };
}

/** Turns a model into message text plus inline keyboard. */
export function renderDialog(model: DialogModel, ctx: RenderContext): RenderedDialog {
  const renderContext: RenderContext = { ...ctx, page: ctx.page ?? 0 };
  const rendered = (() => {
    switch (model.kind) {
      case "select":
        return renderSelect(model, renderContext);
      case "settings":
        return renderSettings(model, renderContext);
      case "questionnaire":
        return renderQuestionnaire(model, renderContext);
      case "approval":
        return renderApproval(model, renderContext);
      case "confirm":
        return renderConfirm(model, renderContext);
      case "input":
        return renderInput(model, renderContext);
      case "editor":
        return renderInput({ kind: "input", title: model.title, secret: false, prefill: model.prefill }, renderContext);
      case "progress":
        return renderProgress(model, renderContext);
      case "info":
        return renderInfo(model, renderContext);
      case "unsupported":
        return renderUnsupported(model, renderContext);
    }
  })();
  if (!ctx.redact) return rendered;
  return { ...rendered, text: ctx.redact(rendered.text) };
}
