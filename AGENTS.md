# Project agent memory

Project-intrinsic knowledge for agents working on axi-enforce.

## What this is

A policy engine plus per-agent adapters that make coding agents use AXI wrappers
instead of the plain CLIs they wrap, with an issue-backed escape hatch for gaps.

## Architecture

- `src/parse.ts`: shell scanner that lists the programs a command string would
  execute. The contract is in `test/parse.test.ts`: both the "catches" table and the
  "ignores" table. Add a case to one of them before changing the scanner.
- `src/policy.ts`: default rules + `~/.config/axi-enforce/policy.json` (rules merge by
  `tool`). `owners` decides which axis need `AXI_GAP=` (issue) vs `AXI_BYPASS=1`.
- `src/decide.ts`: pure decision function; all I/O comes through `Deps`, so it is tested
  without PATH, network or disk.
- `src/deps.ts`: the real I/O: PATH lookup (PATHEXT on Windows), `gh api` issue
  state, gap log. The hook runs outside the agent, so calling plain `gh` here is fine.
- `src/adapters/`: one file per hook protocol: pull the command out of the payload,
  render a Decision back. Keep them tiny; logic belongs in `decide.ts`.
- `src/install.ts`: merges the hook into each agent's config; entries are recognised by
  the `axi-enforce` substring in the command. Idempotent, preserves other hooks, writes a
  `.bak-axi-enforce` backup.
- `plugins/opencode/axi-enforce.js`: OpenCode has no command hooks; this plugin pipes to
  `axi-enforce hook opencode` and throws the deny reason.

## Rules

- Fail open. Any error in the hook path allows the command and writes to stderr. A guard
  bug must never lock an agent out of its shell.
- Every agent-specific claim in `docs/agents/*.md` cites how it was verified (installed
  version, source file, or test). Update the page when an agent's hook format changes.
- The e2e suite (`test/hook.e2e.test.ts`) runs the built `dist/`; run `pnpm run build`
  before `pnpm test`.
- Cross-platform: no `/bin/sh`, no `:` PATH joins, no exec-bit assumptions outside
  `deps.ts`. CI runs ubuntu/macos/windows.
