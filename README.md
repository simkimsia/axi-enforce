# axi-enforce

Make coding agents actually use [AXI](https://github.com/kunchenguid/axi) wrappers
(`gh-axi`, `railway-axi`, `cloudflare-axi`, ...) instead of the plain CLIs they wrap,
and turn every gap in a wrapper into a GitHub issue instead of a silent fallback.

An instruction in `CLAUDE.md` / `AGENTS.md` is a suggestion. Agents drift back to the
CLI they saw most in training. `axi-enforce` puts a check in front of every shell
command each agent runs, in each agent's own hook system:

```
agent wants to run:  cd app && railway up
axi-enforce:         deny: Use railway-axi instead of plain railway. Check `railway-axi --help` first.
                     If railway-axi lacks this operation: (1) file the gap: gh-axi issue create -R ...
                     (2) rerun prefixed with AXI_GAP=simkimsia/railway-axi#<n> ...
```

## The model

| Situation                                           | What the agent must do                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The axi covers the operation                        | Use the axi. The plain CLI is refused.                                                                                                                              |
| The axi lacks it, and **you maintain the axi**      | File an issue on the axi's repo, then rerun the plain command prefixed `AXI_GAP=owner/repo#N`. The hook checks the issue **exists and is open** before allowing it. |
| The axi lacks it, and **someone else maintains it** | Rerun prefixed `AXI_BYPASS=1`, tell you what was missing, ask before filing upstream.                                                                               |
| The axi is not installed                            | Nothing is enforced for that CLI.                                                                                                                                   |

Every allowed bypass is logged (`axi-enforce log`), so the gaps become a backlog you can
fix in the axi instead of a habit.

## Second job: no conclusions from truncated axi output

Axi output is already compact, so the usual reflex of `| head`, `| tail` or `| cut` only hides
fields. The failure this causes is quiet: the agent reads what is left and reports that the axi
lacks a field or an operation, or hides an error, when the information was there and the agent
cut it off itself.

A real case (2026-10-13, Claude Code): an agent created labels in a loop with
`gh-axi label create ... 2>&1 | tail -2`. One description was over GitHub's 100-character limit.
`tail -2` kept only gh-axi's own summary (`error: Validation error` / `code: VALIDATION_ERROR`)
and dropped GitHub's `HTTP 422 … description is too long (maximum is 100 characters)` printed
above it. The agent reported "gh-axi returns a bare validation error without saying why" and
offered to file an upstream issue. There was no gap: plain `gh` and `gh-axi` print the same reason.
The user's `CLAUDE.md` already said "never pipe an axi through head/tail/cut when the question is
'does it show X?'", and the agent broke the rule anyway. That is the same argument as for the
plain-CLI rule: an instruction is a suggestion, and a hook is a check.

So the hook also refuses a pipeline where an axi's output reaches `head`, `tail` or `cut`:

```
agent wants to run:  for r in a b; do gh-axi label create -R o/$r --name x 2>&1 | tail -2; done
axi-enforce:         deny: Don't pipe gh-axi through tail: axi output is already compact, and truncating
                     it hides fields ... Rerun without `| tail` and read all of it, or `grep` for the field.
```

| Situation                                                                       | What happens                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `<axi> ... \| head` / `\| tail` / `\| cut`, anywhere later in the same pipeline | Refused. Read all of it, or `grep` for the field.          |
| `<axi> ... \| grep x`, or output saved to a file                                | Allowed.                                                   |
| Deliberately wanting part of a long output (e.g. CI logs)                       | Prefix `AXI_TRUNCATE=1`. Allowed and logged as `truncate`. |
| You don't want this check                                                       | `"truncation": false` in `policy.json`.                    |

An axi is any program named in a rule's `axi`, or any program whose name ends in `-axi`.

## Supported agents

| Agent                                     | Mechanism                                                   | Deny reason reaches the model | Notes                                                                         |
| ----------------------------------------- | ----------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| [Claude Code](docs/agents/claude.md)      | `PreToolUse` hook, `~/.claude/settings.json`                | yes                           |                                                                               |
| [Codex CLI](docs/agents/codex.md) ≥ 0.156 | `PreToolUse` hook, `~/.codex/hooks.json`                    | yes                           | approve once with `/hooks` in Codex                                           |
| [OpenCode](docs/agents/opencode.md)       | `tool.execute.before` plugin, `~/.config/opencode/plugins/` | yes (thrown error)            | restart OpenCode                                                              |
| [Gemini CLI](docs/agents/gemini.md)       | `BeforeTool` hook, `~/.gemini/settings.json`                | yes                           |                                                                               |
| [Qwen Code](docs/agents/qwen.md)          | `PreToolUse` hook, `~/.qwen/settings.json`                  | yes                           |                                                                               |
| [Cursor](docs/agents/cursor.md)           | `beforeShellExecution` hook, `~/.cursor/hooks.json`         | yes                           | cursor-agent builds before hook support ignore it; static fallback documented |

All six use one policy engine; the per-agent part is a ~20-line adapter
(`src/adapters/`) that translates the hook's JSON in and out.

## What is verified, and what is not

Three levels, from weakest to strongest:

- **Source-checked:** the hook format was read from the installed agent's code or docs.
- **Unit/e2e-tested:** `pnpm test` feeds that agent's payload shape through the built hook and checks the output.
- **Live:** a real session of the agent was refused, recovered with the axi, and passed allowed commands.

| Agent       | Version checked         | Source-checked | Unit/e2e-tested | Live                        | Tracking                                                |
| ----------- | ----------------------- | -------------- | --------------- | --------------------------- | ------------------------------------------------------- |
| Claude Code | current (2026-09)       | yes            | yes             | **yes** (macOS)             |                                                         |
| Codex CLI   | 0.156.1                 | yes            | yes             | no                          | [#2](https://github.com/simkimsia/axi-enforce/issues/2) |
| OpenCode    | 1.18.31                 | yes            | yes (plugin)    | no (plugin load only)       | [#3](https://github.com/simkimsia/axi-enforce/issues/3) |
| Gemini CLI  | 0.26.0-preview.4        | yes            | yes             | no                          | [#4](https://github.com/simkimsia/axi-enforce/issues/4) |
| Qwen Code   | 0.23.0                  | yes            | yes             | no                          | [#5](https://github.com/simkimsia/axi-enforce/issues/5) |
| Cursor      | cursor-agent 2025.09.12 | yes            | yes             | no: this build has no hooks | [#1](https://github.com/simkimsia/axi-enforce/issues/1) |

| OS      | Unit/e2e tests        | Live agents               | Tracking                                                |
| ------- | --------------------- | ------------------------- | ------------------------------------------------------- |
| macOS   | yes (locally, and CI) | Claude Code only          |                                                         |
| Linux   | CI (ubuntu-latest)    | none yet                  |                                                         |
| Windows | CI (windows-latest)   | none: hook shells unknown | [#6](https://github.com/simkimsia/axi-enforce/issues/6) |

Live on macOS so far (2026-09-30, Claude Code): plain `gh api user` refused with the reason, `gh-axi api user`
allowed, a heredoc mentioning `gh`/`railway` allowed, `AXI_GAP` with a nonexistent issue refused. Each
[`docs/agents/`](docs/agents/) page lists exactly what was checked for that agent. Open `verification` issues
are the to-do list; the pass criteria are in each issue.

## Install

```sh
git clone https://github.com/simkimsia/axi-enforce
pnpm -C axi-enforce install
pnpm -C axi-enforce run build
pnpm add -g link:$PWD/axi-enforce     # puts `axi-enforce` on PATH (use a PATH shim, see "Operating systems")

axi-enforce install all               # every agent found on PATH; or: axi-enforce install claude
axi-enforce doctor                    # rules, which axis are active, install state per agent
```

Tell it which axis are yours, so it demands issues for those:

```jsonc
// ~/.config/axi-enforce/policy.json   (or $AXI_ENFORCE_POLICY)
{
  "owners": ["simkimsia"],
  "rules": [
    // add or override by `tool`; `only` limits a partial wrapper to some subcommands
    { "tool": "npm", "axi": "npm-axi", "repo": "SSBrouhard/npm-axi", "only": ["view", "search"] },
  ],
}
```

Default rules (each inactive until its axi is on PATH): `gh`→`gh-axi`, `railway`→`railway-axi`,
`netlify`→`netlify-axi`, `wrangler`→`cloudflare-axi`, `vercel`→`vercel-axi`.
`"replaceDefaults": true` drops them. `"truncation": false` turns off the truncated-output check.

Try a command without an agent:

```sh
axi-enforce check 'bash -lc "cd app && gh pr list"'
```

Remove: `axi-enforce uninstall all`. Installs are idempotent, keep your other hooks, and back
up each file they edit to `<file>.bak-axi-enforce`.

## What it catches

A small shell scanner, not a regex over the raw string. It finds the program wherever it
would **execute**:

- after `;` `&&` `||` `|` `&`, inside `$(...)`, backticks and `( )`, including `"$(...)"`
- after shell keywords: `for ...; do gh ...; done`, `if ...; then railway ...; fi`
- with redirections such as `2>&1`, `>&2` and `&>file` (not mistaken for `&`)
- behind `VAR=x`, `env`, `sudo`, `command`, `exec`, `time`, `timeout 5`, `xargs`, `nohup`
- behind `npx`, `bunx`, `uvx`, `pnpm dlx|exec`, `npm exec`, `yarn dlx`, `bun x`
- inside `bash -lc "..."` / `sh -c '...'` (Codex wraps commands like this), and argv arrays
- absolute and Windows paths: `/opt/homebrew/bin/gh`, `C:\tools\gh.exe`, `railway.cmd`

and ignores text that never runs: single-quoted strings, heredoc bodies (commit messages),
arguments (`grep gh`), and look-alikes (`gh-axi`, `ghq`).

It is a guardrail against habit, not a sandbox: `eval`, aliases, or a script file that calls
`gh` internally get through. It fails **open**: if the hook itself errors, the command runs,
so a bug here can never lock an agent out of its shell.

## Operating systems

CI runs the test suite on Linux, macOS and Windows (Node 20/22/24). Differences handled:

| Concern                 | How                                                                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finding the axi on PATH | exec-bit check on POSIX; `PATHEXT` suffixes (`.CMD` shims from pnpm/npm) on Windows                                                                                                                                              |
| Program names           | `gh.exe`, `GH.EXE`, `railway.cmd`, `C:\...\gh.exe` all resolve to the tool                                                                                                                                                       |
| Backslashes             | only an escape before a shell-special character, so Windows paths survive                                                                                                                                                        |
| Hook command line       | `axi-enforce hook <agent>` via the global PATH shim works in sh, cmd and PowerShell. Without a global install the installer writes an absolute `"node" "script"` line, which PowerShell does not run; `install` warns on Windows |
| OpenCode plugin         | spawns with `shell: true` (sh on POSIX, cmd.exe on Windows)                                                                                                                                                                      |
| Config locations        | all under the home directory on every OS (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.qwen`, `~/.cursor`, `~/.config/opencode`)                                                                                                    |

Windows is covered by CI unit and end-to-end tests but has not been exercised against live
agents yet ([#6](https://github.com/simkimsia/axi-enforce/issues/6)); reports welcome. If you use WSL,
install the axis and axi-enforce on the same side as the agent: each side has its own PATH, and a rule is
only enforced when its axi is found.

## Development

```sh
pnpm install && pnpm run build && pnpm test
```

`test/hook.e2e.test.ts` runs the built CLI with every agent's real payload shape, plus the
OpenCode plugin. Adding an agent = one adapter in `src/adapters/`, one entry in
`src/install.ts`, one page in `docs/agents/`, one row in the e2e table.

## License

MIT
