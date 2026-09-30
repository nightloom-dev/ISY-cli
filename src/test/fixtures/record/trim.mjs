// Shrinks a recorded Claude Code session into a test fixture:
//
//   node trim.mjs <project dir> <session id> <destination dir>
//
// Every record keeps the shape Claude Code wrote. Only long strings inside
// attachments — the harness's system prompt, tool schemas, skill listings — are
// cut, so a fixture carries the format without a copy of the harness's prompts.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const LIMIT = 120;

function cut(value) {
  if (typeof value === "string") return value.length <= LIMIT ? value : `${value.slice(0, LIMIT)}…`;
  if (Array.isArray(value)) return value.slice(0, 6).map(cut);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cut(v)]));
  return value;
}

function trimFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  const lines = readFileSync(from, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const record = JSON.parse(line);
      if (record.type === "attachment") {
        record.attachment = cut(record.attachment);
        if (record.rendered !== undefined) record.rendered = cut(record.rendered);
      }
      return JSON.stringify(record);
    });
  writeFileSync(to, `${lines.join("\n")}\n`);
}

function walk(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const [project, session, destination] = process.argv.slice(2);
trimFile(join(project, `${session}.jsonl`), join(destination, `${session}.jsonl`));
for (const path of walk(join(project, session, "subagents"))) {
  const to = join(destination, relative(project, path));
  if (path.endsWith(".jsonl")) trimFile(path, to);
  else {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(path, to);
  }
}
