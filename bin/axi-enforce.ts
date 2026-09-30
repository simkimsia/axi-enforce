#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { ADAPTERS } from "../src/adapters/index.js";
import { decide } from "../src/decide.js";
import { onPath, realDeps } from "../src/deps.js";
import { loadPolicy, policyPath } from "../src/policy.js";
import { AGENTS, install, uninstall } from "../src/install.js";
import { VERSION } from "../src/version.js";

const USAGE = `axi-enforce ${VERSION}: make coding agents use AXI wrappers instead of the plain CLIs

usage:
  axi-enforce install <agent|all> [--dry-run]   wire the hook into an agent's config
  axi-enforce uninstall <agent|all>             remove it again
  axi-enforce doctor                            show agents, active rules, install state
  axi-enforce check <command...>                what would happen to this shell command
  axi-enforce log                               show the gap/bypass log
  axi-enforce hook <agent>                      (called by the agent) read payload on stdin

agents: ${Object.keys(AGENTS).join(", ")}
policy: ${policyPath()}`;

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function hook(agent: string): number {
  const adapter = ADAPTERS[agent];
  if (!adapter) {
    process.stderr.write(`axi-enforce: no hook adapter for "${agent}"\n`);
    return 0; // fail open: never brick the agent's shell
  }
  try {
    const raw = readStdin();
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const command = adapter.command(payload);
    if (!command) return emit(adapter.render({ decision: "allow" }));
    const policy = loadPolicy();
    return emit(adapter.render(decide(command, policy, realDeps(policy.log))));
  } catch (err) {
    process.stderr.write(`axi-enforce: ${(err as Error).message} (allowing)\n`);
    return 0;
  }
}

function emit(out: { stdout?: string; stderr?: string; exitCode: number }): number {
  if (out.stdout) process.stdout.write(out.stdout + "\n");
  if (out.stderr) process.stderr.write(out.stderr + "\n");
  return out.exitCode;
}

function check(command: string): number {
  const policy = loadPolicy();
  const d = decide(command, policy, { ...realDeps(policy.log), log: () => {} });
  process.stdout.write(d.decision === "allow" ? "allow\n" : `deny: ${d.reason}\n`);
  return d.decision === "allow" ? 0 : 1;
}

function doctor(): number {
  const policy = loadPolicy();
  const lines = [`policy: ${policyPath()}${existsSync(policyPath()) ? "" : " (not found, defaults only)"}`];
  lines.push(`owners: ${policy.owners.join(", ") || "(none: every axi is treated as someone else's)"}`);
  lines.push(`log: ${policy.log}`, "", "rules:");
  for (const r of policy.rules) {
    const state = onPath(r.axi) ? "active" : `inactive (${r.axi} not on PATH)`;
    const only = r.only ? ` only ${r.only.join("/")}` : "";
    lines.push(`  ${r.tool}${only} -> ${r.axi}  ${state}`);
  }
  lines.push("", "agents:");
  for (const [name, a] of Object.entries(AGENTS)) {
    lines.push(`  ${name.padEnd(8)} ${onPath(a.binary) ? "found" : "not found"}  ${a.status()}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function log(): number {
  const { log } = loadPolicy();
  process.stdout.write(existsSync(log) ? readFileSync(log, "utf8") : `(empty: ${log})\n`);
  return 0;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const dry = rest.includes("--dry-run");
  const target = rest.find((a) => !a.startsWith("-"));
  switch (cmd) {
    case "hook":
      return hook(target ?? "");
    case "check":
      if (!rest.length) break;
      return check(rest.join(" "));
    case "install":
    case "uninstall": {
      if (!target) break;
      const names = target === "all" ? Object.keys(AGENTS).filter((n) => onPath(AGENTS[n].binary)) : [target];
      for (const n of names) {
        if (!AGENTS[n]) {
          process.stderr.write(`unknown agent "${n}"\n`);
          return 2;
        }
        const msg = cmd === "install" ? install(n, dry) : uninstall(n, dry);
        process.stdout.write(`${n}: ${msg}\n`);
      }
      return 0;
    }
    case "doctor":
      return doctor();
    case "log":
      return log();
    case "-v":
    case "-V":
    case "--version":
      process.stdout.write(VERSION + "\n");
      return 0;
  }
  process.stdout.write(USAGE + "\n");
  return cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h" ? 2 : 0;
}

process.exitCode = main(process.argv.slice(2));
