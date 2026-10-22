// Parse a rendered TUI screen into a selectable list, so Telegram can show
// one button per option instead of a keystroke emulator.
//
// OMP renders selection dialogs as a box made of box-drawing characters, with
// one row per option, e.g.:
//
//   ╭─ Select provider to login ────────────────╮
//   │ ❯ ChatGPT Plus/Pro (Codex Subscription) ██ │
//   │   Anthropic (Claude Pro/Max)             │ │
//   │ Type to search                            │
//   ╰───────────────────────────────────────────╯
//
// pi renders extension selectors without side borders, anchored by a key
// legend instead:
//
//   ────────────────────────────────────────────
//    Select authentication method:
//
//    → Sign in with an account
//      Sign in with an API key
//
//    ↑↓ navigate  ↵ select  esc cancel
//   ────────────────────────────────────────────
//
// The marker glyph ("❯"/"→") marks the current item, which is what makes
// absolute selection possible: the navigation distance is computed from where
// the marker actually is, not from a guessed list position.

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
  /**
   * True when the host renders a scrolling window of a longer list (OMP).
   * False when the host renders the complete list (pi extension selectors).
   */
  windowed?: boolean;
  /** Total option count when the host renders a "<cursor>/<total>" indicator. */
  total?: number;
  /** Rows remain above / below the rendered window (pi provider selector). */
  moreAbove?: boolean;
  moreBelow?: boolean;
};

const BOX_TOP = /^[ \t]*[╭┌]/;
const BOX_BOTTOM = /^[ \t]*[╰└]/;
const BOX_LINE = /^[ \t]*[│┃]/;
const BORDER_CHARS = "│┃█▌▐|";

// Borderless (pi) selectors: a "→ " cursor line among plain rows, closed by a
// key legend such as "↑↓ navigate  ↵ select  esc cancel".
const CURSOR_ROW = /^[ \t]*[→❯▸]\s+(.+)$/;
const PLAIN_ROW = /^[ \t]{2,}(\S.*)$/;
const LEGEND_ROW = /[↑↓]|navigate/i;
const LEGEND_ACTION = /\b(?:select|confirm|cancel)\b/i;
const RULE_ROW = /^[ \t]*[─━—]{4,}[ \t]*$/;

const optionRowLabel = (line: string): string | undefined => {
  const cursor = CURSOR_ROW.exec(line);
  const raw = cursor?.[1] ?? PLAIN_ROW.exec(line)?.[1];
  if (raw === undefined) return undefined;
  const label = raw.replace(/\s+/g, " ").trim();
  if (!label || label.length < 2 || isFooterLine(label)) return undefined;
  if (/^[─━\s│┃|·•—]+$/.test(label)) return undefined;
  return label;
};

/**
 * Leading selection markers recognizable after ANSI stripping. The PUA range
 * U+E000–U+F8FF covers nerd-font presets, where the same cursor glyph ships
 * as a private-area chevron (e.g. U+F054) instead of "❯".
 */
const SELECTED_MARKER = /^[❯>▶▸➤✦•·*→\uE000-\uF8FF]\s+/;

// Radio/check groups (OMP's ask dialog: "○ red", "● green") render the cursor
// beside the glyph. The glyph itself carries the checked state; the question
// text above the group has no glyph and must not become an option.
const CHOICE_MARKER = /^([○●◉◯◌])\s*/;

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

/**
 * pi's selectors have no side borders, and come in two shapes:
 *
 *   extension selector:  cursor row ("→ …") among plain rows, closed by a key
 *                        legend ("↑↓ navigate ↵ select esc cancel"); the list
 *                        is rendered in full, so there is nothing to page.
 *   provider selector:   a title ending in ":", a search input line, the same
 *                        cursor rows, then a "(<cursor>/<total>)" scroll line
 *                        and a closing rule. Only a window of the list is
 *                        rendered, so paging has to move the host cursor.
 *
 * Both are anchored below (legend or rule), which ordinary screen output never
 * renders right under a ":"-titled run of cursor rows.
 */
const SCROLL_INFO = /^\((\d+)\/(\d+)\)$/;
const SEARCH_INPUT = /^[>\s]{0,3}$/;

function parseBorderlessSelector(lines: string[]): SelectorState | undefined {
  for (let cursorLine = lines.length - 1; cursorLine >= 0; cursorLine -= 1) {
    if (!CURSOR_ROW.test(lines[cursorLine])) continue;

    let start = cursorLine;
    while (start - 1 >= 0 && (CURSOR_ROW.test(lines[start - 1]) || PLAIN_ROW.test(lines[start - 1]))) start -= 1;
    let end = cursorLine;
    while (end + 1 < lines.length && (CURSOR_ROW.test(lines[end + 1]) || PLAIN_ROW.test(lines[end + 1]))) end += 1;

    let total: number | undefined;
    let cursorPosition: number | undefined;
    const rows: SelectorOption[] = [];
    for (let i = start; i <= end; i += 1) {
      const scroll = SCROLL_INFO.exec(lines[i].trim());
      if (scroll) {
        cursorPosition = Number(scroll[1]);
        total = Number(scroll[2]);
        continue;
      }
      const label = optionRowLabel(lines[i]);
      if (label === undefined) continue;
      rows.push({ label, selected: CURSOR_ROW.test(lines[i]) });
    }
    if (rows.length === 0) continue;
    if (rows.filter((row) => row.selected).length !== 1) continue;

    // Anchor: a key legend (extension selector) or a closing rule (provider
    // selector), within a couple of lines under the run.
    const anchored = lines.slice(end + 1, end + 4).some((line) =>
      (LEGEND_ROW.test(line) && LEGEND_ACTION.test(line)) || RULE_ROW.test(line));
    if (!anchored) continue;

    // Title: nearest non-empty line above the run that is not the search field.
    // pi passes the title through verbatim ("Probe: pick one" has no trailing
    // colon), so any plain line above the anchored run qualifies.
    let titleIndex = start - 1;
    while (titleIndex >= 0) {
      const text = lines[titleIndex].trim();
      if (text === "" || SEARCH_INPUT.test(text)) { titleIndex -= 1; continue; }
      break;
    }
    if (titleIndex < 0) continue;
    const titleLine = lines[titleIndex].trim();
    if (!titleLine || RULE_ROW.test(titleLine)) continue;
    if (CURSOR_ROW.test(lines[titleIndex]) || PLAIN_ROW.test(lines[titleIndex])) continue;
    const title = titleLine.replace(/:\s*$/, "").trim();
    if (!title) continue;

    const windowed = total !== undefined;
    let moreAbove: boolean | undefined;
    let moreBelow: boolean | undefined;
    if (windowed) {
      // pi keeps the cursor centered in its window; derive which slice of the
      // full list is on screen so paging knows whether anything remains.
      const size = rows.length;
      const selected = Math.max(0, (cursorPosition ?? 1) - 1);
      const startIndex = Math.max(0, Math.min(selected - Math.floor(size / 2), (total ?? size) - size));
      moreAbove = startIndex > 0;
      moreBelow = startIndex + size < (total ?? size);
    }

    const blockEnd = Math.min(lines.length - 1, end + 3);
    return {
      title,
      options: rows,
      block: lines.slice(titleIndex, blockEnd + 1).join("\n"),
      windowed,
      ...(total !== undefined ? { total } : {}),
      ...(moreAbove !== undefined ? { moreAbove } : {}),
      ...(moreBelow !== undefined ? { moreBelow } : {}),
    };
  }
  return undefined;
}

/** Returns the parsed selector for the last dialog, if one is visible. */
export function parseSelectorText(screenText: string): SelectorState | undefined {
  const lines = screenText.split("\n");
  const region = extractBlock(lines);
  if (!region) return parseBorderlessSelector(lines);
  const blockLines = lines.slice(region.start, region.end + 1);
  const contentLines = blockLines.filter((line) => BOX_LINE.test(line));
  if (contentLines.length < 2) return undefined;

  const parsedRows: Array<SelectorOption & { choice: string | undefined }> = [];
  let sawFooter = false;
  for (const line of contentLines) {
    let rest = stripBorderResidue(line);
    if (!rest) continue;
    let selected = false;
    const marker = SELECTED_MARKER.exec(rest);
    if (marker) {
      selected = true;
      rest = rest.slice(marker[0].length);
    }
    const choiceMatch = CHOICE_MARKER.exec(rest);
    const choice = choiceMatch?.[1];
    if (choiceMatch) rest = rest.slice(choiceMatch[0].length);
    // Collapse internal runs so a label stays stable across renders whose
    // column padding differs; stale pick lookups compare labels verbatim.
    const label = rest.replace(/\s+/g, " ").trim();
    if (isFooterLine(label)) { sawFooter = true; continue; }
    if (!label || label.length < 2) continue;
    // Lines that are only separator dashes or vertical noise.
    if (/^[─━\s│┃|·•·—-]+$/.test(label)) continue;
    parsedRows.push({ label, selected, choice });
  }

  const choiceRows = parsedRows.filter((row) => row.choice !== undefined);
  const options: SelectorOption[] = choiceRows.length > 0
    ? choiceRows.map((row) => ({
        label: row.label,
        selected: row.selected || row.choice === "●" || row.choice === "◉",
      }))
    : parsedRows.map(({ label, selected }) => ({ label, selected }));

  if (options.length === 0) return undefined;
  const hasMarker = options.some((option) => option.selected);
  if (!hasMarker) return undefined;
  // A single row is only a selector when the dialog renders its legend (e.g.
  // "↑/↓ select · log out account · cancel" for a one-account logout).
  if (options.length === 1 && !sawFooter) return undefined;

  const firstLine = blockLines[0] ?? "";
  const title = BOX_TOP.test(firstLine) ? readTitle(firstLine) : undefined;
  return {
    ...(title ? { title } : {}),
    options,
    block: blockLines.join("\n"),
    windowed: true,
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
