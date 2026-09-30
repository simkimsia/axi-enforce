# Gemini CLI

**Mechanism:** `BeforeTool` command hook, matcher `run_shell_command` (a regex on the tool
name), in `~/.gemini/settings.json`. On by default (`tools.enableHooks` and
`hooksConfig.enabled` both default true); Gemini labels hooks experimental. Project-level hooks
only run in trusted folders.

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "run_shell_command",
        "hooks": [{ "type": "command", "command": "axi-enforce hook gemini", "timeout": 15000 }]
      }
    ]
  }
}
```

- stdin: `{"tool_name":"run_shell_command","tool_input":{"command":"..."}, ...}`
- deny: stdout `{"decision":"deny","reason":"..."}`, exit 0 (exit 2 + stderr also works). The model
  sees `Tool execution blocked: <reason>`.
- timeout is in **milliseconds**.

**Verified:** against gemini-cli 0.26.0-preview.4: `config.js` (enable flags),
`hookRunner.js` (exit-2 / decision handling), `coreToolHookTriggers.js` (message to model), and by
running the real `HookRunner` from the installed package against a guard script. Payload handling
is covered by `test/hook.e2e.test.ts`.

**Static alternative (no custom message):** policy engine, `~/.gemini/policies/axi.toml`:

```toml
[[rule]]
toolName = "run_shell_command"
commandPrefix = ["gh", "railway", "wrangler"]
decision = "deny"
priority = 900
```

Prefix-only (misses `npx wrangler`); the model gets "Tool execution denied by policy." Do not add a
trailing space to prefixes.

**Note:** `settings.json` must be plain JSON for `axi-enforce install`; if yours has comments,
add the block above by hand.
