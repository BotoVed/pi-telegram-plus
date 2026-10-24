/**
 * Adapter #10 — OMP's tool-approval dialog (§4.6.4).
 *
 * The entry gives us three prompt strings (full / compact / session-scoped
 * approval); the *keys* the dialog answers to are whatever its own legend
 * advertises, and those differ between hosts and versions. So the adapter only
 * claims a dialog whose render names its keys: a button that presses a key
 * nobody listens for is worse than no button at all, because it reports success
 * while nothing happened.
 *
 * With no readable legend the adapter declines, and the snapshot adapter takes
 * over — which still leaves the terminal's own keys and the escape hatch.
 */
import type { DialogAdapter, DialogModel } from "../model.ts";
import { ompFrameSupported, plain, renderText } from "./utils.ts";

/** `y approve  n deny  s always` / `[y] approve` style legends. */
const LEGEND = /(?:^|\s)(?:\[?)(ctrl\+[a-z]|shift+[a-z]|alt\+[a-z]|[a-z])(?:\]?)\s+([A-Za-z][^\n]{2,48})/g;

/** Keys that must never be offered: they mean something outside the dialog. */
const BLOCKED = new Set(["ctrl+c", "ctrl+d", "ctrl+g", "ctrl+o", "ctrl+p", "ctrl+q", "ctrl+u", "ctrl+v", "ctrl+w", "ctrl+x", "ctrl+y", "ctrl+z"]);

type Option = { key: string; label: string };

function parseLegend(render: string): Option[] {
  const options: Option[] = [];
  for (const line of render.split("\n")) {
    // A legend line is short and holds the separators the hosts use.
    if (line.length > 120) continue;
    if (!/(approve|deny|allow|reject|session|always|once)/i.test(line)) continue;
    LEGEND.lastIndex = 0;
    let match: RegExpExecArray | null = LEGEND.exec(line);
    while (match) {
      const key = match[1].toLowerCase();
      const label = match[2].trim();
      if (!BLOCKED.has(key) && !options.some((option) => option.key === key)) options.push({ key, label });
      match = LEGEND.exec(line);
    }
  }
  return options;
}

/** The longest prompt the entry carried, which is the question being asked. */
function detailOf(entry: { approval?: { full?: string; compact?: string; session?: string } }): string | undefined {
  const values = [entry.approval?.full, entry.approval?.compact, entry.approval?.session].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return values.length > 0 ? values.sort((a, b) => b.length - a.length).join("\n") : undefined;
}

export const approvalAdapter: DialogAdapter = {
  id: "omp-approval",

  detect(component, ctx) {
    if (ctx.entry?.kind !== "approval") return false;
    // The legend comes out of the drawn frame: bound to the verified OMP
    // versions (§4.6.6 exception 2), snapshot takes over otherwise.
    if (!ompFrameSupported(ctx.host)) return false;
    return parseLegend(renderText(component)).length > 0;
  },

  read(component, ctx): DialogModel {
    const options = parseLegend(renderText(component));
    return {
      kind: "approval",
      title: ctx.entry?.title ?? "Tool approval",
      detail: ctx.entry ? detailOf(ctx.entry) : undefined,
      options,
    };
  },

  act(component, action, ctx) {
    if (action.type === "cancel") return ctx.sendKey("esc");
    if (action.type !== "approve") return false;
    const options = parseLegend(renderText(component));
    if (!options.some((option) => option.key === action.key)) return false;
    return ctx.sendKey(action.key);
  },
};

export const approvalInternals = { parseLegend, plain };
