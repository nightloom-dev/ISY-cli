# Recorded sessions

The transcripts under `fixtures/` were written by the agent CLIs themselves,
driven against a scripted model API, so their shape is the CLI's and their
content is a script's: nothing in them came from a real person or a real model.

## Claude Code — `claude-2.1.285/`

`mock-anthropic.mjs` answers the Messages API (streaming and not) from
`claude-scenarios.json`. It is stateless: the last `SCENARIO-<name>` marker in a
user message picks the script, and the number of assistant turns after it picks
the step, so a subagent (whose prompt carries its own marker) runs its own
script. A request whose last message asks for a `<summary>` block is a
compaction and gets a canned summary; anything with no marker (titles, side
questions) gets a short reply.

```sh
PORT=4555 SCRIPT=claude-scenarios.json node mock-anthropic.mjs &

run() {
  env -i PATH="$PATH" HOME=/home/dev CLAUDE_CONFIG_DIR=/home/dev/.claude \
    ANTHROPIC_BASE_URL=http://127.0.0.1:4555 ANTHROPIC_API_KEY=sk-ant-mock-0000000000000000 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_AUTOUPDATER=1 \
    claude --model claude-opus-5-5 --output-format json \
      --allowedTools "Read Edit Write Bash Agent CronList" --permission-mode acceptEdits "$@" </dev/null
}

# compacted: a git repo at /home/dev/shop where add() subtracts
(cd /home/dev/shop && run -p "SCENARIO-MAIN: the add test fails, fix it")
(cd /home/dev/shop && run -p "/compact" --resume <session id>)
(cd /home/dev/shop && run -p "SCENARIO-MAIN2: document add() in the README" --resume <session id>)

# delegated: a git repo at /home/dev/cart where total() ignores qty
(cd /home/dev/cart && run -p "SCENARIO-FG: total() ignores quantity, fix it")

node trim.mjs /home/dev/.claude/projects/-home-dev-shop <session id> ../claude-2.1.285/compacted
node trim.mjs /home/dev/.claude/projects/-home-dev-cart <session id> ../claude-2.1.285/delegated
```

`trim.mjs` cuts long strings inside attachments — the harness's system prompt,
tool schemas and listings — and leaves every record's shape alone.

What the recording showed about 2.1.285, beyond the fixtures themselves:

- A SessionEnd hook is cancelled after 1.5 seconds unless it sets `timeout`
  (`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` overrides the default); with
  `"timeout": 30` it runs to the end.
- SessionStart sends `{session_id, transcript_path, cwd, hook_event_name, source}`,
  SessionEnd `{session_id, transcript_path, cwd, prompt_id, hook_event_name, reason}`.

## Kimi CLI — `kimi-cli-1.52/`

Kimi CLI 1.52 is the Python CLI's last release, and its `kimi` command no
longer runs the agent — it prints a notice or installs Kimi Code, its
successor. The CLI itself is still in the wheel: `python -m kimi_cli.cli`.
`mock-openai.mjs` answers chat completions from `kimi-scenarios.json`, the same
way the Anthropic mock does.

```sh
PORT=4556 SCRIPT=kimi-scenarios.json node mock-openai.mjs &

# ~/.kimi/config.toml: an openai_legacy provider at http://127.0.0.1:4556/v1,
# model `kimi-k2-mock`, telemetry = false
(cd /home/dev/kshop && HOME=/home/dev/kimihome KIMI_SHARE_DIR=/home/dev/kimihome/.kimi \
  python -m kimi_cli.cli --print -p "SCENARIO-KMAIN: the add test fails, fix it" -w /home/dev/kshop)

node trim-kimi.mjs /home/dev/kimihome/.kimi <session id> ../kimi-cli-1.52/.kimi
```

`trim-kimi.mjs` cuts the system prompt down to the sentence naming the working
directory, keeps the log lines that open the run, and replaces the installed
package's path the log names with `@SITE_PACKAGES@`.
The log itself was lost to the `*.log` rule in `.gitignore` before it was ever
committed, and is rebuilt in the shape `trim-kimi.mjs` writes: the three lines
that open the run, the session id and the model as recorded.

What the recording showed about 1.52, beyond the fixture itself:

- `wire.jsonl` is the whole session: timestamps are epoch seconds, a failed call
  has `is_error`, and a subagent's events are inline as `SubagentEvent` under
  the `Agent` call's id. `context.jsonl` has no time, no error flag and no
  subagent calls.
- `state.json` has no `cwd` and no id; the workspace folder is the MD5 of the
  path, which only `kimi.json` in the home spells out.
- The model and the version are in no session file. The home's `logs/kimi.log`
  names the model of each run and the path of the installed package.
- SessionEnd hooks are cancelled five seconds after they start, whatever
  `timeout` says, and no hook's stdout is ever shown.
- Hook payloads are `{hook_event_name, session_id, cwd}` plus `source` or
  `reason`; session ids are bare UUIDs.

## Kimi Code — `kimi-code-2.1.1/`

Kimi Code is the TypeScript CLI that replaced Kimi CLI (npm
`@moonshot-ai/kimi-code`, 2.1.1 when recorded). The same `mock-openai.mjs`
serves it, from the `KCMAIN` and `KCSUB` scripts: the same work as `KMAIN`,
under Kimi Code's tool names.

```sh
PORT=4557 SCRIPT=kimi-scenarios.json node mock-openai.mjs &

# $KIMI_CODE_HOME/config.toml: a `kimi` provider at http://127.0.0.1:4557/v1,
# model `kimi-k2-mock` with the `thinking` capability, and a UserPromptSubmit
# hook that prints one line, as isy's alert drain does
(cd /home/dev/kcshop && HOME=/home/dev KIMI_CODE_HOME=/home/dev/.kimi-code \
  KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_DISABLE_TELEMETRY=1 \
  kimi -p "SCENARIO-KCMAIN: the add test fails, fix it")

node trim-kimi-code.mjs /home/dev/.kimi-code <session id> /home/dev/kcshop ../kimi-code-2.1.1/.kimi-code
```

`trim-kimi-code.mjs` keeps `state.json` and every agent's `wire.jsonl`, cuts
the system prompt and tool schemas, and writes the recording machine's paths
as `/home/dev/…`.

What the recording showed about 2.1.1, beyond the fixture itself:

- Every agent writes its own log: the session's in `agents/main/wire.jsonl`, a
  subagent's in `agents/agent-<n>/wire.jsonl`, and the main log marks where it
  started with `subagent.spawned {subagentId, parentToolCallId}`. `state.json`
  lists the agents with absolute `homedir`s and records the `cwd`.
- Times are epoch milliseconds. `llm.request` names the model of every call;
  no file names the CLI's version.
- A user-role message carries an `origin`: `user` for the person, `injection`
  for the CLI's reminders, `hook_result` for a hook's output,
  `system_trigger` for a subagent's prompt. `agent.message.appended` repeats
  every message for the UI.
- A read's result is numbered `<n>\t<line>`, without the last newline, and its
  `note` says how much was read. A failed call, a command that exits non-zero
  included, has `isError`.
- The tools are Claude's names with Kimi's arguments: `Read {path, line_offset,
  n_lines}`, `Write {path, content, mode}`, `Edit {path, old_string,
  new_string}`, `TodoList {todos}`.
- Hook payloads carry `client_type: "kimi_code_cli"` and `session_<uuid>` ids.
  A UserPromptSubmit hook's stdout is shown and also handed to the model as a
  `hook_result` message. SessionEnd runs for as long as the hook's `timeout`,
  and the CLI waits for it; `-p`, SIGTERM and SIGHUP end a session without
  one.
