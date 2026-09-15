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
- **Nothing is quoted verbatim out of a transcript** — not developer prompts,
  not `thinking` blocks. Anything printed or sent goes through `mask-paths`
  first, which is idempotent: applying it twice is safe.
- **Absolute paths are rewritten, not blanked.** Under the working directory a
  path becomes repo-relative, elsewhere under home it becomes `~/…`, and
  `/etc`, `/usr`, `/root` are left alone. The root comes from the transcript,
  not from wherever this process happens to stand.
- **`ponytail:` marks a deliberate simplification** with a named ceiling and a
  way up. It is not a TODO; do not "fix" it blind.
- **Stage 0 has no fixtures here.** The induced corpus and the snapshots it is
  calibrated against live with the server, so a detector change is verified by
  publishing to `next` and calibrating there before `latest` moves.
  `npm run calibrate:corpus` runs the detectors over the real sessions on your
  own machine and uploads nothing.

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

Releases: `npm version <patch|minor|major> && git push --follow-tags` publishes
to the `next` tag from CI; `npm dist-tag add @nightloom/isy@<version> latest`
promotes it.
