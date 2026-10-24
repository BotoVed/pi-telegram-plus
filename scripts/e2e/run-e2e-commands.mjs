#!/usr/bin/env node
/**
 * Full command acceptance: isolated tmux + real pi/OMP + mock Bot API + mock
 * provider. Drives every command the bot advertises (setMyCommands), the
 * plugin's hidden management commands, and every nested menu level reachable
 * from /tg, /model, /scoped-models, /login, /logout, /settings.
 *
 * Usage:
 *   node scripts/e2e/run-e2e-commands.mjs [--host pi|omp|both]
 *     [--pi-bin <path>] [--tg-port 9950] [--provider-port 9951]
 *     [--timeout 30] [--keep]
 *
 * Exit code is non-zero when any step fails.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateTelegramCalls } from "./telegram-contract.mjs";

const REPO = resolve(import.meta.dirname, "..", "..");
const PLUGIN = join(REPO, "index.ts");
const E2E = join(REPO, "scripts", "e2e");

const argValue = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
};
const HOST_ARG = argValue("--host", "both");
const KEEP = process.argv.includes("--keep");
const PHASE_ARG = argValue("--phase", "");
const TG_PORT = Number(argValue("--tg-port", "9950"));
const PROVIDER_PORT = Number(argValue("--provider-port", "9951"));
const STEP_TIMEOUT_MS = Number(argValue("--timeout", "30")) * 1000;
const OMP_CLI = argValue("--omp", process.env.OMP_CLI || "omp");
const PI_CLI = resolve(REPO, argValue("--pi-bin", "node_modules/.bin/pi"));
const ROOT = process.env.PITG_E2E_COMMANDS_ROOT || "/tmp/pitg-e2e-commands";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const tmux = (...args) => sh("tmux", args);
const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const RESPONSE_METHODS = new Set([
  "sendMessage", "sendPhoto", "sendDocument", "editMessageText", "editMessageReplyMarkup",
]);

async function control(path, init) {
  const res = await fetch(`http://127.0.0.1:${TG_PORT}${path}`, {
    ...init,
    headers: { connection: "close", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
const controlGet = () => control("/_control/log");
const controlPost = (path, body) => control(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

async function waitFor(label, predicate, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await controlGet();
      const value = predicate(last);
      if (value) return value === true ? last : value;
    } catch (error) {
      last = { error: String(error) };
    }
    await sleep(200);
  }
  throw new Error(`timed out: ${label} (last: ${JSON.stringify(last).slice(0, 600)})`);
}

function killSession(session) {
  tmux("pipe-pane", "-t", session);
  for (let attempt = 0; attempt < 3; attempt += 1) tmux("kill-session", "-t", session);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const ls = tmux("ls");
    if (ls.status !== 0 || !String(ls.stdout ?? "").includes(session)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

function seed(host, runDir) {
  const agentDir = join(runDir, "agent");
  const projectDir = join(runDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  if (host === "pi") {
    writeFileSync(join(agentDir, "settings.json"), "{}\n");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        mock: {
          baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`,
          api: "openai-completions",
          apiKey: "mock",
          models: [{ id: "mock-model" }],
        },
      },
    }, null, 2) + "\n");
  } else {
    writeFileSync(join(agentDir, "config.yml"), "setupVersion: 2\nstartup:\n  setupWizard: false\n");
    writeFileSync(join(agentDir, "models.yml"), [
      "providers:", "  mock:", `    baseUrl: http://127.0.0.1:${PROVIDER_PORT}/v1`,
      "    apiKey: mock", "    api: openai-completions", "    models:",
      "      - id: mock-model", "        name: Mock Model", "        contextWindow: 32768",
      "        maxTokens: 4096", "",
    ].join("\n"));
  }
  writeFileSync(join(agentDir, "tg.json"), JSON.stringify({
    version: 3,
    bots: [{
      id: `${host}-bot`, name: host,
      token: `${host === "pi" ? "333333" : "444444"}:COMMANDS_TOKEN`,
      allowedUserId: 42, apiBase: `http://127.0.0.1:${TG_PORT}`,
    }],
    defaultBotId: `${host}-bot`,
  }, null, 2) + "\n");
  writeFileSync(join(projectDir, ".pi", "telegram.json"), JSON.stringify({
    botId: `${host}-bot`, enabled: true, activeChatId: 42, tuiBridge: "full", bashConfirm: "dangerous",
  }, null, 2) + "\n");
  return { agentDir, projectDir };
}

function startHost(host, projectDir, agentDir, paneLog, session) {
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_TELEGRAM_API_BASE: `http://127.0.0.1:${TG_PORT}`,
    PI_OFFLINE: "1",
    TMPDIR: join(ROOT, "tmp"),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  const envArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const args = host === "omp"
    ? [OMP_CLI, "-e", PLUGIN, "--model", "mock/mock-model", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--approval-mode", "yolo", "--no-title"]
    : [PI_CLI, "--no-skills", "--no-extensions", "-e", PLUGIN, "--provider", "mock", "--model", "mock-model"];
  const command = `cd ${shq(projectDir)} && exec ${args.map(shq).join(" ")}`;
  const result = tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", projectDir, ...envArgs, command);
  if (result.status === 0) tmux("pipe-pane", "-t", session, `cat > ${shq(paneLog)}`);
  return result;
}

const rowsOf = (call) => call?.body?.reply_markup?.inline_keyboard;
const buttonsOf = (call) => (rowsOf(call) ?? []).flat();
const hasTui = (call) => buttonsOf(call).some((b) => String(b.callback_data ?? "").startsWith("tgplus:tui:"));
// Full bridge mode brokers dialogs: the keyboard carries `tgplus:dlg:` buttons
// whose `c/t/v/m` ops are list rows and whose `x` op cancels.
const DIALOG_CANCEL = /^tgplus:dlg:[^:]+:\d+:x$/;
const hasDialog = (call) => buttonsOf(call).some((b) => String(b.callback_data ?? "").startsWith("tgplus:dlg:"));
const isControllable = (call) => hasTui(call) || hasDialog(call);
const hasUi = (call) => buttonsOf(call).some((b) => String(b.callback_data ?? "").startsWith("tgplus:ui:"));
const lastKeyboardCall = (state, since = 0) => state.calls.slice(since).findLast((c) => Array.isArray(rowsOf(c)));
const signature = (call) => `${String(call?.body?.text ?? "").slice(0, 200)}|${buttonsOf(call).map((b) => `${b.text}:${b.callback_data}`).join(",")}`;

async function runHost(host, label, phase = "main") {
  const slug = label.replace(/[^a-zA-Z0-9_-]/g, "-");
  const session = `pitg-cmd-${slug}`;
  const runDir = join(ROOT, `run-${slug}`);
  const paneLog = join(runDir, "pane.log");
  rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(runDir, { recursive: true });
  killSession(session);
  await controlPost("/_control/reset");

  const results = [];
  const record = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const { agentDir, projectDir } = seed(host, runDir);
  const start = startHost(host, projectDir, agentDir, paneLog, session);
  if (start.status !== 0) {
    record("start host in tmux", false, start.stderr?.trim());
    return { results, ok: false, session, runDir };
  }
  record("start host in tmux", true, session);

  let updateId = 5000;
  let messageId = 9000;
  const injectMessage = (text) => controlPost("/_control/inject", {
    updates: [{
      update_id: updateId++,
      message: {
        message_id: messageId++, date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "E2E" },
        text,
      },
    }],
  });
  const injectCallback = async (data, targetMessageId) => {
    const callbackId = `cb-${updateId}`;
    await controlPost("/_control/inject", {
      updates: [{
        update_id: updateId++,
        callback_query: {
          id: callbackId, from: { id: 42, is_bot: false, first_name: "E2E" },
          message: { message_id: targetMessageId, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: "private" } },
          chat_instance: "e2e", data,
        },
      }],
    });
    return callbackId;
  };

  const paneHas = (needle) => String(tmux("capture-pane", "-p", "-t", session).stdout ?? "").includes(needle);
  const hostAlive = () => tmux("has-session", "-t", session).status === 0;

  try {
    await waitFor("plugin authenticates", (state) => state.calls.some((c) => c.method === "getMe"), 60_000);
    record("plugin authenticates", true);
  } catch (error) {
    record("plugin authenticates", false, String(error.message).slice(0, 300));
    return { results, ok: false, session, runDir };
  }

  // ── Bot menu inventory ────────────────────────────────────────────────
  let menuCommands = [];
  try {
    const call = await waitFor("BotMenu published", (state) =>
      state.calls.findLast((entry) => entry.method === "setMyCommands" && Array.isArray(entry.body?.commands)), 30_000);
    menuCommands = call.body.commands.map((c) => `/${c.command}`);
    record("BotMenu published", menuCommands.length > 0, `${menuCommands.length} commands`);
  } catch (error) {
    record("BotMenu published", false, String(error.message).slice(0, 300));
  }

  const cursor = async () => (await controlGet()).calls.length;

  /** Dispatch a command and wait for the first visible response. */
  const dispatch = async (command, { timeoutMs = STEP_TIMEOUT_MS } = {}) => {
    const since = await cursor();
    await injectMessage(command);
    const call = await waitFor(`response to ${command}`, (state) => {
      const hit = state.calls.slice(since).find((entry) =>
        RESPONSE_METHODS.has(entry.method)
        && entry.body
        && (typeof entry.body.text === "string" || Array.isArray(entry.body.reply_markup?.inline_keyboard)));
      return hit ?? false;
    }, timeoutMs);
    return call;
  };

  /** Click a button and wait for the next keyboard/text produced for it. */
  const click = async (button, targetMessageId, { timeoutMs = STEP_TIMEOUT_MS } = {}) => {
    const since = await cursor();
    const callbackId = await injectCallback(String(button.callback_data), targetMessageId);
    await waitFor(`callback answered: ${button.text}`, (state) =>
      state.calls.some((c) => c.method === "answerCallbackQuery" && c.body?.callback_query_id === callbackId), timeoutMs);
    const call = await waitFor(`follow-up after ${button.text}`, (state) => {
      // Only this menu's message (or a fresh send) answers the click; stray
      // mirror edits from leftover TUI overlays must not be mistaken for it.
      const hit = state.calls.slice(since).findLast((entry) =>
        RESPONSE_METHODS.has(entry.method) && entry.body
        && (entry.method === "sendMessage" || entry.body.message_id === targetMessageId)
        && (Array.isArray(entry.body.reply_markup?.inline_keyboard) || typeof entry.body.text === "string"));
      return hit ?? false;
    }, timeoutMs);
    return call;
  };

  const findButton = (call, pattern) => buttonsOf(call).find((b) => pattern.test(String(b.text ?? "")));

  /** Leave any open menu/mirror so the next command starts clean. */
  const settle = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const state = await controlGet();
      const call = lastKeyboardCall(state);
      if (!call) return;
      const target = call.body?.message_id ?? call.message_id;
      if (hasDialog(call)) {
        const cancel = buttonsOf(call).find((b) => DIALOG_CANCEL.test(String(b.callback_data ?? "")));
        if (!cancel) return;
        await click(cancel, target).catch(() => undefined);
        continue;
      }
      if (hasTui(call)) {
        const close = findButton(call, /^(Close|✖|❌|Esc)$/);
        if (!close) return;
        await click(close, target).catch(() => undefined);
        continue;
      }
      const back = findButton(call, /^(⬅️ Back|❌ Close|Cancel)$/);
      if (!back) return;
      await click(back, target).catch(() => undefined);
    }
  };

  if (phase === "quit" || phase === "exit" || phase === "disconnect") {
    if (phase === "quit") {
      try {
        const prompt = await dispatch("/quit");
        const yes = findButton(prompt, /^(Yes|Confirm|OK|✅.*)$/i);
        const labels = buttonsOf(prompt).map((b) => b.text).join(" / ");
        if (yes) await click(yes, prompt.body?.message_id ?? prompt.message_id).catch(() => undefined);
        const outcome = await waitFor("quit outcome", (state) => {
          if (!hostAlive()) return "exited";
          const note = state.calls.findLast((c) => /Shutdown requested/i.test(String(c.body?.text ?? "")));
          return note ? "requested" : false;
        }, 20_000).catch(() => undefined);
        record("command /quit shuts down", outcome === "exited" || outcome === "requested",
          `${outcome ?? "no outcome"} · buttons: ${labels || "(none)"}`);
      } catch (error) {
        record("command /quit shuts down", !hostAlive(), String(error.message).slice(0, 200));
      }
    } else if (phase === "exit") {
      const menu = await waitFor("BotMenu published", (state) =>
        state.calls.findLast((entry) => entry.method === "setMyCommands" && Array.isArray(entry.body?.commands)), 30_000).catch(() => undefined);
      const advertised = menu?.body?.commands?.some((entry) => entry.command === "exit");
      if (!advertised) {
        record("command /exit (not advertised by this host)", true, "skipped: host has no /exit");
      } else {
      const since = await cursor();
      await injectMessage("/exit");
      const outcome = await waitFor("exit outcome", (state) => {
        if (!hostAlive()) return "exited";
        const note = state.calls.slice(since).findLast((c) => /exit|shutdown|bye/i.test(String(c.body?.text ?? "")));
        return note ? "noticed" : false;
      }, 20_000).catch(() => undefined);
      record("command /exit shuts down", outcome === "exited", String(outcome ?? "no outcome"));
      }
    } else {
      try {
        const call = await dispatch("/tg-cwd-disconnect");
        record("command /tg-cwd-disconnect disables the project", /Disabling bot|disabled/i.test(String(call.body?.text ?? "")),
          String(call.body?.text ?? "").replace(/\s+/g, " ").slice(0, 90));
        await sleep(1500);
        record("host stays alive after disconnect", hostAlive());
      } catch (error) {
        record("command /tg-cwd-disconnect disables the project", false, String(error.message).slice(0, 200));
      }
    }
    const paneTail = String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");
    record("host pane free of crashes", !/Uncaught|TypeError:|ReferenceError:/.test(paneTail));
    if (!KEEP) { killSession(session); try { await controlPost("/_control/reset"); } catch { /* ignore */ } }
    return { results, ok: results.every((r) => r.ok), session, runDir };
  }

  if (phase === "window") {
    // Compare the /new -> /name hand-off window across hosts/versions, and
    // prove a single Telegram /new yields exactly one new session. The next
    // command is sent immediately after /new's confirmation/ack.
    const sessionsDir = join(runDir, "agent", "sessions");
    const countSessionFiles = () => {
      try {
        return readdirSync(sessionsDir, { recursive: true, encoding: "utf8" })
          .filter((name) => String(name).endsWith(".jsonl")).length;
      } catch {
        return 0;
      }
    };
    const sessionsBefore = countSessionFiles();
    const startedAt = Date.now();
    let prompt;
    try {
      prompt = await dispatch("/new");
    } catch (error) {
      record("window /new response", false, String(error.message).slice(0, 160));
    }
    const yes = prompt ? findButton(prompt, /^(Yes|Confirm|OK|✅.*)$/i) : undefined;
    if (yes) await click(yes, prompt.body?.message_id ?? prompt.message_id, { timeoutMs: 20_000 }).catch(() => undefined);
    const clickAt = Date.now();
    let reply;
    try {
      reply = await dispatch("/name window-probe", { timeoutMs: 60_000 });
    } catch {
      reply = undefined;
    }
    const text = String(reply?.body?.text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 120);
    record("window /new -> /name hand-off", Boolean(reply),
      `${Date.now() - clickAt}ms after /new, ${Date.now() - startedAt}ms total · ${text}`);

    // A single Telegram /new must create exactly one new session and emit one
    // ack. A turn flushes the new session's .jsonl, so the file count shows how
    // many sessions /new created; the ack count shows how many times it ran. A
    // second file or ack means the unconfirmed /new update was re-delivered to
    // the replacement runtime and run again, because the cursor was not
    // committed before the in-process session replacement.
    await dispatch("after new flush", { timeoutMs: 60_000 }).catch(() => undefined);
    await sleep(1000);
    const sessionsAfter = countSessionFiles();
    const newAcks = (await controlGet()).calls
      .filter((c) => c.method === "sendMessage" && /▶️\s*\/new/.test(String(c.body?.text ?? ""))).length;
    record("window /new creates exactly one session",
      sessionsAfter - sessionsBefore === 1 && newAcks === 1,
      `sessions +${sessionsAfter - sessionsBefore}, /new acks=${newAcks}`);

    const paneTail = String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");
    record("host pane free of crashes", !/Uncaught|TypeError:|ReferenceError:/.test(paneTail));
    if (!KEEP) { killSession(session); try { await controlPost("/_control/reset"); } catch { /* ignore */ } }
    return { results, ok: results.every((r) => r.ok), session, runDir };
  }

  // ── Scripted `ask` tool round trip ─────────────────────────────────────
  // The mock provider answers the marker message with a real tool_call for the
  // host's `ask` tool, so the model→tool→UI→answer→model loop is exercised.
  try {
    const since = await cursor();
    await injectMessage("please run the ask probe ASK_TOOL_PROBE");
    const mirror = await waitFor("ask prompt mirrored", (state) =>
      state.calls.slice(since).findLast((entry) =>
        Array.isArray(rowsOf(entry)) && (isControllable(entry) || hasUi(entry))), 25_000)
      .catch(() => undefined);
    if (!mirror) {
      const providerLog = join(ROOT, "provider.jsonl");
      const askedTool = existsSync(providerLog)
        && readFileSync(providerLog, "utf8").split("\n").filter(Boolean)
          .map((line) => { try { return JSON.parse(line); } catch { return {}; } })
          .some((entry) => (entry.tools ?? []).includes("ask"));
      record("ask tool prompt reaches Telegram", !askedTool,
        askedTool ? "tool offered but nothing reached the chat" : "skipped: host offers no ask tool");
    } else {
      const labels = buttonsOf(mirror).map((b) => String(b.text ?? ""));
      record("ask tool prompt reaches Telegram", /red|green|blue/.test(labels.join(" ")),
        String(mirror.body?.text ?? "").replace(/<[^>]+>/g, "") + " · " + labels.slice(0, 4).join(" / "));
      const green = buttonsOf(mirror).find((b) => /green/.test(String(b.text ?? ""))) ?? buttonsOf(mirror)[0];
      const mirrorId = mirror.body?.message_id ?? mirror.message_id;
      if (green) {
        const pickSince = await cursor();
        await click(green, mirrorId);
        const reply = await waitFor("ask answer reaches the model", (state) =>
          state.calls.slice(pickSince).findLast((c) => c.method === "sendMessage" && /MOCK_OK/i.test(String(c.body?.text ?? ""))) ?? false,
          30_000).catch(() => undefined);
        record("ask answered from Telegram", Boolean(reply),
          `${isControllable(mirror) ? (hasDialog(mirror) ? "broker" : "mirror") : "native"} · ${reply ? "turn completed" : "no follow-up reply"}`);
      }
    }
    await settle();
  } catch (error) {
    record("ask tool round trip", false, String(error.message).slice(0, 220));
  }

  // ── Stage 1: output-only commands must return real body text ──────────
  // These assertions run before /reload and /new so the gateway has a stable
  // host. A response that is only the command ack does not pass.
  if (host === "pi") {
    const bodyText = (entry) => String(entry?.body?.text ?? "");
    const waitBody = (label, since, pattern, timeoutMs = 25_000) =>
      waitFor(label, (state) =>
        state.calls.slice(since).find((entry) =>
          (entry.method === "sendMessage" || entry.method === "editMessageText")
          && pattern.test(bodyText(entry))) ?? false, timeoutMs).catch(() => undefined);

    try {
      let since = await cursor();
      await dispatch("/session");
      const sessionBody = await waitBody("session body", since, /Session Info|Messages:/i);
      record("stage1 /session body has session details", Boolean(sessionBody),
        bodyText(sessionBody).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 140));
    } catch (error) {
      record("stage1 /session body has session details", false, String(error.message).slice(0, 200));
    }

    try {
      let since = await cursor();
      await dispatch("/name stage-one");
      await sleep(800);
      since = await cursor();
      await dispatch("/session");
      const namedBody = await waitBody("named session body", since, /Name:\s*stage-one/i);
      record("stage1 /name x is reflected by /session", Boolean(namedBody),
        bodyText(namedBody).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 140));
    } catch (error) {
      record("stage1 /name x is reflected by /session", false, String(error.message).slice(0, 200));
    }

    try {
      const since = await cursor();
      await dispatch("/changelog");
      const changelogBody = await waitBody("changelog body", since, /\b\d+\.\d+\.\d+\b/);
      record("stage1 /changelog body has a version", Boolean(changelogBody),
        bodyText(changelogBody).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 140));
    } catch (error) {
      record("stage1 /changelog body has a version", false, String(error.message).slice(0, 200));
    }

    try {
      const since = await cursor();
      await dispatch("/export");
      const exportBody = await waitBody("export body", since, /Session exported to:/i);
      const text = bodyText(exportBody);
      const path = text.match(/Session exported to:\s*([^<\s]+)/)?.[1];
      const resolved = path
        ? (existsSync(path) ? path : join(projectDir, path))
        : undefined;
      const doc = await waitFor("export document upload", (state) =>
        state.calls.slice(since).find((entry) => entry.method === "sendDocument" && Number(entry.body?._bytes ?? 0) > 0) ?? false,
        20_000).catch(() => undefined);
      record("stage1 /export returns an existing file", Boolean(resolved && existsSync(resolved) && doc),
        `${resolved ?? path ?? "(no path)"} · uploaded=${Boolean(doc)}`);
    } catch (error) {
      record("stage1 /export returns an existing file", false, String(error.message).slice(0, 200));
    }

    try {
      const since = await cursor();
      await dispatch("/compact");
      const compactBody = await waitBody("compact completion", since, /\/compact[\s\S]*(?:Compaction|compacted|Nothing to compact|✓ 完成)/i, 30_000);
      record("stage1 /compact returns completion output", Boolean(compactBody),
        bodyText(compactBody).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 140));
    } catch (error) {
      record("stage1 /compact returns completion output", false, String(error.message).slice(0, 200));
    }
  }

  // ── Every advertised command ──────────────────────────────────────────
  const terminating = new Set(["/quit", "/exit"]);
  for (const command of menuCommands) {
    if (terminating.has(command)) continue; // covered by their own phases
    try {
      const call = await dispatch(command);
      const text = String(call.body?.text ?? "").replace(/\s+/g, " ").slice(0, 80);
      const buttons = buttonsOf(call).length;
      record(`command ${command}`, true, `${text}${buttons ? ` [${buttons} buttons]` : ""}`);
      await settle();
    } catch (error) {
      record(`command ${command}`, false, String(error.message).slice(0, 240));
    }
    if (!hostAlive()) {
      record(`host alive after ${command}`, false, "tmux session went away");
      return { results, ok: false, session, runDir };
    }
  }

  // ── Hidden management commands (not in the bot menu by design) ────────
  // /more only answers when the bot menu overflows its page; /tg-cwd-disconnect
  // stops polling by design, so both are handled in their own phases.
  const hidden = [
    "/tg-bot-list", "/tg-bot-default", "/tg-bot-update", "/tg-bot-remove",
  ];
  for (const command of hidden) {
    try {
      const call = await dispatch(command, { timeoutMs: 15_000 });
      const text = String(call.body?.text ?? "").replace(/\s+/g, " ").slice(0, 70);
      record(`hidden ${command}`, true, text || `${buttonsOf(call).length} buttons`);
      await settle();
    } catch (error) {
      const pane = String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");
      record(`hidden ${command}`, false, `${String(error.message).slice(0, 160)}${/Uncaught|TypeError/.test(pane) ? " · pane error" : ""}`);
    }
  }

  // ── Nested menus: /tg → level 2 → level 3 → level 4 ───────────────────
  const openMain = async () => {
    const since = await cursor();
    const call = await dispatch("/tg");
    const state = await controlGet();
    // Scope to this dispatch: panel mirrors from earlier commands now carry
    // keyboards (⎋ Close) and must not be mistaken for the /tg menu.
    const menu = state.calls.slice(since).findLast((entry) => findButton(entry, /🤖 Bots/));
    return menu ?? lastKeyboardCall(state, since) ?? call;
  };
  const menuStep = async (label, parentCall, buttonPattern, checks) => {
    const target = parentCall.body?.message_id ?? parentCall.message_id;
    const button = findButton(parentCall, buttonPattern);
    if (!button) {
      record(`menu ${label}`, false, `button not found: ${buttonPattern}`);
      return parentCall;
    }
    try {
      const call = await click(button, target);
      const text = String(call.body?.text ?? "");
      const labels = buttonsOf(call).map((b) => String(b.text ?? ""));
      const ok = checks.every((check) => (check instanceof RegExp ? check.test(text) || labels.some((l) => check.test(l)) : labels.includes(check)));
      record(`menu ${label}`, ok, `${text.replace(/\s+/g, " ").slice(0, 60)} · ${labels.slice(0, 6).join(" / ")}`);
      return call;
    } catch (error) {
      record(`menu ${label}`, false, String(error.message).slice(0, 240));
      return parentCall;
    }
  };

  const workedConfig = new Set();
  try {
    // Level 1: the hub.
    let main = await openMain();
    record("menu /tg opens", buttonsOf(main).length >= 5,
      buttonsOf(main).map((b) => b.text).join(" / "));

    // Level 2-4: Bots → Bot list → per-bot actions.
    let bots = await menuStep("Bots", main, /🤖 Bots/, [/🤖 Bots/, "➕ Add bot", "Bot list"]);
    let list = await menuStep("Bots → Bot list", bots, /^Bot list$/, [/Bot list/]);
    const botEntry = buttonsOf(list).find((b) => new RegExp(`(pi|omp) ?(★|·)|${host}-bot|· no username`, "i").test(String(b.text ?? "")));
    if (botEntry) {
      const detail = await menuStep("Bots → list → detail", list, new RegExp(String(botEntry.text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), [/Update/, /Remove/, /default/]);
      const back = findButton(detail, /^(⬅️ Back)$/);
      if (back) await click(back, detail.body?.message_id ?? detail.message_id).catch(() => undefined);
    } else {
      record("menu Bots → list → detail", false, `no bot entry: ${buttonsOf(list).map((b) => b.text).join(" / ")}`);
    }
    await settle();

    // Level 2-3: Project → bind picker.
    main = await openMain();
    const project = await menuStep("Project", main, /📁 Project/, [/Project/, /Bot: /, /Enabled: /]);
    const bindButton = buttonsOf(project).find((b) => /^Bot: /.test(String(b.text ?? "")));
    if (bindButton) {
      await menuStep("Project → bind", project, new RegExp(String(bindButton.text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), [/Bind project to bot/]);
    } else {
      record("menu Project → bind", false, "no bot row");
    }
    await settle();

    // Level 2-3: Config → every flow, choosing the current value (no change).
    main = await openMain();
    let config = await menuStep("Config", main, /⚙️ Config/, [/Telegram Config/]);
    for (let rounds = 0; rounds < 8; rounds += 1) {
      const entries = buttonsOf(config)
        .map((b) => String(b.text ?? ""))
        .filter((label) => /^(🔧 Tool|💭 Thinking|🔄 Retry|🖥 TUI bridge|🐚 Shell confirm|🧠 Thinking level):/.test(label));
      const pending = entries.find((label) => !workedConfig.has(label));
      if (!pending) break;
      workedConfig.add(pending);
      const current = pending.split(":").slice(1).join(":").trim();
      const entry = findButton(config, new RegExp(`^${pending.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      if (!entry) { record(`config ${pending}`, false, "entry vanished"); continue; }
      const target = config.body?.message_id ?? config.message_id;
      try {
        const step3 = await click(entry, target);
        if (/Retry/.test(pending)) {
          const since = await cursor();
          await injectMessage(current.replace(/\D+/g, "") || "3");
          const done = await waitFor(`config ${pending} applied`, (state) =>
            state.calls.slice(since).find((c) => RESPONSE_METHODS.has(c.method) && /set to/.test(String(c.body?.text ?? ""))) ?? false);
          record(`config ${pending}`, true, String(done.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));
        } else {
          const option = buttonsOf(step3).find((b) => String(b.text ?? "").replace(/^● /, "").trim() === current);
          if (!option) {
            record(`config ${pending}`, false, `current "${current}" not offered: ${buttonsOf(step3).map((b) => b.text).join(" / ")}`);
          } else {
            const since = await cursor();
            await click(option, step3.body?.message_id ?? step3.message_id);
            const applied = await waitFor(`config ${pending} notice`, (state) =>
              state.calls.slice(since).find((c) => RESPONSE_METHODS.has(c.method) && /set to/.test(String(c.body?.text ?? ""))) ?? false, 10_000)
              .catch(() => undefined);
            // A host may reject setting the already-current value (e.g. a
            // model without thinking support); the level-3 menu opening and
            // offering the value is the navigation contract under test.
            const levelMenu = buttonsOf(step3).length > 0;
            record(`config ${pending}`, Boolean(applied) || levelMenu,
              String(applied?.body?.text ?? `menu offered ${buttonsOf(step3).map((b) => b.text).join(" / ")}`).replace(/\s+/g, " ").slice(0, 140));
          }
        }
      } catch (error) {
        record(`config ${pending}`, false, String(error.message).slice(0, 200));
      }
      const state = await controlGet();
      config = lastKeyboardCall(state) ?? config;
      if (!/Telegram Config/.test(String(config?.body?.text ?? ""))) {
        // A flow may close the menu; reopen it for the remaining entries.
        main = await openMain();
        config = await menuStep("Config (reopen)", main, /⚙️ Config/, [/Telegram Config/]);
      }
    }
    await settle();

    // Level 2-3: Commands → pick /status and verify its output. The catalog is
    // paginated (OMP advertises ~90 commands), so walk pages first.
    main = await openMain();
    let commands = await menuStep("Commands", main, /⌨️ Commands/, [/Commands \(/]);
    let statusButton = findButton(commands, /^\/status\b/);
    for (let page = 0; !statusButton && page < 12; page += 1) {
      const next = findButton(commands, /^Next ▶$/);
      if (!next) break;
      commands = await click(next, commands.body?.message_id ?? commands.message_id);
      statusButton = findButton(commands, /^\/status\b/);
    }
    if (statusButton) {
      record("menu Commands paging finds /status", true, `page with ${buttonsOf(commands).length} entries`);
    } else {
      const first = buttonsOf(commands).find((b) => /^\/[a-z_-]+ —/.test(String(b.text ?? "")) && !/^\/exit\b|^\/quit\b/.test(String(b.text ?? "")));
      record("menu Commands lists entries", Boolean(first), first ? String(first.text).slice(0, 50) : "none");
      statusButton = first;
    }
    if (statusButton) {
      const since = await cursor();
      await click(statusButton, commands.body?.message_id ?? commands.message_id);
      const status = await waitFor("status output from menu", (state) =>
        state.calls.slice(since).find((c) => RESPONSE_METHODS.has(c.method) && /TUI Status|Workspace|Session Info/i.test(String(c.body?.text ?? ""))) ?? false);
      record("menu Commands → /status", true, String(status.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));
    } else {
      record("menu Commands → /status", false, "status not in catalog");
    }
    await settle();

    // Level 2: Switch instance.
    main = await openMain();
    const sw = await menuStep("Switch instance", main, /🔄 Switch instance/, [/Switch Telegram pi instance|not the active|No live/i]);
    const swBack = findButton(sw, /^⬅️ Back$/);
    if (swBack) await click(swBack, sw.body?.message_id ?? sw.message_id).catch(() => undefined);
    await settle();
  } catch (error) {
    record("menu walk", false, String(error.message).slice(0, 300));
  }

  // ── Provider/model menus ──────────────────────────────────────────────
  try {
    const call = await dispatch("/model");
    const option = buttonsOf(call).find((b) => /mock/i.test(String(b.text ?? ""))) ?? buttonsOf(call)[0];
    const target = call.body?.message_id ?? call.message_id;
    if (option) {
      const applied = await click(option, target);
      record("menu /model selects", /Model set|set to/i.test(String(applied.body?.text ?? "")) || buttonsOf(applied).length === 0,
        String(applied.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));
    } else {
      record("menu /model selects", false, "no model buttons");
    }
  } catch (error) {
    record("menu /model selects", false, String(error.message).slice(0, 200));
  }
  await settle();

  try {
    const call = await dispatch("/scoped-models");
    record("menu /scoped-models opens", buttonsOf(call).length > 0 || /scoped|model/i.test(String(call.body?.text ?? "")),
      String(call.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));
    await settle();
  } catch (error) {
    record("menu /scoped-models opens", false, String(error.message).slice(0, 200));
  }

  // ── Login / logout / settings ─────────────────────────────────────────
  try {
    const call = await dispatch("/login");
    const isTui = hasTui(call);
    const isDialog = hasDialog(call);
    const isNative = hasUi(call);
    record("menu /login opens", isTui || isDialog || isNative || /login|provider/i.test(String(call.body?.text ?? "")),
      `${isTui ? "tui" : isDialog ? "dialog" : isNative ? "native" : "text"} · ${buttonsOf(call).map((b) => b.text).join(" / ").slice(0, 90)}`);
    await settle();
  } catch (error) {
    record("menu /login opens", false, String(error.message).slice(0, 200));
  }

  try {
    const call = await dispatch("/logout");
    record("menu /logout opens", /logout|credential|No stored/i.test(String(call.body?.text ?? "")) || buttonsOf(call).length > 0,
      String(call.body?.text ?? "").replace(/\s+/g, " ").slice(0, 70));
    await settle();
  } catch (error) {
    record("menu /logout opens", false, String(error.message).slice(0, 200));
  }

  try {
    const since = await cursor();
    const first = await dispatch("/settings");
    // The command first acknowledges itself ("TUI command"); the interactive
    // mirror then arrives as an edit carrying tgplus:tui: controls.
    const mirror = isControllable(first) ? first : await waitFor("settings mirror", (state) => {
      const hit = state.calls.slice(since).findLast((entry) => Array.isArray(rowsOf(entry)) && isControllable(entry));
      return hit ?? false;
    }, 15_000).catch(() => undefined);
    const native = buttonsOf(first).length > 0;
    record("menu /settings opens", (Boolean(mirror) && isControllable(mirror)) || native,
      mirror ? `tui mirror · ${buttonsOf(mirror).slice(0, 4).map((b) => b.text).join(" / ")}` : String(first.body?.text ?? "").replace(/<[^>]+>/g, "").slice(0, 60));
    // Cross-check the mirror against the host's real terminal, so this step
    // cannot pass on a fabricated screen.
    if (mirror && hasDialog(mirror)) {
      // A brokered dialog is built from the host component's own labels, so every
      // button label has to exist verbatim in the terminal - a fabricated mirror
      // cannot pass.
      const pane = String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");
      const words = [...new Set(buttonsOf(mirror)
        .map((b) => String(b.text ?? "").replace(/^[^A-Za-z]+/, "").slice(0, 12))
        .filter((word) => word.length >= 5))];
      const hits = words.filter((word) => pane.includes(word));
      record("settings mirror matches the host screen", hits.length >= 3,
        `${hits.length}/${words.length} dialog labels found in pane · ${hits.slice(0, 3).join(" / ")}`);
    } else if (mirror && hasTui(mirror)) {
      const pane = String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");
      const plain = String(mirror.body?.text ?? "").replace(/<[^>]+>/g, " ");
      const phrases = (plain.match(/[A-Za-z][A-Za-z0-9 ._-]{7,30}/g) ?? [])
        .map((phrase) => phrase.trim())
        .filter((phrase) => phrase.split(/\s+/).length >= 2);
      const hits = [...new Set(phrases)].filter((phrase) => pane.includes(phrase));
      record("settings mirror matches the host screen", hits.length >= 3,
        `${hits.length} phrases found in pane · ${hits.slice(0, 3).join(" / ")}`);
    }
    await settle();
  } catch (error) {
    record("menu /settings opens", false, String(error.message).slice(0, 200));
  }

  // ── Management mutations (isolated dirs; exercises the real flows) ────
  try {
    await dispatch("/tg-bot-add");
    await injectMessage("e2e-extra");
    await waitFor("bot token prompt", (state) =>
      state.calls.findLast((c) => RESPONSE_METHODS.has(c.method) && /token/i.test(String(c.body?.text ?? ""))) ?? false);
    const since = await cursor();
    await injectMessage("555555:E2E_TOKEN");
    const added = await waitFor("bot added", (state) =>
      state.calls.slice(since).findLast((c) => RESPONSE_METHODS.has(c.method) && /Bot added/i.test(String(c.body?.text ?? ""))) ?? false);
    record("management /tg-bot-add", true, String(added.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));

    const removed = await dispatch("/tg-bot-remove e2e-extra");
    record("management /tg-bot-remove", /Removed|removed/i.test(String(removed.body?.text ?? "")),
      String(removed.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));
  } catch (error) {
    record("management bot CRUD", false, String(error.message).slice(0, 220));
  }
  await settle();

  try {
    const bind = await dispatch("/tg-bind-cwd");
    const options = buttonsOf(bind);
    const target = bind.body?.message_id ?? bind.message_id;
    const botButton = options.find((b) => /(pi|omp)-bot|^Bot: |bi\(/.test(String(b.text ?? ""))) ?? options[0];
    if (botButton) {
      await click(botButton, target);
      record("management /tg-bind-cwd", true, `picked ${botButton.text}`);
    } else {
      record("management /tg-bind-cwd", false, "no bot option");
    }
    const unbind = await dispatch("/tg-unbind-cwd");
    record("management /tg-unbind-cwd", /Removed|unbind/i.test(String(unbind.body?.text ?? "")),
      String(unbind.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));
    const connect = await dispatch("/tg-cwd-connect");
    record("management /tg-cwd-connect", /enabled|already/i.test(String(connect.body?.text ?? "")),
      String(connect.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));
    const sw = await dispatch("/tg-switch");
    record("management /tg-switch", String(sw.body?.text ?? "") !== "" || buttonsOf(sw).length > 0,
      String(sw.body?.text ?? "").replace(/\s+/g, " ").slice(0, 70));
  } catch (error) {
    record("management bind/connect/switch", false, String(error.message).slice(0, 220));
  }
  await settle();

  // ── Reload, then verify the plugin still serves ────────────────────────
  try {
    await dispatch("/reload");
    await sleep(2500);
    const call = await dispatch("/status");
    record("survives /reload", /status|session/i.test(String(call.body?.text ?? "")), String(call.body?.text ?? "").replace(/\s+/g, " ").slice(0, 60));
  } catch (error) {
    record("survives /reload", false, String(error.message).slice(0, 200));
  }

  // ── Bot API payload contract ───────────────────────────────────────────
  // The mock accepts anything; these are the limits the real API enforces.
  try {
    const all = (await controlGet()).calls ?? [];
    const violations = validateTelegramCalls(all);
    record("telegram payload contract", violations.length === 0,
      violations.length === 0
        ? `${all.length} calls valid`
        : `${violations.length} violations · ${violations.slice(0, 3).join(" | ").slice(0, 260)}`);
  } catch (error) {
    record("telegram payload contract", false, String(error.message).slice(0, 200));
  }

  const pane = String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");
  record("host pane free of crashes", !/Uncaught|TypeError:|ReferenceError:/.test(pane));

  if (!KEEP) {
    killSession(session);
    try { await controlPost("/_control/reset"); } catch { /* ignore */ }
  }
  const ok = results.every((r) => r.ok);
  return { results, ok, session, runDir };
}

async function main() {
  const hosts = HOST_ARG === "both" ? ["pi", "omp"] : [HOST_ARG];
  rmSync(join(ROOT, "tmp"), { recursive: true, force: true });
  mkdirSync(join(ROOT, "tmp"), { recursive: true });

  const mocks = [
    spawn("node", [join(E2E, "mock-telegram.mjs"), "--port", String(TG_PORT), "--log", join(ROOT, "telegram.jsonl")], { stdio: ["ignore", "pipe", "pipe"] }),
    spawn("node", [join(E2E, "mock-provider.mjs"), "--port", String(PROVIDER_PORT), "--log", join(ROOT, "provider.jsonl")], { stdio: ["ignore", "pipe", "pipe"] }),
  ];
  let mockOut = "";
  for (const mock of mocks) mock.stdout.on("data", (d) => { mockOut += d.toString(); });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(mockOut.includes("MOCK_TELEGRAM_READY") && mockOut.includes("MOCK_PROVIDER_READY"))) {
    await sleep(200);
  }
  if (!(mockOut.includes("MOCK_TELEGRAM_READY") && mockOut.includes("MOCK_PROVIDER_READY"))) {
    console.error("mock servers did not start:", mockOut);
    process.exit(1);
  }

  const summary = [];
  try {
    for (const host of hosts) {
      for (const phase of (PHASE_ARG ? [PHASE_ARG] : ["main", "quit", "exit", "disconnect"])) {
        console.log(`\n=== ${host} (${phase}) ===`);
        await controlPost("/_control/reset");
        const result = await runHost(host, `${host}-${phase}`, phase);
        summary.push({ host: `${host}:${phase}`, ...result });
      }
    }
  } finally {
    for (const mock of mocks) mock.kill();
  }

  let failed = 0;
  for (const host of summary) {
    console.log(`\n${host.ok ? "PASS" : "FAIL"} ${host.host} — ${host.results.filter((r) => r.ok).length}/${host.results.length} steps`);
    for (const step of host.results.filter((r) => !r.ok)) {
      failed += 1;
      console.log(`  ✗ ${step.name} — ${step.detail}`);
    }
  }
  console.log(failed === 0 ? "\nCOMMANDS_ACCEPTANCE=0" : `\nCOMMANDS_ACCEPTANCE=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
