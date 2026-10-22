#!/usr/bin/env node
/**
 * Mock OpenAI-compatible provider for isolated end-to-end acceptance runs.
 *
 * pi requires Server-Sent Events for streaming completions; a non-streaming JSON
 * response makes it abort with "Stream ended without finish_reason". Both paths are
 * implemented so the mock works regardless of whether `stream` is requested.
 *
 * Usage: node mock-provider.mjs [--port 9911] [--log /tmp/x/provider.jsonl] [--reply MOCK_OK]
 */
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : process.argv[index + 1];
}

const PORT = Number(argValue("--port", "9911"));
const LOG_PATH = argValue("--log", "/tmp/pitg-e2e/provider.jsonl");
const REPLY = argValue("--reply", "MOCK_OK");

mkdirSync(dirname(LOG_PATH), { recursive: true });
writeFileSync(LOG_PATH, "");

function record(entry) {
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch {
    // never break the mock over logging
  }
}

const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname.endsWith("/models")) {
    return res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        object: "list",
        data: [{ id: "mock-model", object: "model", owned_by: "mock" }],
      }),
    );
  }

  if (!url.pathname.includes("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "not found" } }));
  }

  const body = await readBody(req);
  let parsed = {};
  try {
    parsed = JSON.parse(body);
  } catch {
    // keep {}
  }
  // Surface the incoming prompt so the driver can prove the Telegram text reached the model.
  const promptText = (parsed.messages ?? [])
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    .join("\n");
  // pi's system prompt is small enough for `prompt`; OMP's is not, so record the
  // user-role text separately or assertions silently search a truncated string.
  const userText = (parsed.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
    .join("\n");
  const toolNames = (parsed.tools ?? [])
    .map((tool) => tool?.function?.name ?? tool?.name ?? "")
    .filter(Boolean);
  record({
    ts: Date.now(),
    direction: "in",
    model: parsed.model,
    prompt: promptText.slice(0, 4000),
    userText: userText.slice(0, 4000),
    tools: toolNames,
  });

  // Scripted tool call: a driver message containing ASK_TOOL_PROBE makes the
  // model invoke the host's `ask` tool (when advertised), so the interactive
  // prompt path — render in the TUI, answer through the mirror — is exercised
  // exactly as a real model would. The follow-up request carries a tool result
  // and falls through to the normal text reply.
  const hasToolResult = (parsed.messages ?? []).some((message) =>
    message?.role === "tool" || message?.role === "toolResult");
  const askTool = toolNames.find((name) => name === "ask");
  const triggerAsk = Boolean(askTool) && !hasToolResult && userText.includes("ASK_TOOL_PROBE")
    && !userText.includes("ASK_TOOL_PROBE_MULTI") && !userText.includes("ASK_TOOL_PROBE_CHECK");
  const askArguments = JSON.stringify({
    questions: [{
      id: "e2e-color",
      question: "Pick a color for the acceptance run",
      header: "E2E Ask",
      options: [{ label: "red" }, { label: "green" }, { label: "blue" }],
      recommended: 1,
    }],
  });

  // Multi-question / multi-select variant for the parity suite: the first
  // question is a checkbox group, the second a single choice, so the mirror
  // must toggle instead of submitting on the first pick.
  const triggerMultiAsk = Boolean(askTool) && !hasToolResult && userText.includes("ASK_TOOL_PROBE_MULTI");
  const triggerCheckAsk = Boolean(askTool) && !hasToolResult && userText.includes("ASK_TOOL_PROBE_CHECK");
  const checkAskArguments = JSON.stringify({
    questions: [{
      id: "e2e-toppings",
      question: "Pick toppings",
      header: "E2E Multi",
      multi: true,
      options: [{ label: "cheese" }, { label: "mushroom" }, { label: "olive" }],
    }],
  });
  const multiAskArguments = JSON.stringify({
    questions: [
      {
        id: "e2e-toppings",
        question: "Pick toppings",
        header: "E2E Multi",
        multi: true,
        options: [{ label: "cheese" }, { label: "mushroom" }, { label: "olive" }],
      },
      {
        id: "e2e-size",
        question: "Pick a size",
        header: "E2E Size",
        options: [{ label: "small" }, { label: "large" }],
      },
    ],
  });

  const askArgs = triggerCheckAsk ? checkAskArguments : (triggerMultiAsk ? multiAskArguments : askArguments);
  const triggerAnyAsk = triggerAsk || triggerMultiAsk || triggerCheckAsk;

  const wantsStream = parsed.stream === true;
  const id = "chatcmpl-e2e";
  const created = Math.floor(Date.now() / 1000);
  const base = { id, object: "chat.completion.chunk", created, model: parsed.model ?? "mock-model" };

  if (wantsStream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
    if (triggerAnyAsk) {
      res.write(chunk({
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_e2e_ask",
              type: "function",
              function: { name: askTool, arguments: askArgs },
            }],
          },
          finish_reason: null,
        }],
      }));
      res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    for (const word of REPLY.split(" ")) {
      res.write(chunk({ ...base, choices: [{ index: 0, delta: { content: `${word} ` }, finish_reason: null }] }));
    }
    res.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model: parsed.model ?? "mock-model",
      choices: [triggerAnyAsk
        ? {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_e2e_ask",
                type: "function",
                function: { name: askTool, arguments: askArgs },
              }],
            },
            finish_reason: "tool_calls",
          }
        : { index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    }),
  );
});

// Keep-alive must outlive the driver's idle gaps: a pooled socket closed server-side
// during a long `npm install` surfaces as `fetch failed` / `ECONNRESET` downstream.
server.keepAliveTimeout = 600_000;
server.headersTimeout = 610_000;

server.listen(PORT, "127.0.0.1", () => {
  console.log(`MOCK_PROVIDER_READY port=${PORT} log=${LOG_PATH}`);
});

server.on("error", (error) => {
  console.error(`MOCK_PROVIDER_ERROR ${error.code ?? ""} ${error.message}`);
});
