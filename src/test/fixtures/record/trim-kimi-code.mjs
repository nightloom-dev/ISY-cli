// Shrinks a recorded Kimi Code session into a test fixture:
//
//   node trim-kimi-code.mjs <.kimi-code dir> <session id> <cwd> <destination .kimi-code dir>
//
// Keeps what isy reads — `state.json` and every agent's `wire.jsonl` — in the
// shape Kimi Code wrote it. What is cut: long strings in the records that
// carry the harness itself (the system prompt, the tool schemas), and the
// paths of the machine that recorded it, which become `/home/dev/kcshop` for
// the working directory, `/home/dev/.kimi-code` for Kimi Code's home and
// `/home/dev` for the user's. The workspace folder keeps the name Kimi Code
// gave it, hash of the recording path included: isy reads the working
// directory from `state.json`, never from that name.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const [home, session, cwd, destination] = process.argv.slice(2);
const HEAVY = new Set(["llm.tools_snapshot", "profile.bind"]);
const LIMIT = 160;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function cut(value) {
  if (typeof value === "string") return value.length > LIMIT ? `${value.slice(0, LIMIT)} [cut for the fixture]` : value;
  if (Array.isArray(value)) return value.map(cut);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, cut(inner)]));
  return value;
}

function relocate(text) {
  return text
    .replaceAll(home, "/home/dev/.kimi-code")
    .replaceAll(cwd, "/home/dev/kcshop")
    .replaceAll(dirname(home), "/home/dev");
}

function trimLog(text) {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const record = JSON.parse(line);
      return JSON.stringify(HEAVY.has(record.type) ? cut(record) : record);
    })
    .map(relocate)
    .join("\n");
}

const root = walk(join(home, "sessions")).find((path) => path.includes(`/${session}/`));
const sessionDir = root.slice(0, root.indexOf(`/${session}/`) + session.length + 1);
for (const path of walk(sessionDir)) {
  const name = relative(sessionDir, path);
  if (name !== "state.json" && !/^agents\/[^/]+\/wire\.jsonl$/.test(name)) continue;
  const to = join(destination, relative(home, path));
  mkdirSync(dirname(to), { recursive: true });
  const text = readFileSync(path, "utf8");
  writeFileSync(to, name === "state.json" ? relocate(text) : `${trimLog(text)}\n`);
}
