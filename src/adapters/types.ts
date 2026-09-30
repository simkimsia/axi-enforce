import type { Decision } from "../decide.js";
import { argvToCommand } from "../parse.js";

/** Translates one agent's hook protocol to and from a shell command + Decision. */
export interface Adapter {
  name: string;
  /** Pull the shell command out of the hook payload; null = not a shell call, allow. */
  command(payload: unknown): string | null;
  /** What the hook prints and how it exits. */
  render(decision: Decision): { stdout?: string; stderr?: string; exitCode: number };
}

export function get(obj: unknown, ...path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  // some agents pass argv arrays, e.g. ["bash", "-lc", "gh pr list"]
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return argvToCommand(v);
  return null;
}
