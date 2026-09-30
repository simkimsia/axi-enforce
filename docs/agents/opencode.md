# OpenCode

**Mechanism:** OpenCode has no command hooks; it has JS/TS plugins. `axi-enforce install opencode`
copies [`plugins/opencode/axi-enforce.js`](../../plugins/opencode/axi-enforce.js) to
`~/.config/opencode/plugins/` (project: `.opencode/plugins/`; `plugin/` and `plugins/` both
load). Restart OpenCode after installing.

The plugin registers `tool.execute.before`. For `input.tool === "bash"` it pipes
`{"command": output.args.command}` to `axi-enforce hook opencode` and, on deny, **throws**. OpenCode
turns the thrown message into the bash tool's error result (`output-error`), so the model reads the
reason and the session continues.

**Verified:** against OpenCode 1.18.31 source (`session/tools.ts` runs the hook before execute
and before the permission check; `processor.ts` / `message-v2.ts` return the error text to the
model). `opencode debug config` lists the plugin, and a probe plugin confirmed it loads inside
OpenCode (`opencode serve`, `GET /experimental/tool/ids`). The plugin itself is covered by
`test/hook.e2e.test.ts`. Not yet observed in a live paid session.

**Static alternative (no custom message):** `permission.bash` in `opencode.json`, last match wins:

```json
{ "permission": { "bash": { "gh *": "deny", "railway *": "deny", "gh-axi *": "allow" } } }
```

It misses `FOO=1 gh`, `/opt/homebrew/bin/gh` and `npx wrangler`, and the model only gets a
generic "rule prevents this" message, so prefer the plugin.
