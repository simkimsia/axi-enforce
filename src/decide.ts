import { flow, invocations, redirects, samePath, type Capture, type Invocation } from "./parse.js";
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

export type Decision = { decision: "allow"; reason?: undefined } | { decision: "deny"; reason: string; rule?: Rule };

/** Programs that drop part of their input. */
const TRUNCATORS = new Set(["head", "tail", "cut"]);

const ALLOW: Decision = { decision: "allow" };

/** Saved axi output that is meant to be tailed: `gh-axi run watch 9 > f; tail f` follows a log (#16). */
const LOG_SOURCES: { program: string; sub: string[] }[] = [{ program: "gh-axi", sub: ["run", "watch"] }];

function isLog(inv: Invocation): boolean {
  const sub = inv.args.filter((a) => !a.startsWith("-"));
  return LOG_SOURCES.some((l) => l.program === inv.program && l.sub.every((w, i) => sub[i] === w));
}

/** Print a variable's value to stdout: `echo "$out" | head`. */
const PRINTERS = new Set(["echo", "printf"]);
/** Pass a file's content on to stdout (possibly filtered): `cat f | head`. */
const READERS = new Set(["cat", "grep", "sed", "awk", "jq", "sort", "uniq", "nl", "tac"]);

/**
 * Does `inv` feed the saved output into the truncating pipeline? The truncator itself reads it from
 * `< f`, `<<< "$out"` or a file argument (`head f`); an earlier stage prints it (`echo "$out"`,
 * `cat f`). A variable used as an argument (`git show $sha | head`) is not its output, so it is not counted.
 */
function feeds(inv: Invocation, c: Capture, truncator: boolean): boolean {
  const { plain, inputs } = redirects(inv.args);
  if (c.kind === "file") {
    if (!truncator && !READERS.has(inv.program)) return false;
    return [...plain, ...inputs].some((w) => samePath(w) === c.name);
  }
  const ws = truncator ? inputs : PRINTERS.has(inv.program) ? [...plain, ...inputs] : [];
  const ref = new RegExp(`\\$\\{?${c.name}(?![A-Za-z0-9_])`);
  return ws.some((w) => ref.test(w));
}

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
  if (policy.truncation) return truncation(command, policy, deps);
  return ALLOW;
}

/**
 * Axi output is already compact; `| head`, `| tail` or `| cut` hides fields, and an agent then
 * reports a field or operation as "missing" when it was only cut off.
 */
function truncation(command: string, policy: Policy, deps: Deps): Decision {
  const axis = new Set(policy.rules.map((r) => r.axi));
  const isAxi = (p: string) => axis.has(p) || p.endsWith("-axi");
  const { lines, captures, order } = flow(command);
  // output saved by an axi earlier in the same command line, then read by a pipeline that truncates
  const saved = captures.filter((c) => c.from.some((inv) => isAxi(inv.program)) && !c.from.some(isLog));
  for (const line of lines) {
    let found: { axi: string; cut: string; via?: Capture } | undefined;
    const at = line.findIndex((inv) => isAxi(inv.program));
    const cut = at < 0 ? undefined : line.slice(at + 1).find((inv) => TRUNCATORS.has(inv.program));
    if (cut) found = { axi: line[at].program, cut: cut.program };
    let last = line.length - 1;
    while (last >= 0 && !TRUNCATORS.has(line[last].program)) last--;
    for (let i = 0; !found && i <= last; i++) {
      const via = saved.find((c) => (order.get(line[i]) ?? -1) >= c.seq && feeds(line[i], c, i === last));
      const axi = via?.from.find((inv) => isAxi(inv.program));
      if (via && axi) found = { axi: axi.program, cut: line[last].program, via };
    }
    if (!found) continue;
    const { axi, via } = found;
    if (/(^|[\s;&|(])AXI_TRUNCATE=1(\s|$)/.test(command)) {
      deps.log(`${deps.now().toISOString()}\t${axi}\ttruncate\t${command.replace(/\s+/g, " ").slice(0, 400)}`);
      return ALLOW;
    }
    const what = !via
      ? `pipe ${axi} through ${found.cut}`
      : `truncate ${axi} output saved in ${via.kind === "var" ? `$${via.name}` : via.name} with ${found.cut}`;
    const rerun = !via ? `Rerun without \`| ${found.cut}\` and read all of it` : `Read all of the saved output instead`;
    return {
      decision: "deny",
      reason:
        `Don't ${what}: axi output is already compact, and truncating it hides fields, ` +
        `so nothing can be concluded "missing" from what is left. ${rerun}, ` +
        `or \`grep\` for the field you need. If you only want part of a long output on purpose (e.g. CI logs), ` +
        `prefix the command with AXI_TRUNCATE=1, and never report a gap from truncated output.`,
    };
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
