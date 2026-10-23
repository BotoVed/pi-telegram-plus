/**
 * Adapters #12/#13 — everything that is not a dialog (§4.6.4).
 *
 * A *panel* is read-only: it renders text and owns focus, so nothing can be
 * typed while it is up (a loader, a history view, a debug view). It gets an
 * info model: the text plus one way out.
 *
 * A *snapshot* is the last resort for anything interactive we cannot parse:
 * the Telegram message shows what the terminal shows, plus the few keys the
 * dialog's own legend advertises. It is a safety net, not a translation — a
 * long list still cannot be scrolled, which is why every real selector is
 * supposed to get its own adapter.
 */
import type { DialogAdapter, DialogModel } from "../model.ts";
import { isReadOnlyPanel } from "../find-shape.ts";
import { setInputValue } from "../keys.ts";
import { renderText } from "./utils.ts";

/**
 * Whether Escape does more than close the view. pi's `BorderedLoader` keeps no
 * stop method: it carries the host's own `cancellable` flag plus an AbortSignal
 * that Escape aborts through, so both shapes count.
 */
const cancellable = (component: object): boolean => {
  const record = component as Record<string, unknown>;
  if (["cancel", "stop", "abort"].some((name) => typeof record[name] === "function")) return true;
  return record.cancellable === true && "signal" in record;
};

export const infoPanelAdapter: DialogAdapter = {
  id: "info-panel",

  detect(component, ctx) {
    if (ctx.entry?.kind === "panel") return true;
    return isReadOnlyPanel(component);
  },

  read(component, ctx): DialogModel {
    const text = renderText(component).trim();
    if (cancellable(component)) return { kind: "progress", text, cancellable: true };
    return { kind: "info", title: ctx.entry?.title, text, closable: true };
  },

  act(_component, action, ctx) {
    // Read-only means read-only: Escape is the only thing that ever goes in.
    return action.type === "cancel" ? ctx.sendKey("esc") : false;
  },
};

/** The keys a snapshot may send, and only these. */
const SNAPSHOT_KEYS = new Set(["up", "down", "enter", "esc"]);

export const snapshotAdapter: DialogAdapter = {
  id: "snapshot",
  detect() {
    // Last in the registry: it matches anything, so it must be asked last.
    return true;
  },

  read(component, ctx): DialogModel {
    const text = ctx.snapshot?.(80) ?? renderText(component);
    return { kind: "snapshot", text: text.trim() };
  },

  act(component, action, ctx) {
    if (action.type === "cancel") return ctx.sendKey("esc");
    if (action.type === "key") {
      const name = action.name.toLowerCase();
      return SNAPSHOT_KEYS.has(name) ? ctx.sendKey(name) : false;
    }
    if (action.type === "submit") {
      const text = action.text ?? "";
      if (!setInputValue(component, text)) return false;
      return ctx.sendKey("enter");
    }
    return false;
  },
};
