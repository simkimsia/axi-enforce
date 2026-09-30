# Codex CLI

**Mechanism:** `PreToolUse` command hook (the hooks feature is `stable` and on by default in
0.156; see `codex features list`), matcher `^Bash$`, in `~/.codex/hooks.json` (or `[hooks]` in
`~/.codex/config.toml`, or a repo's `.codex/`).

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "^Bash$", "hooks": [{ "type": "command", "command": "axi-enforce hook codex", "timeout": 15 }] }
    ]
  }
}
```

- stdin: same shape as Claude Code; the command is `tool_input.command`. It may be an argv array such as
  `["bash","-lc","gh pr list"]`; axi-enforce turns it back into a command and looks inside `-c` scripts.
- deny: stdout `hookSpecificOutput.permissionDecision = "deny"` with `permissionDecisionReason` (exit 2 with
  the reason on stderr also works).
- timeout is in seconds.

**Trust step, required:** Codex skips new or changed user hooks until you approve them. After
`axi-enforce install codex`, open Codex and run `/hooks` to review and enable it. Managed hooks
(`requirements.toml`) are trusted by policy instead.

**Verified:** against codex-cli 0.156.1: `codex features list` (hooks stable/true), the
`pre-tool-use.command.input/output` schemas embedded in the binary, and the docs at
learn.chatgpt.com/docs/hooks (hooks.json shape, seconds). Payload handling is covered by
`test/hook.e2e.test.ts`. Not yet observed in a live Codex session.

**Secondary layer (optional):** execpolicy rules in `~/.codex/rules/*.rules`, checkable
offline with `codex execpolicy check --rules <file> gh pr list`:

```
prefix_rule(pattern=[["gh","railway","wrangler"]], decision="forbidden",
  justification="Use gh-axi / railway-axi / cloudflare-axi instead")
```

They match token prefixes only (no `bash -lc` look-inside, no `AXI_GAP` escape), so they are
a blunt backstop, not a replacement for the hook.

**Limitation:** input typed into an already-running interactive shell (`write_stdin`) does not
re-trigger `PreToolUse`.
