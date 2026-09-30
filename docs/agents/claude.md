# Claude Code

**Mechanism:** `PreToolUse` command hook, matcher `Bash`, in `~/.claude/settings.json`
(or a project's `.claude/settings.json`).

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "axi-enforce hook claude", "timeout": 15 }] }
    ]
  }
}
```

- stdin: `{"tool_name":"Bash","tool_input":{"command":"..."}, ...}`
- deny: stdout `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`;
  the reason is returned to the model as the tool result.
- timeout is in seconds.

**Verified:** live, in a Claude Code session on macOS (2026-09-30): plain `gh api user` was
refused with the reason and `gh-axi api user` ran.

**Notes:** settings are reloaded when the file changes; if a new hook does not fire, open
`/hooks` once or restart.
