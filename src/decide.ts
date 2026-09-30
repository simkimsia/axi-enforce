import { invocations } from "./parse.js";
import { isOwned, type Policy, type Rule } from "./policy.js";

export type IssueState = "open" | "closed" | "missing" | "unknown";

export interface Deps {
  /** is this program on PATH? */
  onPath(program: string): boolean;
  /** state of an issue on GitHub */
  issueState(repo: string, num: number): IssueState;
  /** append one line to the gap log */
  log(line: string): void;
  now(): Date;
}

export type Decision = { decision: "allow"; reason?: undefined } | { decision: "deny"; reason: string; rule: Rule };

const ALLOW: Decision = { decision: "allow" };

function matches(rule: Rule, program: string, args: string[]): boolean {
  if (program !== rule.tool) return false;
  if (!rule.only) return true;
  const sub = args.find((a) => !a.startsWith("-"));
  return sub !== undefined && rule.only.includes(sub);
}

export function decide(command: string, policy: Policy, deps: Deps): Decision {
  const invs = invocations(command);
  for (const rule of policy.rules) {
    if (!invs.some((inv) => matches(rule, inv.program, inv.args))) continue;
    if (!deps.onPath(rule.axi)) continue;
    const verdict = judge(command, rule, policy, deps);
    if (verdict.decision === "deny") return verdict;
  }
  return ALLOW;
}

function judge(command: string, rule: Rule, policy: Policy, deps: Deps): Decision {
  const stamp = deps.now().toISOString();
  const oneLine = command.replace(/\s+/g, " ").slice(0, 400);
  const help = `Use ${rule.axi} instead of plain ${rule.tool}. Check \`${rule.axi} --help\` first.`;

  if (!isOwned(rule, policy)) {
    if (/(^|[\s;&|(])AXI_BYPASS=1(\s|$)/.test(command)) {
      deps.log(`${stamp}\t${rule.axi}\tbypass\t${oneLine}`);
      return ALLOW;
    }
    const where = rule.repo ? ` (${rule.repo})` : "";
    return {
      decision: "deny",
      rule,
      reason:
        `${help} ${rule.axi}${where} is maintained by someone else: if it genuinely lacks this operation, ` +
        `rerun the plain command prefixed with AXI_BYPASS=1, tell the user which operation was missing, ` +
        `and ask before filing anything upstream.`,
    };
  }

  const repo = rule.repo as string;
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const gap = command.match(new RegExp(`AXI_GAP=${escaped}#(\\d+)`, "i"));
  if (gap) {
    const num = Number(gap[1]);
    const state = deps.issueState(repo, num);
    if (state === "open") {
      deps.log(`${stamp}\t${rule.axi}\t${repo}#${num}\t${oneLine}`);
      return ALLOW;
    }
    const why = state === "unknown" ? "could not be checked (is gh installed and authenticated?)" : `is ${state}`;
    return {
      decision: "deny",
      rule,
      reason: `AXI_GAP points at ${repo}#${num}, which ${why}. File a new open issue on ${repo} for this gap and use its number.`,
    };
  }

  return {
    decision: "deny",
    rule,
    reason:
      `${help} If ${rule.axi} lacks this operation, or fails where plain ${rule.tool} works: ` +
      `(1) file the gap: \`gh-axi issue create -R ${repo} --title "<operation> not supported" --body "<the working ${rule.tool} command, what ${rule.axi} did or printed, the axi command you expected>"\`; ` +
      `(2) rerun the plain command prefixed with AXI_GAP=${repo}#<issue number>; ` +
      `(3) at the end of the task, give the user the issue link and offer to fix it in ${rule.axi}.`,
  };
}
