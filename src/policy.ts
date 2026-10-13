import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Rule {
  /** plain CLI to block, e.g. "gh" */
  tool: string;
  /** wrapper to use instead, e.g. "gh-axi"; the rule is inactive until it is on PATH */
  axi: string;
  /** "owner/name" of the axi's GitHub repo; gaps are filed here when owned */
  repo?: string;
  /** only block these first subcommands (e.g. ["view", "search"] for npm); default: all */
  only?: string[];
}

export interface Policy {
  /** GitHub login(s) whose axi repos you maintain: gaps there need an open issue to bypass */
  owners: string[];
  rules: Rule[];
  /** gap log path */
  log: string;
  /** refuse `<axi> ... | head|tail|cut` (truncated axi output); default true */
  truncation: boolean;
}

/** Wrappers that cover the whole CLI. Inactive unless the axi is installed. */
export const DEFAULT_RULES: Rule[] = [
  { tool: "gh", axi: "gh-axi", repo: "kunchenguid/gh-axi" },
  { tool: "railway", axi: "railway-axi", repo: "simkimsia/railway-axi" },
  { tool: "netlify", axi: "netlify-axi", repo: "simkimsia/netlify-axi" },
  { tool: "wrangler", axi: "cloudflare-axi", repo: "simkimsia/cloudflare-axi" },
  { tool: "vercel", axi: "vercel-axi", repo: "ardaatahan/vercel-axi" },
];

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg || join(homedir(), ".config"), "axi-enforce");
}

export function policyPath(): string {
  return process.env.AXI_ENFORCE_POLICY || join(configDir(), "policy.json");
}

function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg || join(homedir(), ".local", "state"), "axi-enforce");
}

interface PolicyFile {
  owners?: string[];
  /** replaces DEFAULT_RULES entirely when true */
  replaceDefaults?: boolean;
  rules?: Rule[];
  log?: string;
  truncation?: boolean;
}

/** Defaults, then the user file: user rules override defaults with the same `tool`. */
export function loadPolicy(path = policyPath()): Policy {
  let file: PolicyFile = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8")) as PolicyFile;
    } catch (err) {
      throw new Error(`axi-enforce: cannot parse ${path}: ${(err as Error).message}`);
    }
  }
  const byTool = new Map<string, Rule>();
  if (!file.replaceDefaults) for (const r of DEFAULT_RULES) byTool.set(r.tool, r);
  for (const r of file.rules ?? []) byTool.set(r.tool, r);
  return {
    owners: file.owners ?? [],
    rules: [...byTool.values()],
    log: file.log || join(stateDir(), "gaps.log"),
    truncation: file.truncation ?? true,
  };
}

export function isOwned(rule: Rule, policy: Policy): boolean {
  if (!rule.repo) return false;
  const owner = rule.repo.split("/")[0].toLowerCase();
  return policy.owners.some((o) => o.toLowerCase() === owner);
}
