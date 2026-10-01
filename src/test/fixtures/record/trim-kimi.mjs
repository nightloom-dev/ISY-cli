// Shrinks a recorded Kimi CLI home into a test fixture:
//
//   node trim-kimi.mjs <.kimi dir> <session id> <destination .kimi dir>
//
// Every file keeps the shape Kimi CLI wrote. What is cut: the system prompt,
// down to the sentence that names the working directory (the adapter reads
// that one); the log, down to the lines that open the session's run; and the
// path the log names the installed package by, which is this machine's — it
// becomes `@SITE_PACKAGES@`, for a test to point at a package of its own.
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const [home, session, destination] = process.argv.slice(2);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function trimContext(text) {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const record = JSON.parse(line);
      if (record.role === "_system_prompt" && typeof record.content === "string") {
        const cwd = /The current working directory is `[^`]+`\./.exec(record.content);
        record.content = `You are Kimi Code CLI. [system prompt cut for the fixture]${cwd ? `\n\n${cwd[0]}` : ""}`;
      }
      return JSON.stringify(record);
    })
    .join("\n");
}

const sessionDir = walk(join(home, "sessions")).find((path) => path.includes(`/${session}/`));
const root = sessionDir.slice(0, sessionDir.indexOf(`/${session}/`) + session.length + 1);
for (const path of walk(root)) {
  const to = join(destination, relative(home, path));
  mkdirSync(dirname(to), { recursive: true });
  if (path.endsWith("context.jsonl")) writeFileSync(to, `${trimContext(readFileSync(path, "utf8"))}\n`);
  else cpSync(path, to);
}

cpSync(join(home, "kimi.json"), join(destination, "kimi.json"));

const log = readFileSync(join(home, "logs", "kimi.log"), "utf8").split("\n");
const opens = log.findIndex((line) => line.includes(`session: ${session}`));
const kept = log
  .slice(opens, opens + 12)
  .filter((line) => /session:|Using LLM model:|Loading agent:/.test(line))
  .map((line) => line.replace(/Loading agent: .*?\/kimi_cli\//, "Loading agent: @SITE_PACKAGES@/kimi_cli/"));
mkdirSync(join(destination, "logs"), { recursive: true });
writeFileSync(join(destination, "logs", "kimi.log"), `${kept.join("\n")}\n`);
