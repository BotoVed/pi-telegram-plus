// Parse a rendered TUI screen into a selectable list, so Telegram can show
// one button per option instead of a keystroke emulator.
//
// Both supported hosts render selection dialogs as a box made of
// box-drawing characters, with one row per option, e.g.:
//
//   ╭─ Select provider to login ────────────────╮
//   │ ❯ ChatGPT Plus/Pro (Codex Subscription) ██ │
//   │   Anthropic (Claude Pro/Max)             │ │
//   │ Type to search                            │
//   ╰───────────────────────────────────────────╯
//
// The "❯" glyph marks the current item, which is what makes absolute
// selection possible: the navigation distance is computed from where the
// marker actually is, not from a guessed list position.

export type SelectorOption = {
  label: string;
  selected: boolean;
};

export type SelectorState = {
  /** Dialog title taken from the box border line, if present. */
  title?: string;
  options: SelectorOption[];
  /** Raw rendered block (borders included) for the mirror display. */
  block: string;
};

const BOX_TOP = /^[ \t]*[╭┌]/;
const BOX_BOTTOM = /^[ \t]*[╰└]/;
const BOX_LINE = /^[ \t]*[│┃]/;
const BORDER_CHARS = "│┃█▌▐|";

/**
 * Leading selection markers recognizable after ANSI stripping. The PUA range
 * U+E000–U+F8FF covers nerd-font presets, where the same cursor glyph ships
 * as a private-area chevron (e.g. U+F054) instead of "❯".
 */
const SELECTED_MARKER = /^[❯>▶▸➤✦•·*\uE000-\uF8FF]\s+/;

/**
 * Non-option chrome inside a selector box: search hints and key legends.
 * These render like option rows but pressing Enter on them must never
 * navigate the list, so they never become buttons.
 */
const FOOTER_PATTERN = /^(?:type to search|search[:\s]|\/\s*search\b|(?:esc|enter|space|tab|↑|↓|←|→)[\s/:|↑↓←→ and]*$)/i;
const FOOTER_PHRASE = /\b(?:to (?:select|toggle|move|filter|close|confirm|cancel|search)|press (?:esc|enter|space|tab)|current|connected)\b/i;

const isFooterLine = (label: string): boolean => {
  if (FOOTER_PATTERN.test(label)) return true;
  // Legend rows like "↑↓ move · Enter select · Esc cancel" or "tab: toggle".
  return FOOTER_PHRASE.test(label) || /[↑↓←→]/.test(label);
};

function stripBorderResidue(line: string): string {
  let rest = line.trimStart();
  if (BORDER_CHARS.includes(rest[0] ?? "")) rest = rest.slice(1);
  // Drop trailing border/scrollbar glyphs: some dialogs render a scrollbar
  // column or a duplicated right border inside the content area.
  rest = rest.replace(new RegExp(`(?:[ \\t]|[${BORDER_CHARS}])+$`), "");
  return rest.trim();
}

function extractBlock(lines: string[]): { start: number; end: number } | undefined {
  // The active dialog is the last box region on screen.
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (BOX_BOTTOM.test(lines[i])) { end = i; break; }
  }
  let start = -1;
  if (end !== -1) {
    for (let i = end - 1; i >= 0; i -= 1) {
      if (BOX_TOP.test(lines[i])) { start = i; break; }
      if (!BOX_LINE.test(lines[i]) && !/^[ \t]*[│┃]/.test(lines[i])) {
        // Allow unbordered noise only when no box top exists above.
        continue;
      }
    }
  }
  if (start === -1) {
    // Tolerate boxes missing an explicit bottom (wrapped render): take the
    // last contiguous run of │ lines preceded by a ╭ line.
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!BOX_LINE.test(lines[i])) continue;
      let top = i;
      while (top >= 0 && (BOX_LINE.test(lines[top]) || BOX_TOP.test(lines[top]))) top -= 1;
      if (top >= 0 && BOX_TOP.test(lines[top])) return { start: top, end: i + 1 };
    }
    return undefined;
  }
  // Include a preceding title/top-border line if it exists.
  let top = start;
  if (!BOX_TOP.test(lines[start])) {
    for (let i = start - 1; i >= 0; i -= 1) {
      if (BOX_TOP.test(lines[i])) { top = i; break; }
    }
  }
  return { start: top, end };
}

function readTitle(borderLine: string): string | undefined {
  const title = borderLine
    .replace(/^[ \t]*[╭┌]/, "")
    .replace(/[╮┐][ \t]*$/, "")
    .replace(/[─━─\s]+$/g, "")
    .replace(/^[─━\s]+/, "")
    .trim();
  return title.length > 1 && !/^[─━\s]+$/.test(title) ? title : undefined;
}

/** Returns the parsed selector for the last dialog box, if one is visible. */
export function parseSelectorText(screenText: string): SelectorState | undefined {
  const lines = screenText.split("\n");
  const region = extractBlock(lines);
  if (!region) return undefined;
  const blockLines = lines.slice(region.start, region.end + 1);
  const contentLines = blockLines.filter((line) => BOX_LINE.test(line));
  if (contentLines.length < 2) return undefined;

  const options: SelectorOption[] = [];
  for (const line of contentLines) {
    let rest = stripBorderResidue(line);
    if (!rest) continue;
    let selected = false;
    const marker = SELECTED_MARKER.exec(rest);
    if (marker) {
      selected = true;
      rest = rest.slice(marker[0].length);
    }
    // Collapse internal runs so a label stays stable across renders whose
    // column padding differs; stale pick lookups compare labels verbatim.
    const label = rest.replace(/\s+/g, " ").trim();
    if (!label || label.length < 2 || isFooterLine(label)) continue;
    // Lines that are only separator dashes or vertical noise.
    if (/^[─━\s│┃|·•·—-]+$/.test(label)) continue;
    options.push({ label, selected });
  }

  if (options.length < 2) return undefined;
  const hasMarker = options.some((option) => option.selected);
  if (!hasMarker) return undefined;

  const firstLine = blockLines[0] ?? "";
  const title = BOX_TOP.test(firstLine) ? readTitle(firstLine) : undefined;
  return {
    ...(title ? { title } : {}),
    options,
    block: blockLines.join("\n"),
  };
}

/**
 * Keystrokes that move the host selector from its current marker position
 * onto the target index and confirm it. Returns undefined when the current
 * position cannot be determined — guessing would press keys blindly.
 */
export function selectorNavigateKeys(state: SelectorState, targetIndex: number): string[] | undefined {
  const selectedIndex = state.options.findIndex((option) => option.selected);
  if (selectedIndex === -1 || targetIndex < 0 || targetIndex >= state.options.length) return undefined;
  if (selectedIndex === targetIndex) return ["enter"];
  const distance = Math.abs(targetIndex - selectedIndex);
  const direction = targetIndex > selectedIndex ? "down" : "up";
  return [...Array.from({ length: distance }, () => direction), "enter"];
}
