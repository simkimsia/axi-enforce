# Cursor (IDE agent and cursor-agent CLI)

**Mechanism:** `beforeShellExecution` hook in `~/.cursor/hooks.json` (project: `.cursor/hooks.json`).

```json
{ "version": 1, "hooks": { "beforeShellExecution": [{ "command": "axi-enforce hook cursor" }] } }
```

- stdin: `{"command":"...","cwd":"...", ...}`
- deny: stdout `{"permission":"deny","user_message":"...","agent_message":"..."}`. Field casing has
  changed across releases (`userMessage`/`agentMessage` in older posts), so axi-enforce emits both.
  Exit 2 also denies.

**Version caveat, important:** cursor-agent **2025.09.12 has no hook support at all**. Its bundle
contains no `hooks.json` / `beforeShellExecution` code, so the file is silently ignored. Current
builds (checked: 2026.09.28) run `beforeShellExecution`; the CLI fires only the shell events so
far. Update with `cursor-agent update`.

**Static fallback for old builds (fixed message only):** `~/.cursor/cli-config.json` (project
`.cursor/cli.json` files merge in):

```json
{
  "permissions": {
    "deny": ["Shell(gh)", "Shell(railway)", "Shell(wrangler)", "Shell(*/gh)", "Shell(*/railway)", "Shell(*/wrangler)"]
  }
}
```

Each `&&`/`;`/`|` sub-command is checked; an entry matches the first word, a `cmd ` prefix or a glob.
Deny wins over allow, even with `--force`. The model only sees "Blocked by permissions
configuration". It misses `env gh` and `bash -c "gh ..."`. It cannot express the `AXI_GAP` escape
(an `AXI_GAP=...` prefix happens to make the first word not match, but the issue is not checked).

**Verified:** by grepping the installed 2025.09.12 bundle (`shouldBlockShellCommand`,
`matchesShellEntry`, no hook code) and the Cursor hooks docs and forum (threads 148511, 148316).
Hook payload handling is covered by `test/hook.e2e.test.ts`. Not yet observed in a live session.
