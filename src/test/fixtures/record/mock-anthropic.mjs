// A scripted Anthropic Messages API for recording real Claude Code transcripts.
// Stateless: which step to answer is read off the request itself — the latest
// SCENARIO marker in a user message picks the script, and the number of
// assistant turns after that message picks the step.
import { createServer } from "node:http";
import { readFileSync, appendFileSync } from "node:fs";

const port = Number(process.env.PORT ?? 4555);
const scriptPath = process.env.SCRIPT;
const logPath = process.env.MOCK_LOG ?? "mock.log";
let scripts = {};
const load = () => { scripts = JSON.parse(readFileSync(scriptPath, "utf8")); };
load();

let seq = 0;
const id = (p) => `${p}_${String(++seq).padStart(4, "0")}mock${Date.now().toString(36)}`;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? JSON.stringify(b.content) : "")).join("\n");
}

function pick(body) {
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  const lastText = last ? textOf(last.content) : "";
  if (/<summary> block/.test(lastText) || /<summary>/.test(textOf(body.system ?? "")) && !body.tools?.length) {
    return { kind: "compact" };
  }
  let key, at = -1;
  messages.forEach((m, i) => {
    if (m.role !== "user") return;
    const found = [...textOf(m.content).matchAll(/SCENARIO-([A-Z0-9-]+)/g)];
    if (found.length > 0) { key = found.at(-1)[1]; at = i; }
  });
  if (!key) return { kind: "side" };
  const step = messages.slice(at + 1).filter((m) => m.role === "assistant").length;
  return { kind: "script", key, step };
}

function blocksFor(choice) {
  if (choice.kind === "compact") {
    return { blocks: [{ type: "text", text: "<analysis>The user asked to fix add() and the subagent fixed it.</analysis>\n<summary>1. Primary Request: fix add() in src/app.js so the test passes.\n2. Work done: a subagent read src/app.js, changed `a - b` to `a + b`, and ran node --test, which passed.\n3. Pending: none.</summary>" }], stop: "end_turn" };
  }
  if (choice.kind === "side") {
    return { blocks: [{ type: "text", text: "{\"title\": \"Fix add\", \"isNewTopic\": false}" }], stop: "end_turn" };
  }
  const script = scripts[choice.key];
  const step = script?.[choice.step];
  if (!step) return { blocks: [{ type: "text", text: "Done." }], stop: "end_turn" };
  const blocks = step.map((b) => (b.type === "tool_use" ? { ...b, id: b.id ?? id("toolu") } : b));
  return { blocks, stop: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const url = req.url ?? "";
    if (!url.startsWith("/v1/messages")) {
      appendFileSync(logPath, `${req.method} ${url} -> 404\n`);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "mock" } }));
      return;
    }
    if (url.startsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 1000 }));
      return;
    }
    load();
    const choice = pick(body);
    const { blocks, stop } = blocksFor(choice);
    appendFileSync(logPath, `${req.method} ${url} model=${body.model} stream=${body.stream} tools=${body.tools?.length ?? 0} msgs=${body.messages?.length} -> ${JSON.stringify(choice)}\n`);
    const model = body.model ?? "claude-opus-5-5";
    const usage = { input_tokens: Number(process.env.MOCK_INPUT_TOKENS ?? 1200), output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json", "request-id": id("req") });
      res.end(JSON.stringify({ id: id("msg"), type: "message", role: "assistant", model, content: blocks, stop_reason: stop, stop_sequence: null, usage }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": id("req") });
    sse(res, "message_start", { type: "message_start", message: { id: id("msg"), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
    blocks.forEach((block, index) => {
      if (block.type === "thinking") {
        sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
        if (block.thinking) sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
        sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature ?? "EqMockSignatureOnlyAVeryLongOpaqueBlobStandsHereInRealTranscripts==" } });
      } else if (block.type === "redacted_thinking") {
        sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "redacted_thinking", data: block.data ?? "EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpPkNRj2YfWXGmKDxH4mPnZ5sQ7vB5URj2pSmbnn8rBgmN1cq4gKg==" } });
      } else if (block.type === "text") {
        sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
        sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      } else if (block.type === "tool_use") {
        sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
        sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      }
      sse(res, "content_block_stop", { type: "content_block_stop", index });
    });
    sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 80 } });
    sse(res, "message_stop", { type: "message_stop" });
    res.end();
  });
}).listen(port, "127.0.0.1", () => console.log(`mock anthropic on ${port}`));
