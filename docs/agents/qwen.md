# Qwen Code

Qwen Code forked from Gemini CLI but uses Claude Code's event names.

**Mechanism:** `PreToolUse` command hook, matcher `run_shell_command` (aliases `Shell` and
`Bash` also map to the shell tool), in `~/.qwen/settings.json`. On unless `disableAllHooks` is set
or in bare/safe mode.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "run_shell_command",
        "hooks": [{ "type": "command", "command": "axi-enforce hook qwen", "timeout": 15000 }]
      }
    ]
  }
}
```

- stdin: like Gemini plus `permission_mode` and `tool_use_id`; command at `tool_input.command`.
- deny: stdout `{"decision":"deny","reason":"..."}` (Claude-style `hookSpecificOutput` and exit 2 +
  stderr are also accepted). The reason becomes an `execution_denied` error on the tool result.
- timeout is in **milliseconds** (command hooks default to `6e4`).

**Verified:** against @qwen-code/qwen-code 0.23.0 bundle (`chunk-4F7GQGXB.js`: event names,
matcher aliases, decision handling, `DEFAULT_HOOK_TIMEOUT = 6e4`). Payload handling is covered by
`test/hook.e2e.test.ts`. Not yet observed in a live session.

**Static alternative (no custom message):**
`"permissions": {"deny": ["Bash(gh *)", "Bash(railway *)", "Bash(wrangler *)"]}`.
