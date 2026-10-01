// A stdio MCP server with one tool that writes a file and one that reads it,
// for e2e/live.mjs: the parser counts an MCP call as an edit by its name and
// its arguments, and only a real Claude Code shows what those look like.
// Paths resolve against the working directory Claude Code starts it in.
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const TOOLS = [
  {
    name: "write_file",
    description: "Write text to a file, replacing it if it exists.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "read_file",
    description: "Read a text file.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

function answer(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function call(name, args) {
  if (name === "write_file") {
    writeFileSync(resolve(args.path), args.content);
    return `wrote ${args.path}`;
  }
  if (name === "read_file") return readFileSync(resolve(args.path), "utf8");
  throw new Error(`no tool ${name}`);
}

for await (const line of createInterface({ input: process.stdin })) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  if (message.id === undefined) continue; // a notification
  if (message.method === "initialize") {
    answer(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "e2e-files", version: "1.0.0" },
    });
  } else if (message.method === "tools/list") {
    answer(message.id, { tools: TOOLS });
  } else if (message.method === "tools/call") {
    try {
      answer(message.id, { content: [{ type: "text", text: call(message.params.name, message.params.arguments ?? {}) }] });
    } catch (error) {
      answer(message.id, { content: [{ type: "text", text: String(error) }], isError: true });
    }
  } else {
    answer(message.id, {});
  }
}
