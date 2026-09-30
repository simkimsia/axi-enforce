import { get, str, type Adapter } from "./types.js";

// OpenCode has no command hooks; plugins/opencode/axi-enforce.js (a tool.execute.before plugin)
// pipes {"command": "..."} here and throws the reason, which the model receives as the bash
// tool's error result.
export const opencode: Adapter = {
  name: "opencode",
  command(p) {
    return str(get(p, "command"));
  },
  render(d) {
    return {
      stdout: JSON.stringify(d.decision === "allow" ? { decision: "allow" } : { decision: "deny", reason: d.reason }),
      exitCode: 0,
    };
  },
};
