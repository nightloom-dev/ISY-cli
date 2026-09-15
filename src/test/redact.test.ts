import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseLines, parseTranscriptFile } from "../parser.js";
import { BUILTIN_RULES, REDACTION_MARKER, applyRules, marker, redactLines, redactTranscriptFile } from "../redact.js";

function redactOne(text: string, extraPatterns?: string[]): string {
  const record = { type: "user", message: { role: "user", content: text } };
  const { lines } = redactLines([JSON.stringify(record)], { extraPatterns });
  const parsed = JSON.parse(lines[0]!) as { message: { content: string } };
  return parsed.message.content;
}

function summaryFor(records: unknown[]) {
  return redactLines(records.map((record) => JSON.stringify(record)));
}

test("masks OpenAI-style provider keys", () => {
  const out = redactOne("export OPENAI=sk-abcdefghij0123456789XYZ done");
  assert.equal(out, `export OPENAI=${marker("openai_key")} done`);
});

test("masks Anthropic keys with their own label", () => {
  const out = redactOne("key sk-ant-api03-AAaaBBbbCCccDDddEEeeFF");
  assert.equal(out, `key ${marker("anthropic_key")}`);
});

test("does not treat an ordinary hyphenated word as a provider key", () => {
  const out = redactOne("the task-abcdefghij0123456789 identifier");
  assert.equal(out, "the task-abcdefghij0123456789 identifier");
});

test("masks every GitHub token prefix", () => {
  const body = "a".repeat(36);
  for (const prefix of ["ghp", "gho", "ghs", "ghu"]) {
    assert.equal(redactOne(`${prefix}_${body}`), marker("github_token"));
  }
  assert.equal(redactOne(`github_pat_${"b".repeat(24)}`), marker("github_token"));
});

test("masks AWS access key ids", () => {
  assert.equal(redactOne(`id AKIA${"A".repeat(16)}`), `id ${marker("aws_key")}`);
  assert.equal(redactOne(`id ASIA${"1".repeat(16)}`), `id ${marker("aws_key")}`);
});

test("masks Google API keys", () => {
  assert.equal(redactOne(`AIza${"x".repeat(35)}`), marker("google_key"));
});

test("masks a whole PEM private key block", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";
  assert.equal(redactOne(`before ${pem} after`), `before ${marker("private_key")} after`);
});

test("masks a truncated private key that never reaches its end marker", () => {
  const out = redactOne("-----BEGIN OPENSSH PRIVATE KEY-----\nMIIEowIBAAKCAQEA");
  assert.equal(out, marker("private_key"));
});

test("masks JWTs", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(redactOne(`Authorization: Bearer ${jwt}`), `Authorization: Bearer ${marker("jwt")}`);
});

test("masks only the password inside a connection string", () => {
  const out = redactOne("postgres://appuser:hunter2000@db.internal:5432/isy");
  assert.equal(out, `postgres://appuser:${marker("connection_string")}@db.internal:5432/isy`);
});

test("masks connection string passwords for every supported scheme", () => {
  for (const scheme of ["postgresql", "mysql", "mongodb", "redis", "amqp"]) {
    const out = redactOne(`${scheme}://user:secretpass@host/db`);
    assert.equal(out, `${scheme}://user:${marker("connection_string")}@host/db`);
  }
});

test("masks the value of a sensitive assignment and keeps the key", () => {
  assert.equal(redactOne('password = "hunter2000"'), `password = "${marker("assignment")}"`);
  assert.equal(redactOne("API_KEY: abcdefgh12345"), `API_KEY: ${marker("assignment")}`);
  assert.equal(redactOne("private-key=abcdefghijkl"), `private-key=${marker("assignment")}`);
});

test("leaves short assignment values alone", () => {
  assert.equal(redactOne("password = short"), "password = short");
});

test("masks a snake_case key but not the same word inside a longer identifier", () => {
  assert.equal(redactOne("access_token = AbCdEf1234567890"), `access_token = ${marker("assignment")}`);
  assert.equal(redactOne("const adminPassword = someLongVariableName"), "const adminPassword = someLongVariableName");
});

test("leaves a value that is plainly code rather than a literal secret", () => {
  const jsx = "<OrdersTab accessToken={accessToken} />";
  assert.equal(redactOne(jsx), jsx);
  assert.equal(redactOne("token: string,"), "token: string,");
});

test("still masks an environment reference, erring toward over-redaction", () => {
  assert.equal(
    redactOne("api_key = process.env.OPENAI_KEY"),
    `api_key = ${marker("assignment")}`,
  );
});

test("does not redact an already redacted value a second time", () => {
  const out = redactOne(`api_key = sk-abcdefghij0123456789XYZ`);
  assert.equal(out, `api_key = ${marker("openai_key")}`);
});

test("masks a sensitive value carried as a JSON object key", () => {
  const { lines } = summaryFor([
    { type: "user", message: { role: "user", content: [{ type: "text", text: "x" }] }, toolUseResult: { token: "abcdefghijklmnop" } },
  ]);
  const parsed = JSON.parse(lines[0]!) as { toolUseResult: { token: string } };
  assert.equal(parsed.toolUseResult.token, marker("assignment"));
});

test("cuts the body of a tool_result that read a dotenv file", () => {
  const { lines, summary } = summaryFor([
    {
      type: "assistant",
      uuid: "a",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/.env.local" } }],
      },
    },
    {
      type: "user",
      uuid: "b",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "STRIPE_LIVE=pk_live_totally_real" }],
      },
      toolUseResult: { stdout: "STRIPE_LIVE=pk_live_totally_real" },
    },
  ]);

  const result = JSON.parse(lines[1]!) as {
    message: { content: { content: string }[] };
    toolUseResult: string;
  };
  assert.equal(result.message.content[0]?.content, marker("dotenv"));
  assert.equal(result.toolUseResult, marker("dotenv"));
  assert.ok(summary.counts.dotenv! >= 2);
});

test("cuts dotenv content written through a Write tool call", () => {
  const { lines } = summaryFor([
    {
      type: "assistant",
      uuid: "a",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Write",
            input: { file_path: "/repo/.env", content: "STRIPE_LIVE=pk_live_totally_real" },
          },
        ],
      },
    },
  ]);

  const record = JSON.parse(lines[0]!) as { message: { content: { input: { content: string } }[] } };
  assert.equal(record.message.content[0]?.input.content, marker("dotenv"));
});

test("leaves a tool_result alone when the file is not a dotenv file", () => {
  const { lines } = summaryFor([
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/readme.md" } }],
      },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "plain docs" }] },
    },
  ]);

  const result = JSON.parse(lines[1]!) as { message: { content: { content: string }[] } };
  assert.equal(result.message.content[0]?.content, "plain docs");
});

test("applies extra patterns from configuration", () => {
  const out = redactOne("internal ACME-9F3K2 reference", ["ACME-[A-Z0-9]{5}"]);
  assert.equal(out, `internal ${marker("custom")} reference`);
});

test("reports an invalid extra pattern instead of throwing", () => {
  const { summary } = redactLines([JSON.stringify({ type: "user" })], { extraPatterns: ["([unclosed"] });
  assert.deepEqual(summary.invalidExtraPatterns, ["([unclosed"]);
});

test("redacts a line that is not valid JSON without dropping it", () => {
  const { lines, summary } = redactLines(["not json at all sk-abcdefghij0123456789XYZ"]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `not json at all ${marker("openai_key")}`);
  assert.equal(summary.unparsedLines, 1);
});

test("keeps output parseable as JSONL and counts what it replaced", () => {
  const { lines, summary } = summaryFor([
    { type: "user", message: { role: "user", content: 'password = "hunter2000"' } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `AIza${"x".repeat(35)}` }] } },
  ]);

  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.equal(summary.counts.assignment, 1);
  assert.equal(summary.counts.google_key, 1);
  assert.equal(summary.replacements, 2);
  assert.equal(summary.lines, 2);
});

test("every builtin rule replaces with the shared marker prefix", () => {
  for (const rule of BUILTIN_RULES) {
    assert.ok(rule.replacement.includes(REDACTION_MARKER), `${rule.type} lacks the marker`);
    assert.ok(rule.pattern.global, `${rule.type} must be a global pattern`);
  }
});

test("masks absolute paths in a record, learning the root from the record itself", () => {
  const record = {
    type: "assistant",
    cwd: "/home/alice/work/isy",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", name: "Edit", input: { file_path: "/home/alice/work/isy/src/a.ts" } },
        { type: "tool_use", name: "Bash", input: { command: "cd /home/alice/work/isy && npm test" } },
      ],
    },
  };

  const { lines, summary } = redactLines([JSON.stringify(record)]);
  const parsed = JSON.parse(lines[0]!) as typeof record;

  // The working directory is the one thing every record repeats, so it is the
  // root even when the hook did not say where the session ran.
  assert.equal(parsed.cwd, ".");
  assert.equal((parsed.message.content[0] as { input: { file_path: string } }).input.file_path, "src/a.ts");
  assert.equal(
    (parsed.message.content[1] as { input: { command: string } }).input.command,
    "cd . && npm test",
  );
  assert.ok((summary.counts.path ?? 0) >= 3);
});

test("masks a path carried as a JSON object key", () => {
  // Claude Code keys its per-file state by absolute path. Redaction walked the
  // values only, so the account name stayed in the key of every such map.
  const record = {
    type: "assistant",
    cwd: "/home/alice/work/isy",
    toolUseResult: {
      "/home/alice/work/isy/src/a.ts": { readAt: 1 },
      "/home/alice/.claude/settings.json": { readAt: 2 },
    },
  };

  const { lines } = redactLines([JSON.stringify(record)]);
  const parsed = JSON.parse(lines[0]!) as { toolUseResult: Record<string, unknown> };

  assert.deepEqual(Object.keys(parsed.toolUseResult), ["src/a.ts", "~/.claude/settings.json"]);
});

test("the working directory the caller names wins over the one on the record", () => {
  const record = { type: "user", cwd: "/home/alice/elsewhere", message: { role: "user", content: "/home/alice/work/isy/src/a.ts" } };
  const { lines } = redactLines([JSON.stringify(record)], { cwd: "/home/alice/work/isy" });
  const parsed = JSON.parse(lines[0]!) as { message: { content: string } };
  assert.equal(parsed.message.content, "src/a.ts");
});

test("masks a home path in a transcript that never says where it ran", () => {
  const out = redactOne("failed to open /Users/dave/Library/Caches/pnpm/store");
  assert.equal(out, "failed to open ~/Library/Caches/pnpm/store");
});

test("a secret and a path in one string do not interfere", () => {
  const out = redactOne("wrote sk-abcdefghij0123456789XYZ to /home/alice/.netrc");
  assert.equal(out, `wrote ${marker("openai_key")} to ~/.netrc`);
});

test("leaves ordinary source code untouched", () => {
  const code = "const total = items.reduce((sum, item) => sum + item.price, 0);";
  assert.equal(applyRules(code, BUILTIN_RULES), code);
});

const corpus = join(homedir(), ".claude", "projects");

test("redacts real transcripts without corrupting them", { skip: !existsSync(corpus) }, async () => {
  const projects = await readdir(corpus);
  const files: string[] = [];

  for (const project of projects) {
    let entries: string[];
    try {
      entries = await readdir(join(corpus, project));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) files.push(join(corpus, project, entry));
    }
  }

  assert.ok(files.length > 0);

  let redactedLines = 0;
  for (const file of files) {
    const { lines, summary } = await redactTranscriptFile(file);
    redactedLines += lines.length;
    assert.equal(summary.invalidExtraPatterns.length, 0);
    for (const line of lines) {
      if (line.startsWith("{")) assert.doesNotThrow(() => JSON.parse(line), `${file} produced invalid JSON`);
    }
  }

  assert.ok(redactedLines > 0);
});

test("redacted output still parses into the same session structure", { skip: !existsSync(corpus) }, async () => {
  const projects = await readdir(corpus);
  let checked = 0;

  for (const project of projects) {
    let entries: string[];
    try {
      entries = await readdir(join(corpus, project));
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const file = join(corpus, project, entry);

      const original = await parseTranscriptFile(file);
      const { lines } = await redactTranscriptFile(file);
      const redacted = parseLines(lines);

      assert.equal(redacted.records.length, original.records.length, `${file} lost records`);
      assert.equal(redacted.toolUses.length, original.toolUses.length, `${file} lost tool calls`);
      assert.equal(redacted.fileEdits.size, original.fileEdits.size, `${file} lost edited files`);
      assert.equal(redacted.mainPath.size, original.mainPath.size, `${file} lost tree structure`);
      checked += 1;
    }
  }

  assert.ok(checked > 0);
});
