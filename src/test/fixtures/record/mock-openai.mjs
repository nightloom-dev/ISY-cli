// A scripted OpenAI-compatible chat completions API, for recording real Kimi
// CLI sessions. Stateless, like mock-anthropic.mjs: the last `SCENARIO-<name>`
// marker in a user message picks the script, and the number of assistant turns
// after it picks the step, so a subagent (whose prompt carries its own marker)
// runs its own script.
//
// A step is a list of parts: {reasoning}, {text}, {tool, args}. Tool arguments
// are streamed in two halves, the way a real provider splits them.
import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";

const port = Number(process.env.PORT ?? 4556);
const scriptPath = process.env.SCRIPT;
const logPath = process.env.MOCK_LOG ?? "mock-openai.log";
const model = process.env.MODEL ?? "kimi-k2-mock";

let seq = 0;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

function pick(messages) {
  let key;
  let at = -1;
  messages.forEach((message, index) => {
    if (message.role !== "user") return;
    const found = [...textOf(message.content).matchAll(/SCENARIO-([A-Z0-9-]+)/g)];
    if (found.length > 0) {
      key = found.at(-1)[1];
      at = index;
    }
  });
  if (!key) return { key: undefined, step: 0 };
  return { key, step: messages.slice(at + 1).filter((message) => message.role === "assistant").length };
}

function chunk(id, delta, finish = null, usage) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

createServer((request, response) => {
  let raw = "";
  request.on("data", (part) => (raw += part));
  request.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {}

    if (request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
      return;
    }
    if (!request.url?.includes("/chat/completions")) {
      appendFileSync(logPath, `${request.method} ${request.url} -> 404\n`);
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "mock" } }));
      return;
    }

    const scripts = JSON.parse(readFileSync(scriptPath, "utf8"));
    const { key, step } = pick(body.messages ?? []);
    const parts = (key && scripts[key]?.[step]) ?? [{ text: "Done." }];
    appendFileSync(logPath, `POST ${request.url} tools=${body.tools?.length ?? 0} -> ${key ?? "-"}#${step}\n`);

    const id = `chatcmpl-mock-${++seq}`;
    const events = [];
    let toolIndex = 0;
    for (const part of parts) {
      if (part.reasoning !== undefined) events.push(chunk(id, { reasoning_content: part.reasoning }));
      if (part.text !== undefined) events.push(chunk(id, { content: part.text }));
      if (part.tool !== undefined) {
        const args = JSON.stringify(part.args ?? {});
        const half = Math.floor(args.length / 2);
        const callId = `call_${key}_${step}_${toolIndex}`;
        events.push(chunk(id, {
          tool_calls: [{ index: toolIndex, id: callId, type: "function", function: { name: part.tool, arguments: args.slice(0, half) } }],
        }));
        events.push(chunk(id, { tool_calls: [{ index: toolIndex, function: { arguments: args.slice(half) } }] }));
        toolIndex += 1;
      }
    }
    const usage = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 };
    events.push(chunk(id, {}, toolIndex > 0 ? "tool_calls" : "stop", usage));

    if (!body.stream) {
      const content = parts.filter((part) => part.text).map((part) => part.text).join("");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id,
        object: "chat.completion",
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage,
      }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
  });
}).listen(port, "127.0.0.1", () => console.log(`mock openai on ${port}`));
