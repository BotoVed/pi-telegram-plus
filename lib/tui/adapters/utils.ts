/**
 * Shared adapter helpers (§4.6).
 *
 * Two invariants every adapter keeps:
 * - Nothing is invented. A model only reports what the live component said
 *   when it was read; a stale button is reported, never guessed at.
 * - Nothing is poked. Actions travel the same path a keyboard takes, so the
 *   component refreshes its own internal state. Direct field writes happen
 *   only where the component exposes a setter for exactly that purpose.
 */

/** OMP versions the plugin supports: the frame-reading adapters were verified against these (§4.6.6 exception 2), and startup refuses anything else (§0.1). Single copy - tui-bridge gates on it too. */
export const SUPPORTED_OMP_VERSIONS = /^18\.12\./;
let ompVersion: string | undefined;
export function setOmpVersion(version: string | undefined): void {
  ompVersion = version;
}
/** True when frame reading may be used: not OMP, or an OMP version in the verified range. */
export function ompFrameSupported(host: "pi" | "omp"): boolean {
  return host !== "omp" || (ompVersion !== undefined && SUPPORTED_OMP_VERSIONS.test(ompVersion));
}

/** CSI sequences, OSC strings and stray control bytes that colour the render. */
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|[\x07\x08]/g;

/**
 * Strip ANSI so text parsing never depends on the active theme. pi-tui renders
 * either one string or one string per line: both have to come out as text, or
 * every adapter that parses the render reads an empty screen.
 */
export function plain(value: unknown): string {
  if (typeof value === "string") return value.replace(ANSI_PATTERN, "");
  if (Array.isArray(value)) return value.map((line) => plain(line)).join("\n");
  return "";
}

/** Render a component's own text; theme colours removed, width 80 by default. */
export function renderText(component: unknown, width = 80): string {
  const render = (component as Record<string, unknown> | undefined)?.render;
  if (typeof render !== "function") return "";
  try {
    return plain((render as (renderWidth: number) => unknown).call(component, width));
  } catch {
    // A component that cannot draw itself (no theme, missing context) can still
    // own focus: mirror nothing rather than throw into the Broker.
    return "";
  }
}

/**
 * Row identity: "index + label" (§4.6.2). The index makes a repeated label
 * addressable; the label lets the reverse lookup notice that the terminal list
 * changed underneath us.
 */
export function rowKey(index: number, label: string): string {
  return `${index}:${label}`;
}

/** Turn a key back into a live index, or `undefined` when the row is gone. */
export function resolveRowKey(labels: string[], key: string): number | undefined {
  const separator = key.indexOf(":");
  if (separator < 0) {
    const direct = labels.indexOf(key);
    return direct >= 0 ? direct : undefined;
  }
  const index = Number.parseInt(key.slice(0, separator), 10);
  const label = key.slice(separator + 1);
  if (Number.isInteger(index) && labels[index] === label) return index;
  const moved = labels.indexOf(label);
  return moved >= 0 ? moved : undefined;
}

const FRAME_ROW = /^\s*(?:│\s*)?(?<mark>[→❯▸])?\s*(?<text>.*?)\s*$/;
const ROW_GLYPH = /^[○●◉□☐☑✓]\s*/;

/**
 * The rows the drawn frame shows, in the order the frame shows them, plus which of them the
 * host marks as current. Hosts that keep a dialog's rows in private fields expose no cursor
 * field, so the frame the component draws is the only place the cursor exists (§4.6.5). A
 * frame that shows none of the known labels, or marks two rows, is not a list we understand.
 */
export function frameRows(labels: string[], frame: string): { visible: number[]; marked?: number; at?: number } {
  const visible: number[] = [];
  let marked: number | undefined;
  let at: number | undefined;
  for (const line of frame.split("\n")) {
    const groups = FRAME_ROW.exec(line)?.groups;
    if (!groups) continue;
    const text = groups.text.replace(/\s*│\s*$/, "").replace(ROW_GLYPH, "").trim();
    if (text === "") continue;
    const index = longestLabelMatch(labels, text);
    if (index === undefined || visible.includes(index)) continue;
    if (groups.mark) {
      // Two cursors means this is not the single-choice list we think it is.
      if (marked !== undefined) return { visible: [] };
      marked = index;
      at = visible.length;
    }
    visible.push(index);
  }
  return marked === undefined || at === undefined ? { visible } : { visible, marked, at };
}

/** Which of `labels` the frame marks as current; `undefined` when it marks none. */
export function frameCursor(labels: string[], frame: string): number | undefined {
  return frameRows(labels, frame).marked;
}

/**
 * A frame row may carry a description column after the label, and hosts pad their option
 * strings with their own indentation and state marks (`"  hidden"`, `"● brief"`), so both
 * sides are compared with that decoration stripped. The longest label wins: one row's text
 * can begin with another row's.
 */
function longestLabelMatch(labels: string[], text: string): number | undefined {
  let best: number | undefined;
  let bestLength = -1;
  for (let index = 0; index < labels.length; index += 1) {
    const label = plainLabel(labels[index]);
    if (label.length > bestLength && (text === label || text.startsWith(label))) {
      best = index;
      bestLength = label.length;
    }
  }
  return best;
}

/** An option string as the frame shows it: no indentation, no current-value mark. */
function plainLabel(label: string): string {
  return label.replace(/^\s+/, "").replace(ROW_GLYPH, "").trim();
}

/** Read a label out of a host list entry, whatever field it keeps it in. */
export function labelOf(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return String(entry);
  const record = entry as Record<string, unknown>;
  for (const field of ["label", "value", "name", "title", "text"]) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return JSON.stringify(record).slice(0, 60);
}

export function descriptionOf(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  for (const field of ["description", "hint", "detail", "doc", "docs"]) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value.replace(/\s+/g, " ").trim();
  }
  return undefined;
}

/** The class name, for whitelists; host may load its own copy of a class. */
export function constructorName(value: unknown): string {
  const ctor = (value as { constructor?: { name?: string } })?.constructor;
  return typeof ctor?.name === "string" ? ctor.name : "";
}

/** Walk the cursor the way a user would: one arrow key per step. */
export function moveCursor(sendKey: (name: string) => boolean, from: number, to: number): boolean {
  const steps = Math.abs(to - from);
  if (steps === 0) return true;
  const name = to < from ? "up" : "down";
  for (let step = 0; step < steps; step += 1) {
    if (!sendKey(name)) return false;
  }
  return true;
}

/**
 * Move to `target` and press Enter, the two steps every list-style dialog
 * performs. Returns false when the component refuses the keys, which the
 * Broker reports instead of pretending the choice landed.
 */
export function selectRow(
  sendKey: (name: string) => boolean,
  cursor: number,
  target: number,
  submitKey = "enter",
): boolean {
  if (!moveCursor(sendKey, cursor, target)) return false;
  return sendKey(submitKey);
}
