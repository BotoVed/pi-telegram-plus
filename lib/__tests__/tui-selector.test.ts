import { describe, expect, it } from "vitest";
import { parseSelectorText, readDialogTitle, selectorNavigateKeys } from "../tui-selector.ts";

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

  it("parses pi's borderless selector by its cursor rows and key legend", () => {
    // Real capture from pi 0.81.1: extension selectors have no side borders,
    // the title ends with ":" and the overlay closes with a key legend.
    const piAuthSelector = [
      "────────────────────────────────────────────────────────",
      "",
      " Select authentication method:",
      "",
      " → Sign in with an account",
      "   Sign in with an API key",
      "",
      " ↑↓ navigate  enter select  escape/ctrl+c cancel",
      "",
      "────────────────────────────────────────────────────────",
    ].join("\n");
    const state = parseSelectorText(piAuthSelector);
    expect(state?.title).toBe("Select authentication method");
    expect(state?.windowed).toBe(false);
    expect(labels(piAuthSelector)).toEqual([
      "!Sign in with an account",
      "Sign in with an API key",
    ]);
  });

  it("keeps a prompt title verbatim when the host does not add a colon", () => {
    // pi passes the title through unchanged; a mid-turn tool prompt reads
    // "Probe: pick one" with no trailing colon.
    const piPrompt = [
      " ⠇ Working...",
      "",
      " Probe: pick one",
      "",
      " → alpha",
      "   beta",
      "   gamma",
      "",
      " ↑↓ navigate  enter select  escape/ctrl+c cancel",
      "",
    ].join("\n");
    const state = parseSelectorText(piPrompt);
    expect(state?.title).toBe("Probe: pick one");
    expect(labels(piPrompt)).toEqual(["!alpha", "beta", "gamma"]);
  });

  it("drops subtitle, search and description rows from a switch list", () => {
    const screen = [
      "╭─ Switch Model ──────────────────────────────────────────────╮",
      "│ Session-only switch — role models stay unchanged             │",
      "│ 🔍 >                                                         │",
      "│ ❯ mock/mock-model ● 33k ◫ free                               │",
      "│   other/model ● 8k ◫ free                                    │",
      "│ Mock Model · 33k ctx · 4.1k out · free per M…                │",
      "│ ⏎ select · ⎋ cancel                                          │",
      "╰──────────────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(labels(screen)).toEqual(["!mock/mock-model ● 33k ◫ free", "other/model ● 8k ◫ free"]);
  });

  it("parses checkbox rows as a multi-select question", () => {
    const screen = [
      "╭─ Ask ────────────────────────────────────────────────────────╮",
      "│ Pick toppings                                                │",
      "├──────────────────────────────────────────────────────────────┤",
      "│ ❯ ☐ cheese                                                   │",
      "│   ☑ mushroom                                                 │",
      "│   ☐ olive                                                    │",
      "├──────────────────────────────────────────────────────────────┤",
      "│ ␣ toggle · ⏎ submit · ⇥/←/→ question · ⎋ cancel              │",
      "╰──────────────────────────────────────────────────────────────╯",
    ].join("\n");
    const state = parseSelectorText(screen);
    expect(state?.multiSelect).toBe(true);
    expect(state?.multiQuestion).toBe(true);
    expect(state?.options.map((option) => option.label)).toEqual(["cheese", "mushroom", "olive"]);
    expect(state?.options.map((option) => option.selected)).toEqual([true, false, false]);
    expect(state?.options.map((option) => option.checked)).toEqual([false, true, false]);
  });

  it("treats a two-pane detail view as a panel, not an option list", () => {
    const screen = [
      "╭─ BTW history ────────────────────────────────────────────────╮",
      "│ History (0)      │ Details                                   │",
      "│                  │                                           │",
      "│                  │ Use /btw QUESTION to start one.           │",
      "│                  │                                           │",
      "│                  │                                           │",
      "│ ↑/↓ select                                                   │",
      "│ ⎋ close                                                      │",
      "╰──────────────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(parseSelectorText(screen)).toBeUndefined();
  });

  it("parses a radio group without turning the question into an option", () => {
    // Real capture from OMP's ask tool: cursor beside a radio glyph, question
    // text above the group, key legend below.
    const askDialog = [
      "╭─ Ask ──────────────────────────────────────────────╮",
      "│ Pick a color for the acceptance run                │",
      "├────────────────────────────────────────────────────┤",
      "│   ○ red                                            │",
      "│ ❯ ○ green (Recommended)                            │",
      "│   ○ blue                                           │",
      "│   ○ Other (type your own)                          │",
      "├────────────────────────────────────────────────────┤",
      "│ ⏎ select · n note · ↑/↓ move · ⎋ cancel · ⌥H hide  │",
      "╰────────────────────────────────────────────────────╯",
    ].join("\n");
    const state = parseSelectorText(askDialog);
    expect(state?.title).toBe("Ask");
    expect(labels(askDialog)).toEqual([
      "red",
      "!green (Recommended)",
      "blue",
      "Other (type your own)",
    ]);
  });

  it("parses a single-option dialog that renders its legend", () => {
    // Real capture from OMP's logout account picker (one signed-in account):
    // a boxed list with a cursor row and a legend, no second option.
    const oneAccount = [
      "╭─ Select ChatGPT Plus/Pro (Codex Subscription) account to log out ─────────╮",
      "│ \uF054 chenuseai@outlook.com (plus) (active)  chenuseai@outlook.com · account e8aa │",
      "│ ↑/↓ select ·  log out account ·  cancel                                    │",
      "╰────────────────────────────────────────────────────────────────────────────╯",
    ].join("\n");
    const state = parseSelectorText(oneAccount);
    expect(state?.title).toBe("Select ChatGPT Plus/Pro (Codex Subscription) account to log out");
    expect(state?.options).toHaveLength(1);
    expect(state?.options[0]?.selected).toBe(true);
    expect(state?.options[0]?.label).toContain("chenuseai@outlook.com (plus) (active)");
  });

  it("reads the dialog title from non-selector overlays", () => {
    const oauthWait = [
      "╭─ Login to OpenRouter ──────────────────────────────────────╮",
      "│ https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost │",
      "│ Waiting for browser authentication...                        │",
      "╰──────────────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(parseSelectorText(oauthWait)).toBeUndefined();
    expect(readDialogTitle(oauthWait)).toBe("Login to OpenRouter");
  });

  it("parses pi's provider window and its scroll indicator", () => {
    // Real capture from pi 0.81.1: eight rows of a 39-provider list, with the
    // search input above and "(cursor/total)" underneath.
    const screen = (scroll: string) => [
      "─────────────────────────────────────────────────",
      "",
      " Select provider to configure:",
      "",
      ">",
      "",
      " → Amazon Bedrock • unconfigured",
      "   Ant Ling • unconfigured",
      "   Anthropic • unconfigured",
      "   Azure OpenAI • unconfigured",
      "   Cerebras • unconfigured",
      "   Cloudflare AI Gateway • unconfigured",
      "   Cloudflare Workers AI • unconfigured",
      "   DeepSeek • unconfigured",
      `   ${scroll}`,
      "",
      "─────────────────────────────────────────────────",
    ].join("\n");

    const first = parseSelectorText(screen("(1/39)"));
    expect(first?.title).toBe("Select provider to configure");
    expect(first?.options).toHaveLength(8);
    expect(first?.windowed).toBe(true);
    expect(first?.total).toBe(39);
    expect(first?.moreAbove).toBe(false);
    expect(first?.moreBelow).toBe(true);

    const scrolled = parseSelectorText(screen("(20/39)"));
    expect(scrolled?.moreAbove).toBe(true);
    expect(scrolled?.moreBelow).toBe(true);
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
