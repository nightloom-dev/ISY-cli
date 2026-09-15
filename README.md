# isy

Command-line client for [ISY](https://iseeyaai.com). It reads the transcript of a
coding session — Claude Code, Codex CLI or Kimi CLI — and uploads it, so the
review on your pull request can be about how the work was done and not only
about the diff that came out of it: a fix that was never run, an assumption
nobody checked, a file edited from stale context.

Nothing is posted anywhere until a pull request exists. Sessions are matched to
one by commit SHA, and the result is a single comment on that pull request.

## Install

```sh
npm install -g @nightloom/isy
isy init
```

`isy init` opens the browser, takes a key from it and writes it to
`~/.isy/config.json`. It also installs the session hooks for every agent CLI it
finds on the machine, so from there on nothing has to be run by hand.

## Commands

| Command | What it does |
| --- | --- |
| `isy init` | Pair with the server, install hooks |
| `isy status` | Account, plan, what is installed on this machine |
| `isy check` | Hook health, parked alerts, pending uploads |
| `isy upload` | Upload the current session |
| `isy sweep` | Upload every session that grew since last time |
| `isy notes` | Print this branch's findings as prompts for a coding agent |
| `isy analyze <dir>` | Run the local detectors over transcripts, upload nothing |
| `isy settings` | Read or write the analysis settings on your account |
| `isy health --scan` | Where this machine keeps agent sessions |
| `isy logout` | Revoke the key on the server and forget it locally |

`isy analyze` is the whole first stage of the pipeline and it runs offline —
the fastest way to see what this thing looks at before giving it anything.

## What leaves the machine

The transcript of the session: prompts, tool calls, results, timings. Before it
is sent, the client rewrites it:

- **Secrets are redacted** — tokens, API keys, connection strings, private keys
  and anything matching the patterns you add in `extraRedactPatterns`.
- **Absolute paths are rewritten, not blanked** — a file under the repository
  becomes `src/a.ts`, anything else under your home becomes `~/…`. Your account
  name does not travel with the transcript.

The server redacts again on the way in, and every prompt it builds reads from
the redacted copy. See the [privacy policy](https://iseeyaai.com/privacy) for
what is stored and for how long.

## Repository configuration

A repository can narrow the analysis with `.isy.yml` on the pull request's
branch — turn categories off, ignore paths, raise thresholds. Per-account
settings (`isy settings`) narrow it further, never the other way around.

## Requirements

Node.js 20 or newer. Git. An account at [iseeyaai.com](https://iseeyaai.com)
and the GitHub App installed on the repositories you want reviewed.

## License

MIT
