// axi-enforce plugin for OpenCode (https://opencode.ai/docs/plugins).
// Installed by `axi-enforce install opencode` into ~/.config/opencode/plugins/.
// Every bash call is checked by the axi-enforce CLI; a deny is thrown, and the thrown message
// becomes the tool's error result, so the model reads the reason and retries with the axi.
import { spawnSync } from "node:child_process";

// replaced at install time with an absolute command; falls back to PATH lookup
const HOOK = process.env.AXI_ENFORCE_HOOK || "__AXI_ENFORCE_HOOK__";

export const AxiEnforce = async () => ({
  "tool.execute.before": async (input, output) => {
    if (input.tool !== "bash") return;
    const command = output?.args?.command;
    if (typeof command !== "string" || !command) return;
    const cmd = HOOK.startsWith("__") ? "axi-enforce hook opencode" : HOOK;
    // shell: true = /bin/sh on POSIX, cmd.exe on Windows
    const res = spawnSync(cmd, {
      shell: true,
      input: JSON.stringify({ command }),
      encoding: "utf8",
      timeout: 15000,
    });
    if (res.error || res.status !== 0) return; // fail open: never brick the agent's shell
    let verdict;
    try {
      verdict = JSON.parse(res.stdout);
    } catch {
      return;
    }
    if (verdict?.decision === "deny") throw new Error(`axi-enforce: ${verdict.reason}`);
  },
});
