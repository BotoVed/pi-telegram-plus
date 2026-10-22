#!/usr/bin/env node
/**
 * Isolated tmux acceptance for the TUI bridge + Telegram shell commands.
 *
 * By default, installs every pi version recorded E2E-passed in
 * docs/compat-results.json, then runs OMP against the same mock Telegram Bot API
 * and mock OpenAI-compatible provider. Each run proves:
 *
 *   1. BotMenu includes commands discovered from the live host catalog.
 *   2. A local TUI command is mirrored to Telegram without opening a selector.
 *   3. Telegram `/settings` opens the real selector with `tgplus:tui:` controls.
 *   4. up/down/left/right/enter/esc/space/tab/refresh/close/type/cancel-type all
 *      traverse the real host input path and mirror their lifecycle.
 *   5. `!cmd` streams output and exit status; dangerous commands can be rejected.
 *   6. `!!cmd` reports nonzero exits and its output is absent from the next real
 *      provider request.
 *
 * Usage:
 *   node scripts/e2e/run-e2e-tui-bridge.mjs [--host pi|omp|both] [--keep]
 *     [--timeout 90] [--pi /path/to/pi] [--pi-versions 0.85.0,1.3.0]
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..", "..");
const PLUGIN_ENTRY = join(REPO, "index.ts");
const E2E = join(REPO, "scripts", "e2e");

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const HOST_ARG = argValue("--host", "both");
const KEEP = process.argv.includes("--keep");
const STEP_TIMEOUT_MS = Number(argValue("--timeout", "90")) * 1000;
const TG_PORT = Number(argValue("--tg-port", "9960"));
const PROVIDER_PORT = Number(argValue("--provider-port", "9961"));
const OMP_CLI = argValue("--omp", process.env.OMP_CLI || "omp");
const PI_CLI_ARG = argValue("--pi", process.env.PI_CLI);
const CUSTOM_PI_CLI = PI_CLI_ARG?.includes("/") ? resolve(REPO, PI_CLI_ARG) : PI_CLI_ARG;
const RECORDED_PI_E2E_VERSIONS = Object.keys(
  JSON.parse(readFileSync(join(REPO, "docs", "compat-results.json"), "utf8")).e2e?.versions ?? {},
);
const PI_VERSIONS = argValue("--pi-versions", RECORDED_PI_E2E_VERSIONS.join(","))
  .split(",")
  .map((version) => version.trim())
  .filter(Boolean);
const ROOT = process.env.PITG_E2E_BRIDGE_ROOT || "/tmp/pitg-e2e-bridge";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

function tmux(...args) {
  return sh("tmux", args);
}

function removeQuietly(path) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400 * (attempt + 1));
    }
  }
}

function resolvePiCli(prefixDir) {
  const packageDir = join(prefixDir, "node_modules", "@earendil-works", "pi-coding-agent");
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
  if (!bin) throw new Error(`pi package in ${prefixDir} has no bin.pi`);
  return join(packageDir, bin);
}

function installPi(version) {
  const prefixDir = join(ROOT, `pi-${version}`);
  removeQuietly(prefixDir);
  mkdirSync(prefixDir, { recursive: true });
  writeFileSync(join(prefixDir, "package.json"), JSON.stringify({
    name: `tui-bridge-pi-${version}`,
    private: true,
    version: "1.0.0",
  }, null, 2));
  const codemode = /^1\.[0-3]\.\d+$/.test(version)
    ? [`@earendil-works/pi-codemode@${version}`]
    : [];
  const result = sh("npm", [
    "install",
    "--no-save",
    "--no-audit",
    "--no-fund",
    `@earendil-works/pi-coding-agent@${version}`,
    ...codemode,
  ], {
    cwd: prefixDir,
    timeout: 300_000,
    env: {
      ...process.env,
      npm_config_cache: join(ROOT, "npm-cache"),
      npm_config_update_notifier: "false",
    },
  });
  if (result.status !== 0) {
    throw new Error(`install pi ${version} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return resolvePiCli(prefixDir);
}

function killSession(session) {
  tmux("pipe-pane", "-t", session);
  tmux("kill-session", "-t", session);
  tmux("kill-session", "-t", session);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const ls = tmux("ls");
    if (ls.status !== 0 || !String(ls.stdout ?? "").includes(session)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

async function controlRequest(path, init, attempts = 5) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(300 * attempt);
    try {
      const res = await fetch(`http://127.0.0.1:${TG_PORT}${path}`, {
        ...init,
        headers: { connection: "close", ...(init?.headers ?? {}) },
      });
      return await res.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`control request ${path} failed after ${attempts} attempts: ${lastError}`);
}

const controlPost = (path, body) => controlRequest(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body ?? {}),
});
const controlGet = (path) => controlRequest(path, { method: "GET" });

async function waitFor(label, predicate, { timeoutMs = STEP_TIMEOUT_MS, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await controlGet("/_control/log");
      const value = predicate(last);
      if (value) return value === true ? last : value;
    } catch (error) {
      last = { error: String(error) };
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for: ${label}\nlast state: ${JSON.stringify(last, null, 2).slice(0, 4000)}`);
}

async function waitForProvider(label, predicate, { timeoutMs = STEP_TIMEOUT_MS, intervalMs = 250 } = {}) {
  const logPath = join(ROOT, "provider.jsonl");
  const deadline = Date.now() + timeoutMs;
  let entries = [];
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      entries = readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const value = predicate(entries);
      if (value) return value === true ? entries : value;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for provider: ${label}\nlast entries: ${JSON.stringify(entries.slice(-2), null, 2)}`);
}

function startServer(name, script, args) {
  const proc = spawn("node", [join(E2E, script), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  proc.stdout.on("data", (d) => { buf += d.toString(); });
  proc.stderr.on("data", (d) => { buf += d.toString(); });
  return { proc, getOutput: () => buf };
}

function messages(state) {
  return state.calls.filter((call) => call.method === "sendMessage" || call.method === "editMessageText");
}

function seedEnvironment(host, runDir) {
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
      "providers:",
      "  mock:",
      `    baseUrl: http://127.0.0.1:${PROVIDER_PORT}/v1`,
      "    apiKey: mock",
      "    api: openai-completions",
      "    models:",
      "      - id: mock-model",
      "        name: Mock Model",
      "        contextWindow: 32768",
      "        maxTokens: 4096",
      "",
    ].join("\n"));
  }

  writeFileSync(join(agentDir, "tg.json"), JSON.stringify({
    version: 3,
    bots: [{
      id: `${host}-bot`,
      name: host,
      token: `${host === "pi" ? "333333" : "444444"}:TUI_BRIDGE_TOKEN`,
      allowedUserId: 42,
      apiBase: `http://127.0.0.1:${TG_PORT}`,
    }],
    defaultBotId: `${host}-bot`,
  }, null, 2) + "\n");

  writeFileSync(join(projectDir, ".pi", "telegram.json"), JSON.stringify({
    botId: `${host}-bot`,
    enabled: true,
    activeChatId: 42,
    tuiBridge: "full",
    bashConfirm: "dangerous",
  }, null, 2) + "\n");

  return { agentDir, projectDir };
}

function startHost(host, piCli, projectDir, agentDir, paneLog, session) {
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
    ? [OMP_CLI, "-e", PLUGIN_ENTRY, "--model", "mock/mock-model", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--approval-mode", "yolo", "--no-title"]
    : [piCli, "--no-skills", "--no-extensions", "-e", PLUGIN_ENTRY, "--provider", "mock", "--model", "mock-model"];
  // The tmux server's own cwd may be a deleted directory (harness cleanup),
  // which poisons every new pane's initial cwd; cd inside the command instead
  // of relying on -c alone.
  const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const command = `cd ${shq(projectDir)} && exec ${args.map(shq).join(" ")}`;
  const result = tmux(
    "new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", projectDir,
    ...envArgs, command,
  );
  if (result.status === 0) tmux("pipe-pane", "-t", session, `cat > ${paneLog}`);
  return result;
}

async function runHost(host, piCli, label) {
  const slug = label.replace(/[^a-zA-Z0-9_-]/g, "-");
  const session = `pitg-bridge-${slug}`;
  const runDir = join(ROOT, `run-${slug}`);
  const paneLog = join(runDir, "pane.log");
  removeQuietly(runDir);
  mkdirSync(runDir, { recursive: true });
  killSession(session);
  await controlPost("/_control/reset");

  const steps = [];
  const record = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const version = sh(host === "omp" ? OMP_CLI : piCli, ["--version"], { timeout: 30_000 });
  record(`resolve ${host} CLI`, version.status === 0, `${version.stdout ?? ""}${version.stderr ?? ""}`.trim());

  const { agentDir, projectDir } = seedEnvironment(host, runDir);
  const start = startHost(host, piCli, projectDir, agentDir, paneLog, session);
  if (start.status !== 0) {
    record(`start ${host} in tmux`, false, start.stderr?.trim());
    return { steps, ok: false };
  }
  record(`start ${host} in tmux`, true, session);

  let updateId = 7000;
  const injectMessage = (text, messageId) => controlPost("/_control/inject", {
    updates: [{
      update_id: updateId++,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "E2E" },
        text,
      },
    }],
  });
  const injectCallback = async (data, messageId) => {
    const callbackId = `cb-${updateId + 1}`;
    await controlPost("/_control/inject", {
      updates: [{
        update_id: updateId++,
        callback_query: {
          id: callbackId,
          from: { id: 42, is_bot: false, first_name: "E2E" },
          message: {
            message_id: messageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 42, type: "private" },
          },
          chat_instance: "e2e",
          data,
        },
      }],
    });
    return callbackId;
  };

  try {
    await waitFor("getMe", (state) => state.calls.some((call) => call.method === "getMe"));
    record("plugin authenticates via getMe", true);
  } catch (error) {
    record("plugin authenticates via getMe", false, String(error.message).slice(0, 400));
  }

  const dynamicCandidates = host === "omp"
    ? ["tools", "mcp", "agents", "permissions"]
    : ["trust", "init", "help", "commands", "clear", "cost"];
  try {
    const call = await waitFor("setMyCommands with dynamic host catalog", (value) =>
      value.calls.findLast((entry) =>
        entry.method === "setMyCommands"
        && Array.isArray(entry.body?.commands)
        && entry.body.commands.some((command) => dynamicCandidates.includes(command.command))) ?? false);
    const names = call.body.commands.map((command) => command.command);
    const discovered = dynamicCandidates.filter((command) => names.includes(command));
    record(
      "BotMenu merges the host command catalog",
      discovered.length > 0 && names.length <= 100,
      `${discovered.slice(0, 4).join(", ")} · ${names.length} commands`,
    );
  } catch (error) {
    record("BotMenu merges the host command catalog", false, String(error.message).slice(0, 400));
  }

  // ── Local TUI → Telegram mirror ────────────────────────────────────────
  try {
    await sleep(800);
    const typed = tmux("send-keys", "-t", session, "-l", "!true");
    if (typed.status !== 0) throw new Error(typed.stderr || "send-keys failed");
    tmux("send-keys", "-t", session, "Enter");
    await waitFor("local command mirrored to Telegram", (state) => messages(state)
      .some((call) => String(call.body?.text ?? "").includes("TUI command")
        && String(call.body?.text ?? "").includes("!true")));
    record("local TUI command is mirrored to Telegram", true);
  } catch (error) {
    record("local TUI command is mirrored to Telegram", false, String(error.message).slice(0, 400));
  }

  // ── Telegram /settings → interactive TUI selector ──────────────────────
  let mirrorMessageId;
  try {
    await sleep(500);
    await injectMessage("/settings", 7201);
    const found = await waitFor("interactive TUI selector mirror", (state) => {
      const call = messages(state).find((entry) => {
        const rows = entry.body?.reply_markup?.inline_keyboard;
        return Array.isArray(rows)
          && rows.flat().some((button) => String(button.callback_data ?? "").startsWith("tgplus:tui:"));
      });
      return call ?? false;
    });
    mirrorMessageId = found.body?.message_id ?? found.message_id;
    if (typeof mirrorMessageId !== "number") throw new Error("mirror message has no id");
    const rows = found.body.reply_markup.inline_keyboard;
    record("Telegram command opens a remotely controllable TUI selector", true, `${rows.flat().length} buttons`);
  } catch (error) {
    record("Telegram command opens a remotely controllable TUI selector", false, String(error.message).slice(0, 400));
  }

  try {
    if (mirrorMessageId === undefined) throw new Error("no mirror message");
    const exerciseCallback = async (action) => {
      const before = await controlGet("/_control/log");
      const editsBefore = before.calls.filter((call) =>
        call.method === "editMessageText" && call.body?.message_id === mirrorMessageId).length;
      const callbackId = await injectCallback(`tgplus:tui:${action}`, mirrorMessageId);
      await waitFor(`${action} callback reaches selector`, (state) => {
        const answered = state.calls.some((call) =>
          call.method === "answerCallbackQuery" && call.body?.callback_query_id === callbackId);
        const edits = state.calls.filter((call) =>
          call.method === "editMessageText" && call.body?.message_id === mirrorMessageId).length;
        return answered && edits > editsBefore;
      });
    };

    for (const action of ["up", "down", "left", "right", "space", "tab", "refresh"]) {
      await exerciseCallback(action);
    }
    await exerciseCallback("type");
    await exerciseCallback("cancel-type");
    await exerciseCallback("type");
    const beforeText = await controlGet("/_control/log");
    const textEditsBefore = beforeText.calls.filter((call) =>
      call.method === "editMessageText" && call.body?.message_id === mirrorMessageId).length;
    await injectMessage("theme", 7202);
    await waitFor("typed selector text is mirrored", (state) =>
      state.calls.filter((call) =>
        call.method === "editMessageText" && call.body?.message_id === mirrorMessageId).length > textEditsBefore);
    await exerciseCallback("enter");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await exerciseCallback("esc");
      const state = await controlGet("/_control/log");
      if (state.calls.some((call) =>
        call.method === "editMessageReplyMarkup" && call.body?.message_id === mirrorMessageId)) break;
    }
    await waitFor("Esc callback releases the selector", (state) => state.calls.some((call) =>
      call.method === "editMessageReplyMarkup" && call.body?.message_id === mirrorMessageId));
    record("all TUI key/type/refresh callbacks reach the selector", true);
  } catch (error) {
    record("all TUI key/type/refresh callbacks reach the selector", false, String(error.message).slice(0, 400));
  }

  try {
    const before = await controlGet("/_control/log");
    const callOffset = before.calls.length;
    await injectMessage("/settings", 7203);
    const reopened = await waitFor("selector reopened for close callback", (state) => {
      const call = state.calls.slice(callOffset).find((entry) => {
        const rows = entry.body?.reply_markup?.inline_keyboard;
        return entry.method === "editMessageText"
          && Array.isArray(rows)
          && rows.flat().some((button) => button.callback_data === "tgplus:tui:close");
      });
      return call ?? false;
    });
    const reopenedMessageId = reopened.body?.message_id ?? reopened.message_id;
    const callbackId = await injectCallback("tgplus:tui:close", reopenedMessageId);
    await waitFor("close callback removes mirror", (state) =>
      state.calls.some((call) =>
        call.method === "answerCallbackQuery" && call.body?.callback_query_id === callbackId)
      && state.calls.some((call) =>
        call.method === "editMessageText"
        && call.body?.message_id === reopenedMessageId
        && String(call.body?.text ?? "").includes("TUI mirror closed")));
    record("TUI close callback closes the mirror", true);
  } catch (error) {
    record("TUI close callback closes the mirror", false, String(error.message).slice(0, 400));
  }

  // ── Telegram !bash ─────────────────────────────────────────────────────
  try {
    await injectMessage("!printf PTP_BASH_OK", 7210);
    await waitFor("!bash streams output + exit status", (state) => messages(state)
      .some((call) => String(call.body?.text ?? "").includes("PTP_BASH_OK")
        && String(call.body?.text ?? "").includes("exit: 0")));
    record("Telegram !bash runs and reports exit 0", true);
  } catch (error) {
    record("Telegram !bash runs and reports exit 0", false, String(error.message).slice(0, 400));
  }

  try {
    await injectMessage("!!false", 7211);
    await waitFor("!!bash reports nonzero exit", (state) => messages(state)
      .some((call) => String(call.body?.text ?? "").includes("$ false")
        && String(call.body?.text ?? "").includes("exit: 1")));
    record("Telegram !!bash reports exit 1", true);
  } catch (error) {
    record("Telegram !!bash reports exit 1", false, String(error.message).slice(0, 400));
  }

  try {
    const before = await controlGet("/_control/log");
    const callOffset = before.calls.length;
    await injectMessage("!rm -rf /tmp/PTP_E2E_CONFIRM_SENTINEL", 7212);
    const prompt = await waitFor("dangerous bash confirmation buttons", (state) =>
      messages({ calls: state.calls.slice(callOffset) }).find((call) =>
        String(call.body?.text ?? "").includes("Run shell command")
        && Array.isArray(call.body?.reply_markup?.inline_keyboard)) ?? false);
    const promptMessageId = prompt.body?.message_id ?? prompt.message_id;
    const buttons = prompt.body.reply_markup.inline_keyboard.flat();
    const reject = buttons.find((button) => /no|cancel|reject/i.test(button.text));
    if (!reject?.callback_data) throw new Error("dangerous bash prompt has no reject callback");
    await injectCallback(reject.callback_data, promptMessageId);
    await waitFor("dangerous bash rejection", (state) => messages(state)
      .some((call) => String(call.body?.text ?? "").includes("Shell command cancelled")));
    record("dangerous bash confirmation can reject execution", true);
  } catch (error) {
    record("dangerous bash confirmation can reject execution", false, String(error.message).slice(0, 400));
  }

  try {
    const secret = `PTP_EXCLUDED_${slug}`;
    const probe = `PTP_CONTEXT_PROBE_${slug}`;
    await injectMessage(`!!printf ${secret}`, 7213);
    await waitFor("excluded bash completes", (state) => messages(state)
      .some((call) => String(call.body?.text ?? "").includes(secret)
        && String(call.body?.text ?? "").includes("exit: 0")));
    await injectMessage(probe, 7214);
    const request = await waitForProvider("probe after excluded bash", (entries) =>
      entries.findLast((entry) => String(entry.userText ?? "").includes(probe)) ?? false);
    if (String(request.userText ?? "").includes(secret) || String(request.prompt ?? "").includes(secret)) {
      throw new Error("!!bash output leaked into provider context");
    }
    record("Telegram !!bash output is excluded from provider context", true);
  } catch (error) {
    record("Telegram !!bash output is excluded from provider context", false, String(error.message).slice(0, 400));
  }

  // ── /login capability routing ──────────────────────────────────────────
  const loginStep = host === "omp"
    ? "OMP /login routes to the host TUI login dialog"
    : "pi /login opens the native Telegram auth menu";
  try {
    const before = await controlGet("/_control/log");
    const callOffset = before.calls.length;
    await injectMessage("/login", 7220);
    if (host === "omp") {
      await waitFor("TUI command notice for /login", (state) =>
        state.calls.slice(callOffset).some((call) =>
          String(call.body?.text ?? "").includes("TUI command")
          && String(call.body?.text ?? "").includes("/login")));
      await sleep(900);
      const pane = tmux("capture-pane", "-p", "-t", session);
      const paneText = String(pane.stdout ?? "");
      const hit = paneText.split("\n").find((line) => /login|oauth|auth|provider|credential/i.test(line));
      if (!hit) throw new Error(`host pane shows no login UI: ${paneText.slice(-200)}`);
      const loginMirror = await waitFor("login mirror keyboard", (state) =>
        messages({ calls: state.calls.slice(callOffset) }).find((call) =>
          Array.isArray(call.body?.reply_markup?.inline_keyboard)
          && call.body.reply_markup.inline_keyboard.flat()
            .some((button) => String(button.callback_data ?? "").startsWith("tgplus:tui:"))) ?? false);
      const loginMirrorMessageId = loginMirror.body?.message_id ?? loginMirror.message_id;
      const loginRows = loginMirror.body.reply_markup.inline_keyboard;
      const loginButtons = loginRows.flat();
      // Selector keyboards carry per-item pick buttons; prefer clicking a
      // non-selected item (proves the pick path), else fall back to arrows.
      const probeButton = loginButtons.find((button) =>
        String(button.callback_data ?? "").startsWith("tgplus:tui:pick:")
        && !String(button.text ?? "").startsWith("▸"));
      const probeData = probeButton ? String(probeButton.callback_data) : "tgplus:tui:down";
      const callbackId = await injectCallback(probeData, loginMirrorMessageId);
      await waitFor("probe callback answered on login mirror", (state) =>
        state.calls.some((call) =>
          call.method === "answerCallbackQuery" && call.body?.callback_query_id === callbackId));
      const paneAfter = String(tmux("capture-pane", "-p", "-t", session).stdout ?? "");
      if (paneAfter === paneText) {
        throw new Error(`login dialog did not react to ${probeData}`);
      }
      record(loginStep, true,
        `${loginButtons.length} buttons + ${probeButton ? "pick" : "down"} callback routed`);
    } else {
      await waitFor("native Telegram auth menu", (state) => {
        const call = state.calls.slice(callOffset).find((entry) => {
          const rows = entry.body?.reply_markup?.inline_keyboard;
          return Array.isArray(rows)
            && rows.flat().some((button) => String(button.callback_data ?? "").startsWith("tgplus:ui:"));
        });
        return call ?? false;
      });
      record(loginStep, true);
    }
  } catch (error) {
    record(loginStep, false, String(error.message).slice(0, 400));
  }

  killSession(session);
  const failed = steps.filter((step) => !step.ok);
  if (failed.length > 0 && existsSync(paneLog)) {
    console.log(`\n--- ${label} tmux pane (last 30 lines) ---`);
    console.log(readFileSync(paneLog, "utf8").split("\n").slice(-30).join("\n"));
  }
  return { steps, ok: failed.length === 0, paneLog };
}

async function main() {
  mkdirSync(ROOT, { recursive: true });
  if (!["pi", "omp", "both"].includes(HOST_ARG)) {
    throw new Error(`invalid --host ${HOST_ARG}; expected pi, omp, or both`);
  }

  // A leftover run (zombie script or foreign mock) holding these ports would
  // silently steal the injected updates; fail fast with a named cause instead.
  for (const [label, port] of [["telegram mock", TG_PORT], ["provider mock", PROVIDER_PORT]]) {
    await new Promise((resolveReady, rejectBusy) => {
      const probe = createServer();
      probe.once("error", (error) => rejectBusy(new Error(
        `${label} port ${port} is already in use (${error.code}); another e2e run is likely alive — kill it or pass --tg-port/--provider-port`,
      )));
      probe.listen(port, "127.0.0.1", () => probe.close(resolveReady));
    });
  }
  const runs = [];
  if (HOST_ARG === "pi" || HOST_ARG === "both") {
    if (CUSTOM_PI_CLI) {
      runs.push({ host: "pi", label: "pi", piCli: CUSTOM_PI_CLI });
    } else {
      for (const version of PI_VERSIONS) {
        console.log(`installing isolated pi ${version}...`);
        runs.push({ host: "pi", label: `pi@${version}`, piCli: installPi(version) });
      }
    }
  }
  if (HOST_ARG === "omp" || HOST_ARG === "both") {
    runs.push({ host: "omp", label: "omp", piCli: undefined });
  }

  const tg = startServer("mock-telegram", "mock-telegram.mjs", [
    "--port", String(TG_PORT), "--log", join(ROOT, "telegram.jsonl"),
  ]);
  const provider = startServer("mock-provider", "mock-provider.mjs", [
    "--port", String(PROVIDER_PORT), "--log", join(ROOT, "provider.jsonl"),
  ]);
  await sleep(1200);
  if (!tg.getOutput().includes("MOCK_TELEGRAM_READY")) throw new Error(`mock telegram failed:\n${tg.getOutput()}`);
  if (!provider.getOutput().includes("MOCK_PROVIDER_READY")) throw new Error(`mock provider failed:\n${provider.getOutput()}`);
  console.log("mocks ready: telegram + provider\n");

  const results = [];
  try {
    for (const run of runs) {
      console.log(`=== ${run.label} ===`);
      results.push({ host: run.label, ...await runHost(run.host, run.piCli, run.label) });
      console.log("");
    }
  } finally {
    tg.proc.kill();
    provider.proc.kill();
  }

  writeFileSync(join(ROOT, "e2e-tui-bridge-report.json"), JSON.stringify(results, null, 2) + "\n");
  const failed = results.filter((result) => !result.ok);
  for (const result of results) console.log(`${result.ok ? "✓" : "✗"} ${result.host}`);
  if (failed.length > 0) {
    console.log(`\n${failed.length}/${results.length} host run(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log(`\nTUI_BRIDGE_EXIT=0 (${results.length}/${results.length} host runs passed)`);
  }
  if (!KEEP) removeQuietly(ROOT);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
