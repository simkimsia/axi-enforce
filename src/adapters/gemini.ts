import { get, str, type Adapter } from "./types.js";

// Gemini CLI (BeforeTool) and Qwen Code (PreToolUse), matcher "run_shell_command".
// stdin: {"tool_name":"run_shell_command","tool_input":{"command":"..."}, ...}
// deny:  stdout {"decision":"deny","reason":"..."}, exit 0. The model sees the reason as the
//        tool's error ("Tool execution blocked: <reason>" / execution_denied).
export const gemini: Adapter = {
  name: "gemini",
  command(p) {
    return str(get(p, "tool_input", "command"));
  },
  render(d) {
    if (d.decision === "allow") return { exitCode: 0 };
    return { stdout: JSON.stringify({ decision: "deny", reason: d.reason }), exitCode: 0 };
  },
};

export const qwen: Adapter = { ...gemini, name: "qwen" };
