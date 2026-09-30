import { get, str, type Adapter } from "./types.js";

// Claude Code PreToolUse hook, matcher "Bash".
// stdin: {"tool_name":"Bash","tool_input":{"command":"..."}, ...}
// deny:  stdout hookSpecificOutput.permissionDecision = "deny"; the reason is shown to the model.
export const claude: Adapter = {
  name: "claude",
  command(p) {
    // the hook matcher already limits this to shell tools; don't second-guess tool_name
    return str(get(p, "tool_input", "command"));
  },
  render(d) {
    if (d.decision === "allow") return { exitCode: 0 };
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: d.reason,
        },
      }),
      exitCode: 0,
    };
  },
};
