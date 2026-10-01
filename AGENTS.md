# AGENTS.md — the ISY CLI

Orientation for AI assistants and for anyone opening this repository cold.
Everything here is checked against the code.

## 1. What this is

The client half of [ISY](https://iseeyaai.com). It reads the transcript an agent
CLI leaves behind — Claude Code, Codex CLI, Kimi CLI — redacts it, and uploads
it. The server matches sessions to a pull request and comments there. The server
is closed source and lives in a private repository; nothing in here talks to a
database or to a model.

## 2. Two consumers, not one

- **The bin.** `dist/index.js`, installed as `isy`.
- **The library.** `./parser`, `./stage0`, `./types` and `./mask-paths` in
  `exports` are imported by the ISY server. They are API: changing an exported
  shape breaks a deployment you cannot see from here. Everything else is
  internal and can move freely.

## 3. Layout

| Path | What lives there |
| --- | --- |
| `src/index.ts` | Argument parsing and dispatch |
| `src/commands/` | One file per command |
| `src/agents/` | Per-CLI adapters: where sessions live, how hooks are written, how records are reshaped |
| `src/parser.ts`, `src/detectors.ts`, `src/stage0.ts` | The offline analysis — the same code the server runs |
| `src/redact.ts`, `src/mask-paths.ts` | What is cut and what is rewritten before anything is sent |
| `src/test/` | `node:test`, no framework |

## 4. Traps

- **Hook commands are `npx @nightloom/isy …`, and the scope is not decoration.**
  The bare name `isy` on npm is an unrelated package, and npx resolves a bare
  name against the registry rather than against PATH — a hook saying `npx isy`
  would fetch a stranger. npx is kept rather than the bin because a machine set
  up with `npx @nightloom/isy init` never installed anything globally. Old
  commands are listed in `superseded`, so installing over them rewrites the line
  in place instead of stacking a second hook (`hook.ts`, `githook.ts`,
  `agents/kimi.ts`, `agents/codex.ts`).
- **The parser must survive unknown fields and record types.** Transcript
  formats are undocumented and move between CLI versions. Log and skip; never
  throw.
- **A JSONL file is split on `\n` alone** (`lines.ts:fileLines`), never with
  `node:readline`: it also ends a line at U+2028 and U+2029, which
  `JSON.stringify` leaves unescaped inside strings, and a record carrying one
  came apart into fragments that neither parsed nor had their secrets redacted.
- **Claude Code's `attachment` records go up as their `type` alone**
  (`redact.ts:stripAttachment`). They hold what the harness tells the model —
  the account's email and organisation, the whole system prompt — and nothing
  downstream reads past the type. The records stay: the next one names them as
  its `parentUuid`.
- **Nothing is quoted verbatim out of a transcript** — not developer prompts,
  not `thinking` blocks. Anything printed or sent goes through `mask-paths`
  first, which is idempotent: applying it twice is safe.
- **Absolute paths are rewritten, not blanked.** Under the working directory a
  path becomes repo-relative, elsewhere under home it becomes `~/…`, and
  `/etc`, `/usr`, `/root` are left alone. The root comes from the transcript,
  not from wherever this process happens to stand.
- **`ponytail:` marks a deliberate simplification** with a named ceiling and a
  way up. It is not a TODO; do not "fix" it blind.
- **A Claude session is its file and its subagents' files.** Claude Code 2.1
  writes each subagent to `<session>/subagents/agent-<id>.jsonl`, and the
  session file keeps only the `Agent` call and its result. `subagents.ts`
  merges every subagent in by time, never ahead of its call, as sidechain
  records with `parentToolUseID` — by time, because a background subagent works
  alongside its session and a resumed one appends to the same file, and the
  detectors read order as time. Upload, `status`, `commit` and `analyze` all
  read that one transcript, and a session's size and mtime include its
  subagents. Kimi CLI
  forwards a foreground subagent's events into the session's own log
  (`SubagentEvent`), while a background one writes only its own
  `subagents/<id>/wire.jsonl`, which the `Agent` call's result names;
  `kimi-cli-wire.ts` turns both into the same shape. Kimi Code writes one log
  per agent (`agents/agent-<n>/wire.jsonl`) and marks where each started — and
  where it was resumed — with `subagent.spawned`; `kimi.ts:subagentLogs` reads
  them and `kimi-wire.ts` merges them in by the same rule (`timeline.ts`).
- **Kimi is two CLIs.** The Python Kimi CLI, archived at 1.52, lives in `~/.kimi`
  (`KIMI_SHARE_DIR`): `wire.jsonl` in envelopes is the session, `state.json` has
  no `cwd` (it is in `kimi.json`), and the version and model are only in its
  `logs/kimi.log`. Kimi Code, the TypeScript CLI that replaced it (2.1.1 at the
  time of writing), lives in `~/.kimi-code` (`KIMI_CODE_HOME`): `state.json`
  has the `cwd`, `agents/main/wire.jsonl` is the session, `llm.request` names
  the model, and the version is only in the npm package a `kimi` on PATH
  belongs to. Both homes are read, and each gets the hooks its CLI can run.
  Kimi Code took Claude's tool names (`Read`, `Edit`, `Write`, `Bash`, `Agent`)
  but kept Kimi's arguments (`path`, `line_offset`, `mode`), so
  `kimi-tools.ts:claudeTool` translates those too.
- **Some Kimi Code sessions are copies.** Its first launch imports Kimi CLI's
  sessions (`custom.imported_from_kimi_cli`, `imported_at`) under new ids, and
  `/fork` copies a session's log, calls and times and all, into a new one
  (`forkedFrom`). The copied part goes up as the session it came from, so a
  copy nobody went on with is not listed, and one gone on with is read from
  where the copy ends (`kimi.ts:copiedUntil`). And a Kimi CLI session can have
  no `state.json` at all — it is written once a turn completes — so its folder
  names it.
- **A user-role message in Kimi Code is not always the user.** Its `origin`
  says what wrote it; `kimi-wire.ts:isTurn` follows Kimi Code's own rule for
  which are turns, and drops `hook_result` besides — which is where the
  UserPromptSubmit drain's alerts land, because Kimi Code also feeds a
  UserPromptSubmit hook's stdout to the model.
- **SessionEnd hooks are on a short leash.** Claude Code 2.1 cancels one after
  1.5 s unless it sets `timeout`, and waits out a longer one on `/clear` and
  `/resume`; Kimi CLI cancels them after five seconds whatever `timeout` says;
  Codex tears the session down under it. So all three detach the upload: the
  hook shell hands the payload over on fd 3 and returns at once, and the
  upload's line is parked for the next session start. Kimi Code waits out the
  hook's own `timeout` (30 in isy's block) and runs the upload in the hook
  itself; it fires no SessionEnd for `-p`, SIGTERM or SIGHUP, which is what the
  sweep is for.
- **isy's hooks mend themselves.** The SessionStart hook rewrites the hooks an
  older isy wrote where they stand (`Agent.repairHooks`) and adds none that are
  missing. Sending the reader to `isy init` for it meant signing in again, and
  on a plan with one key that means revoking the key in use — which is also why
  `init` keeps a key the server still takes. In a Kimi config a hook is isy's by
  its parsed `command` (`kimi-config.ts`), not by the comments around isy's
  block: both Kimi CLIs write their config back without comments, and Kimi
  Code's migration copies Kimi CLI's hooks into its own.
- **An unknown tool is an edit only if it could have named a file.** Every
  Claude Code release adds bookkeeping tools; `parser.ts:mayWrite` counts an
  unknown one only when its arguments carry a path or code, or cannot be read.
  An MCP tool counts when it is given a target and its name says it writes;
  `apply_patch` and `TowerMerge` name no file and write anyway. A subagent sent
  off counts too when nothing of it came back — no records under its call and
  no edit count on the result: a background one answers "launched" and works
  after (`parser.ts:delegatedUnseen`). Adapters translate what they can into
  Claude's names first (`kimi-tools.ts`, `codex-records.ts`).
- **A finding is known by its anchor, not by where it stands.** `isy commit`
  shows each stage 0 candidate once, keyed by the anchor's `toolUseId` or
  `uuid` (`state.ts:candidateKey`): a subagent merged in by time moves every
  record after it, and a key holding the record's index showed the same finding
  again at the next commit. And the session a commit goes to is the one whose
  own file moved last (`paths.ts:lastActive`): a session's mtime includes its
  subagents', and the one whose background subagent wrote last is not the one
  that committed.
- **Stage 0 is calibrated with the server.** The induced corpus and the
  snapshots it is calibrated against live there, so a detector change is
  verified by publishing a prerelease (`1.2.0-next.0` lands on `next`) and
  calibrating there before `latest` moves. `npm run calibrate:corpus` runs the
  detectors over the real sessions on your own machine and uploads nothing.
  What `src/test/fixtures` holds is different: transcripts the CLIs themselves
  recorded against a scripted API (`src/test/fixtures/record`), for the readers.

## 5. Conventions

- Comments explain **why**, and are self-contained: a reference has to be
  something in this repository — a file, a symbol, a test. A pointer to a
  document that is not in the tree is a dead end.
- Commits are Conventional Commits (`feat`, `fix`, `docs`, `build`, `refactor`).
- Tests are `node:test`. Do not add jest or vitest.
- Tests that need real transcripts skip themselves when there are none, so CI
  stays green on a machine with no agent history.

## 6. Working on it

```bash
npm install
npm run build
npm test
npm run typecheck

npm link          # puts this checkout on PATH as `isy`
```

Releases are continuous from `main` (`.github/workflows/release.yml`): every
push checks the registry, and a version that is not there yet is built, tested,
published and tagged `v<version>`. So a release is one commit that bumps the
version — `npm version <patch|minor|major> --no-git-tag-version` — and nothing
else has to be done. A plain version goes to `latest`; a prerelease
(`npm version prerelease --preid next`) goes to `next`, and
`npm dist-tag add @nightloom/isy@<version> latest` promotes it.
