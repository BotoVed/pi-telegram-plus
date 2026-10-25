#!/usr/bin/env node
/**
 * State-equivalence suite (plan §7.2): prove that operating from Telegram and
 * operating in the terminal drive the host to the SAME state, not merely that
 * Telegram got a reply.
 *
 * Each case runs twice against a freshly seeded, isolated pi host:
 *   A - driven with tmux keystrokes (what a terminal user types),
 *   B - driven through the mock Bot API (injected messages + button taps).
 * The runs are sequential (never two hosts against one mock Telegram). After
 * each side, the host state is read back from disk (session .jsonl,
 * settings.json) and the two snapshots are deep-compared.
 *
 * Usage: node scripts/e2e/run-e2e-state.mjs [--keep] [--self-test]
 *   --keep       leave the run directories under ROOT in place
 *   --self-test  run B of the /settings case WITHOUT tapping the toggle
 *                button; that case MUST then be judged ✗ (proves the
 *                comparison actually detects divergence).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const PLUGIN = join(REPO, "index.ts");
const E2E = join(REPO, "scripts", "e2e");
const ROOT = process.env.PITG_E2E_STATE_ROOT ?? "/tmp/pitg-e2e-state";
const TG_PORT = Number(process.env.PITG_E2E_STATE_TG_PORT ?? 9700);
const PROVIDER_PORT = Number(process.env.PITG_E2E_STATE_PROVIDER_PORT ?? 9701);
const PI_CLI = resolve(REPO, "node_modules/.bin/pi");
const KEEP = process.argv.includes("--keep");
const SELF_TEST = process.argv.includes("--self-test");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const tmux = (...args) => sh("tmux", args);
const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const rowsOf = (call) => call?.body?.reply_markup?.inline_keyboard;
const buttonsOf = (call) => (rowsOf(call) ?? []).flat();

async function control(path, init) {
  const res = await fetch(`http://127.0.0.1:${TG_PORT}${path}`, { ...init, headers: { connection: "close", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
const controlGet = () => control("/_control/log");
const controlPost = (path, body) => control(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

async function waitFor(label, predicate, { timeoutMs = 25_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = predicate(await controlGet());
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
}

function killSession(session) {
  tmux("pipe-pane", "-t", session);
  for (let attempt = 0; attempt < 3; attempt += 1) tmux("kill-session", "-t", session);
}

/** Fresh pi agent dir: mock provider with TWO models (so /model has a target), mock bot, isolated project. */
function seed(runDir) {
  const agentDir = join(runDir, "agent");
  const projectDir = join(runDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  // clearDialog() sends Escape twice; with an empty editor pi would open the Session Tree.
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ doubleEscapeAction: "none" })}\n`);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { mock: { baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`, api: "openai-completions", apiKey: "mock", models: [{ id: "mock-model" }, { id: "mock-model-2" }] } },
  }, null, 2) + "\n");
  writeFileSync(join(agentDir, "tg.json"), JSON.stringify({
    version: 3,
    bots: [{ id: "pi-bot", name: "pi", token: "333333:STATE_TOKEN", allowedUserId: 42, apiBase: `http://127.0.0.1:${TG_PORT}` }],
    defaultBotId: "pi-bot",
  }, null, 2) + "\n");
  writeFileSync(join(projectDir, ".pi", "telegram.json"), JSON.stringify({
    botId: "pi-bot", enabled: true, activeChatId: 42, tuiBridge: "full", bashConfirm: "dangerous",
  }, null, 2) + "\n");
  return { agentDir, projectDir };
}

function startHost(projectDir, agentDir, session) {
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
  const args = [PI_CLI, "--no-skills", "--no-extensions", "-e", PLUGIN, "--provider", "mock", "--model", "mock-model"];
  const command = `cd ${shq(projectDir)} && exec ${args.map(shq).join(" ")}`;
  return tmux("new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", projectDir, ...envArgs, command);
}

const paneText = (session) => String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");

async function bootPi(tag) {
  const session = `pitg-state-${tag}`;
  const runDir = join(ROOT, `run-${tag}`);
  rmSync(runDir, { recursive: true, force: true, maxRetries: 3 });
  mkdirSync(runDir, { recursive: true });
  killSession(session);
  await controlPost("/_control/reset");
  const { agentDir, projectDir } = seed(runDir);
  const start = startHost(projectDir, agentDir, session);
  if (start.status !== 0) throw new Error(`start pi: ${start.stderr}`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await controlGet();
    if (state.calls.some((c) => c.method === "getMe" && c.token?.includes("STATE"))) return { session, runDir, agentDir };
    await sleep(300);
  }
  throw new Error("timeout waiting for pi auth");
}

// ── host state read back from disk ───────────────────────────────────────

function listJsonl(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listJsonl(path, out);
    else if (entry.name.endsWith(".jsonl")) out.push(path);
  }
  return out;
}

function latestSessionFile(agentDir) {
  const files = listJsonl(join(agentDir, "sessions"));
  if (files.length === 0) return undefined;
  return files.reduce((best, path) => (statSync(path).mtimeMs >= statSync(best).mtimeMs ? path : best));
}

function sessionEntries(agentDir) {
  const file = latestSessionFile(agentDir);
  if (!file) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return {}; } });
}

/** Auto-compact persists as `compaction.enabled` in settings.json (default true). */
function readAutoCompact(agentDir) {
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    return settings.compaction?.enabled ?? true;
  } catch {
    return true;
  }
}

async function pollSessionEntries(agentDir, label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = sessionEntries(agentDir);
    const hit = predicate(entries);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${label}; last entries: ${entries.slice(-3).map((e) => e.type).join(",") || "(none)"}`);
    }
    await sleep(300);
  }
}

async function pollUntil(label, read, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate(read())) return true;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label} (value=${JSON.stringify(read())})`);
    await sleep(300);
  }
}

async function waitPane(session, label, regex, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pane = paneText(session);
    if (regex.test(pane)) return pane;
    if (Date.now() > deadline) {
      const tail = pane.split("\n").map((l) => l.trim()).filter((l) => l && !/^[-─━\s|]+$/.test(l)).slice(-12).join(" | ").slice(0, 400);
      throw new Error(`timeout waiting for ${label}; pane tail: ${tail}`);
    }
    await sleep(250);
  }
}

// ── side contexts ────────────────────────────────────────────────────────

function terminalCtx(session, agentDir) {
  const type = (text) => {
    const res = tmux("send-keys", "-t", session, "-l", text);
    if (res.status !== 0) throw new Error(`send-keys failed: ${res.stderr}`);
  };
  const key = (name) => tmux("send-keys", "-t", session, name);
  return {
    session,
    type,
    key,
    pane: () => paneText(session),
    waitPane: (label, regex, timeoutMs) => waitPane(session, label, regex, timeoutMs),
    pollEntries: (label, predicate, timeoutMs) => pollSessionEntries(agentDir, label, predicate, timeoutMs),
    pollSettings: (label, timeoutMs) => pollUntil(label, () => readAutoCompact(agentDir), (value) => value === false, timeoutMs),
    warmup: async () => {
      type("warmup");
      key("Enter");
      await waitPane(session, "warmup reply", /MOCK_OK/, 60_000);
    },
  };
}

let updateId = 50000;
let telegramMessageId = 60000;

const injectMessage = (text) => controlPost("/_control/inject", {
  updates: [{
    update_id: updateId++,
    message: {
      message_id: telegramMessageId++, date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false, first_name: "E2E" }, text,
    },
  }],
});

function telegramCtx(agentDir) {
  const cursor = async () => (await controlGet()).calls.length;
  const keyboardWith = async (label, regex, since, timeoutMs = 25_000) => waitFor(`keyboard: ${label}`, (state) =>
    state.calls.slice(since).findLast((entry) =>
      Array.isArray(rowsOf(entry)) && buttonsOf(entry).some((b) => regex.test(String(b.text ?? "")))) ?? false,
  { timeoutMs });
  const click = async (keyboardCall, regex) => {
    const button = buttonsOf(keyboardCall).find((b) => regex.test(String(b.text ?? "")));
    if (!button) throw new Error(`no button matching ${regex} in [${buttonsOf(keyboardCall).map((b) => b.text).join(" | ")}]`);
    const targetMessageId = keyboardCall.message_id ?? keyboardCall.body?.message_id;
    const callbackId = `cb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const since = await cursor();
    await controlPost("/_control/inject", {
      updates: [{
        update_id: updateId++,
        callback_query: {
          id: callbackId,
          from: { id: 42, is_bot: false, first_name: "E2E" },
          message: { message_id: targetMessageId, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: "private" } },
          chat_instance: "state",
          data: String(button.callback_data),
        },
      }],
    });
    const answered = await waitFor(`callback answered: ${button.text}`, (state) =>
      state.calls.some((c) => c.method === "answerCallbackQuery" && c.body?.callback_query_id === callbackId),
    { timeoutMs: 15_000 }).then(() => true).catch(() => false);
    // The follow-up for this click: an edit of the same message, or a fresh send.
    await waitFor(`follow-up after ${button.text}`, (state) =>
      state.calls.slice(since).findLast((entry) =>
        (entry.method === "sendMessage" || entry.method === "editMessageText")
        && (entry.body?.message_id === targetMessageId || entry.method === "sendMessage")) ?? false,
    { timeoutMs: answered ? 20_000 : 3_000 }).catch(() => undefined);
    if (!answered) throw new Error(`callback not answered: ${button.text}`);
  };
  return {
    selfTest: SELF_TEST,
    cursor,
    send: (text) => injectMessage(text),
    warmup: async () => {
      const since = await cursor();
      await injectMessage("warmup");
      await waitFor("warmup reply", (state) =>
        state.calls.slice(since).find((entry) =>
          ["sendMessage", "editMessageText"].includes(entry.method)
          && /MOCK_OK/.test(String(entry.body?.text ?? ""))) ?? false,
      { timeoutMs: 60_000 });
    },
    keyboardWith,
    click,
    pollEntries: (label, predicate, timeoutMs) => pollSessionEntries(agentDir, label, predicate, timeoutMs),
  };
}

// ── cases ────────────────────────────────────────────────────────────────

const lastEntry = (entries, type) => entries.findLast((entry) => entry.type === type);

const CASES = [
  {
    name: "/name state-probe",
    slug: "name",
    async terminal(t) {
      await t.warmup();
      t.type("/name state-probe");
      t.key("Enter");
      await t.pollEntries("session_info name", (entries) =>
        lastEntry(entries, "session_info")?.name === "state-probe" ? true : false);
    },
    async telegram(g) {
      await g.warmup();
      await g.send("/name state-probe");
      await g.pollEntries("session_info name", (entries) =>
        lastEntry(entries, "session_info")?.name === "state-probe" ? true : false);
    },
    snapshot: (agentDir) => ({ sessionName: lastEntry(sessionEntries(agentDir), "session_info")?.name ?? null }),
  },
  {
    name: "/model -> mock-model-2",
    slug: "model",
    async terminal(t) {
      await t.warmup();
      t.type("/model");
      t.key("Enter");
      // The selector lists rows as `mock-model-2 [mock]`; type-ahead filters, Enter takes the first hit.
      await t.waitPane("model selector", /mock-model-2 \[mock\]/, 20_000);
      t.type("mock-model-2");
      await sleep(600);
      t.key("Enter");
      await t.pollEntries("model_change mock/mock-model-2", (entries) => {
        const entry = lastEntry(entries, "model_change");
        return entry && entry.provider === "mock" && entry.modelId === "mock-model-2" ? true : false;
      });
    },
    async telegram(g) {
      await g.warmup();
      const since = await g.cursor();
      await g.send("/model");
      const keyboard = await g.keyboardWith("Select model", /mock\/mock-model-2/, since);
      await g.click(keyboard, /mock\/mock-model-2/);
      await g.pollEntries("model_change mock/mock-model-2", (entries) => {
        const entry = lastEntry(entries, "model_change");
        return entry && entry.provider === "mock" && entry.modelId === "mock-model-2" ? true : false;
      });
    },
    snapshot: (agentDir) => {
      const entry = lastEntry(sessionEntries(agentDir), "model_change");
      return { model: entry ? `${entry.provider}/${entry.modelId}` : null };
    },
  },
  {
    name: "/settings Auto-compact toggle",
    slug: "settings",
    async terminal(t) {
      await t.warmup();
      t.type("/settings");
      t.key("Enter");
      await t.waitPane("settings dialog", /Auto-compact/, 20_000);
      // Cursor starts on row 1 (Auto-compact); Enter cycles its value once.
      t.key("Enter");
      await t.pollSettings("compaction.enabled=false persisted", 10_000);
      t.key("Escape");
    },
    async telegram(g) {
      await g.warmup();
      const since = await g.cursor();
      await g.send("/settings");
      const keyboard = await g.keyboardWith("Settings dialog", /Auto-compact/, since);
      if (!g.selfTest) {
        await g.click(keyboard, /○\s*Auto-compact:\s*false/);
      }
      const updated = await g.keyboardWith("Cancel button", /Cancel/, since);
      await g.click(updated, /Cancel/);
      await sleep(1000);
    },
    snapshot: (agentDir) => ({ autoCompact: readAutoCompact(agentDir) }),
  },
];

// ── runner ───────────────────────────────────────────────────────────────

async function runSide(caseDef, side) {
  const tag = `${caseDef.slug}-${side}`;
  let session;
  try {
    const booted = await bootPi(tag);
    session = booted.session;
    if (side === "A") await caseDef.terminal(terminalCtx(booted.session, booted.agentDir));
    else await caseDef.telegram(telegramCtx(booted.agentDir));
    await sleep(500);
    return { snapshot: caseDef.snapshot(booted.agentDir) };
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 200) };
  } finally {
    if (session) killSession(session);
  }
}

async function main() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const mocks = [
    spawn("node", [join(E2E, "mock-telegram.mjs"), "--port", String(TG_PORT), "--log", join(ROOT, "telegram.jsonl")], { stdio: "ignore" }),
    spawn("node", [join(E2E, "mock-provider.mjs"), "--port", String(PROVIDER_PORT), "--log", join(ROOT, "provider.jsonl")], { stdio: "ignore" }),
  ];
  await sleep(1500);

  const results = [];
  try {
    for (const caseDef of CASES) {
      const a = await runSide(caseDef, "A");
      const b = await runSide(caseDef, "B");
      const render = (side) => (side.error ? `ERR ${side.error}` : JSON.stringify(side.snapshot));
      const ok = !a.error && !b.error && JSON.stringify(a.snapshot) === JSON.stringify(b.snapshot);
      results.push({ slug: caseDef.slug, ok });
      console.log(`${ok ? "✓" : "✗"} ${caseDef.name} — A=${render(a)} B=${render(b)}`);
    }
  } finally {
    for (const mock of mocks) mock.kill();
    if (!KEEP) {
      await sleep(300);
      rmSync(ROOT, { recursive: true, force: true });
    }
  }

  const failures = results.filter((r) => !r.ok).length;
  console.log(`STATE_ACCEPTANCE=${failures}`);
  if (SELF_TEST) {
    const settings = results.find((r) => r.slug === "settings");
    const others = results.filter((r) => r.slug !== "settings");
    const pass = Boolean(settings) && !settings.ok && others.length > 0 && others.every((r) => r.ok);
    console.log(`SELF_TEST=${pass ? "PASS" : "FAIL"} (settings must be the only ✗)`);
    process.exitCode = pass ? 0 : 1;
  } else {
    process.exitCode = failures > 0 ? 1 : 0;
  }
}

await main();
