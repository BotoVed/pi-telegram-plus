import { describe, expect, it } from "vitest";
import { parseSelectorText, selectorNavigateKeys } from "../tui-selector.ts";

// Fixtures are transcribed from real OMP/pi renders (login provider list and
// settings screens), including the two-column scrollbar remnant "│ │".

const LOGIN_SCREEN = [
  " π > ⬢ Mock Model > 🗑 proj ▶────23%╎──────33K─",
  "────────────────────────────────────────────────",
  " Update Available",
  " New version 18.12.6 is available. Run: omp update",
  "────────────────────────────────────────────────",
  "",
  "╭─ Select provider to login ───────────────────────────────────────────────────────────────────────╮",
  "│ ❯ ChatGPT Plus/Pro (Codex Subscription)                                                        █ │",
  "│   Anthropic (Claude Pro/Max)                                                                   │ │",
  "│   Z.AI (GLM Coding Plan)                                                                       │ │",
  "│   Kimi Code                                                                                    │ │",
  "│ Type to search                                                                                   │",
  "╰──────────────────────────────────────────────────────────────────────────────────────────────────╯",
  "telegram+ connected(current)",
].join("\n");

// Real capture from a machine with `symbolPreset: nerd`: the selection
// cursor renders as the private-area chevron U+F054 and the screen above the
// dialog carries QR/banner junk on top of the update box.
const NERD_LOGIN_SCREEN = [
  "                                     ██  ██       ▄▀▀▄ █▀▄▀▄ █▀▀▄",
  "                                     ██  ██       ▀▄▄▀ █ █ █ █▄▄▀",
  "                                     ▒▒  ██                  █",
  "                                         ██       v18.12.5",
  "",
  "               Tip: Use /tan to fork the current conversation into a background agent",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  " Update Available",
  " New version 18.12.6 is available. Run: omp update",
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  "",
  "╭─ Select provider to login ───────────────────────────────────────────────────────────────────────╮",
  "│ \uF054 ChatGPT Plus/Pro (Codex Subscription)  logged in (login)                                   █ │",
  "│   Anthropic (Claude Pro/Max)                                                                   │ │",
  "│   Z.AI (GLM Coding Plan)                                                                       │ │",
  "│   Z.AI (GLM Coding Plan · Sign in)                                                             │ │",
  "│   Kimi Code                                                                                    │ │",
  "│   OpenRouter                                                                                   │ │",
  "│   GitHub Copilot                                                                               │ │",
  "│   Cursor (Claude, GPT, etc.)                                                                   │ │",
  "│   Devin                                                                                        │ │",
  "│   Google Antigravity (Gemini, Claude, GPT-OSS)                                                 │ │",
  "│ Type to search                                                                                   │",
  "╰──────────────────────────────────────────────────────────────────────────────────────────────────╯",
].join("\n");

const labels = (text: string) => {
  const state = parseSelectorText(text);
  return state?.options.map((option) => `${option.selected ? "!" : ""}${option.label}`);
};

describe("parseSelectorText", () => {
  it("parses the real login provider list with the cursor on the first item", () => {
    const state = parseSelectorText(LOGIN_SCREEN);
    expect(state).toBeDefined();
    expect(state?.title).toBe("Select provider to login");
    expect(state?.options).toHaveLength(4);
    expect(labels(LOGIN_SCREEN)).toEqual([
      "!ChatGPT Plus/Pro (Codex Subscription)",
      "Anthropic (Claude Pro/Max)",
      "Z.AI (GLM Coding Plan)",
      "Kimi Code",
    ]);
  });

  it("strips border and scrollbar residue from option labels", () => {
    const state = parseSelectorText(LOGIN_SCREEN);
    for (const option of state?.options ?? []) {
      expect(option.label).not.toMatch(/[│┃█▌▐|]/);
    }
  });

  it("parses nerd-preset renders where the cursor is a private-area glyph", () => {
    const state = parseSelectorText(NERD_LOGIN_SCREEN);
    expect(state?.title).toBe("Select provider to login");
    expect(state?.options).toHaveLength(10);
    const parsed = labels(NERD_LOGIN_SCREEN) ?? [];
    expect(parsed[0]).toBe("!ChatGPT Plus/Pro (Codex Subscription) logged in (login)");
    for (const label of parsed) expect(label).not.toMatch(/[\uE000-\uF8FF]/);
  });

  it("excludes search hints and key legends from options", () => {
    const withLegends = [
      "╭─ Settings ──────────────╮",
      "│ ❯ [T] Theme: dark       │",
      "│   [M] Models            │",
      "│   Thinking              │",
      "│ Type to search          │",
      "│ ↑↓ to move · Enter to select · Esc to close │",
      "╰─────────────────────────╯",
    ].join("\n");
    expect(labels(withLegends)).toEqual(["![T] Theme: dark", "[M] Models", "Thinking"]);
  });

  it("keeps toggle-style option labels intact", () => {
    const toggles = [
      "╭─ Settings ──────────────╮",
      "│ ❯ Theme: dark        (on/off) │",
      "│   Thinking mode        (on/off) │",
      "╰─────────────────────────╯",
    ].join("\n");
    expect(labels(toggles)).toEqual(["!Theme: dark (on/off)", "Thinking mode (on/off)"]);
  });

  it("keeps two-column entries whole (label plus trailing status column)", () => {
    const twoColumn = [
      "╭─ Select provider ────────────────────────────────────────────────╮",
      "│ ❯ ChatGPT Plus/Pro (Codex Subscription)  - logged in (login)   █ │",
      "│   Z.AI (GLM Coding Plan)  - Sign in                            │ │",
      "╰──────────────────────────────────────────────────────────────────╯",
    ].join("\n");
    const state = parseSelectorText(twoColumn);
    expect(state?.options.map((option) => option.label)).toEqual([
      "ChatGPT Plus/Pro (Codex Subscription) - logged in (login)",
      "Z.AI (GLM Coding Plan) - Sign in",
    ]);
  });

  it("requires a visible selection marker; without one nothing is selectable", () => {
    const noMarker = [
      "╭─ Pick ─────────────╮",
      "│   Kimi Code      │",
      "│   OpenRouter     │",
      "╰──────────────────╯",
    ].join("\n");
    expect(parseSelectorText(noMarker)).toBeUndefined();
  });

  it("returns undefined for screens without a dialog box", () => {
    const editor = " π welcome\n> some transcript output\n$ ls -la\n";
    expect(parseSelectorText(editor)).toBeUndefined();
  });

  it("parses the last box when several boxes are on screen", () => {
    const twoBoxes = [
      "╭─ Old ────────────╮",
      "│ ❯ first          │",
      "│   second         │",
      "╰──────────────────╯",
      "status line",
      "╭─ New ────────────╮",
      "│   third          │",
      "│ ❯ fourth         │",
      "╰──────────────────╯",
    ].join("\n");
    const state = parseSelectorText(twoBoxes);
    expect(state?.title).toBe("New");
    expect(labels(twoBoxes)).toEqual(["third", "!fourth"]);
  });

  it("crops the display block to the dialog region only", () => {
    const state = parseSelectorText(LOGIN_SCREEN);
    expect(state?.block.startsWith("╭─ Select provider to login")).toBe(true);
    expect(state?.block.endsWith("╯")).toBe(true);
    expect(state?.block).not.toContain("Update Available");
    expect(state?.block).not.toContain("connected");
  });
});

describe("selectorNavigateKeys", () => {
  const state = parseSelectorText(LOGIN_SCREEN)!;

  it("confirms immediately when the target is already selected", () => {
    expect(selectorNavigateKeys(state, 0)).toEqual(["enter"]);
  });

  it("walks down one step per option gap", () => {
    expect(selectorNavigateKeys(state, 3)).toEqual(["down", "down", "down", "enter"]);
  });

  it("walks up when the target sits above the marker", () => {
    const scrolled = parseSelectorText([
      "╭─ Pick ─────────────╮",
      "│   Kimi Code      │",
      "│ ❯ OpenRouter     │",
      "│   GitHub Copilot │",
      "╰──────────────────╯",
    ].join("\n"))!;
    expect(selectorNavigateKeys(scrolled, 0)).toEqual(["up", "enter"]);
    expect(selectorNavigateKeys(scrolled, 2)).toEqual(["down", "enter"]);
  });

  it("refuses to guess without a marker or outside the list", () => {
    expect(selectorNavigateKeys(state, 99)).toBeUndefined();
    expect(selectorNavigateKeys(state, -1)).toBeUndefined();
    const unmarked = parseSelectorText([
      "╭─ Pick ─────────────╮",
      "│   Kimi Code      │",
      "│   OpenRouter     │",
      "╰──────────────────╯",
    ].join("\n"));
    expect(unmarked).toBeUndefined();
  });
});
