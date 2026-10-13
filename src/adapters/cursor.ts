import { get, str, type Adapter } from "./types.js";

// Cursor (IDE and cursor-agent CLI builds with hook support) beforeShellExecution hook.
// stdin: {"command":"...","cwd":"...", ...}
// stdout: {"permission":"allow"|"deny", "user_message", "agent_message"}; exit 2 also denies.
// Field casing changed across releases, so both snake_case and camelCase are emitted.
export const cursor: Adapter = {
  name: "cursor",
  command(p) {
    return str(get(p, "command"));
  },
  render(d) {
    if (d.decision === "allow") return { stdout: JSON.stringify({ permission: "allow" }), exitCode: 0 };
    const user = d.rule
      ? `axi-enforce: use ${d.rule.axi} instead of ${d.rule.tool}`
      : "axi-enforce: don't truncate axi output";
    return {
      stdout: JSON.stringify({
        permission: "deny",
        user_message: user,
        agent_message: d.reason,
        userMessage: user,
        agentMessage: d.reason,
      }),
      exitCode: 0,
    };
  },
};
