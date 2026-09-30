import { spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { Deps, IssueState } from "./decide.js";

export function onPath(program: string): boolean {
  const win = process.platform === "win32";
  // Windows: no exec bit; a program is found by trying each PATHEXT suffix (pnpm/npm install .cmd shims)
  const exts = win ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")] : [""];
  const mode = win ? constants.F_OK : constants.X_OK;
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, program + ext), mode);
        return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}

/** Asks `gh api` (the hook runs outside the agent, so plain gh is fine here). */
export function issueState(repo: string, num: number): IssueState {
  const res = spawnSync("gh", ["api", `repos/${repo}/issues/${num}`, "--jq", ".state"], {
    encoding: "utf8",
    timeout: 8000,
  });
  if (res.error) return "unknown";
  const out = (res.stdout ?? "").trim();
  if (res.status === 0 && (out === "open" || out === "closed")) return out;
  if (/Not Found|HTTP 404|HTTP 410/.test(`${res.stdout}${res.stderr}`)) return "missing";
  return "unknown";
}

export function realDeps(logPath: string): Deps {
  return {
    onPath,
    issueState,
    log(line) {
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        appendFileSync(logPath, line + "\n");
      } catch {
        /* logging must never block the agent */
      }
    },
    now: () => new Date(),
  };
}
