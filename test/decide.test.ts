import { describe, expect, it } from "vitest";
import { decide, type Deps, type IssueState } from "../src/decide.js";
import type { Policy } from "../src/policy.js";

const policy: Policy = {
  owners: ["me"],
  log: "/dev/null",
  truncation: true,
  rules: [
    { tool: "gh", axi: "gh-axi", repo: "someone/gh-axi" },
    { tool: "railway", axi: "railway-axi", repo: "me/railway-axi" },
    { tool: "npm", axi: "npm-axi", repo: "x/npm-axi", only: ["view", "search"] },
    { tool: "fly", axi: "fly-axi", repo: "me/fly-axi" },
  ],
};

function deps(issues: Record<string, IssueState> = {}, installed = ["gh-axi", "railway-axi", "npm-axi"]) {
  const logged: string[] = [];
  const d: Deps = {
    onPath: (p) => installed.includes(p),
    issueState: (repo, num) => issues[`${repo}#${num}`] ?? "missing",
    log: (l) => logged.push(l),
    now: () => new Date("2026-01-01T00:00:00Z"),
  };
  return { d, logged };
}

describe("decide", () => {
  it("allows unrelated commands and the axi itself", () => {
    const { d } = deps();
    expect(decide("ls -la", policy, d).decision).toBe("allow");
    expect(decide("gh-axi pr list", policy, d).decision).toBe("allow");
  });

  it("denies the plain CLI when the axi is installed", () => {
    const { d } = deps();
    const r = decide("cd repo && gh pr list", policy, d);
    expect(r.decision).toBe("deny");
    expect(r.reason).toContain("gh-axi");
    expect(decide("x=$((gh pr list) | wc -l)", policy, d).decision).toBe("deny");
  });

  // #23: looking the CLI up or reading its files is not running it, so no AXI_GAP is needed
  it.each([
    "W=$(dirname $(readlink -f $(command -v railway))); ls $W/../dist",
    "REAL=$(command -v gh); echo $REAL",
    "which gh; type railway; whereis gh; hash railway",
    "grep -n deploy ~/node_modules/railway/dist/cli.js",
  ])("allows a lookup that never runs the CLI: %s", (cmd) => {
    const { d } = deps();
    expect(decide(cmd, policy, d).decision).toBe("allow");
  });

  it.each([
    "command railway up",
    "command -p gh pr list",
    "command -v gh && gh pr list",
    "$(command -v gh) pr list",
    "R=$(command -v railway); $R up",
  ])("still denies `command` that runs the CLI: %s", (cmd) => {
    const { d } = deps();
    expect(decide(cmd, policy, d).decision).toBe("deny");
  });

  it("stays out of the way when the axi is not installed", () => {
    const { d } = deps();
    expect(decide("fly deploy", policy, d).decision).toBe("allow");
  });

  it("honours `only` subcommand filters", () => {
    const { d } = deps();
    expect(decide("npm install", policy, d).decision).toBe("allow");
    expect(decide("npm view react", policy, d).decision).toBe("deny");
  });

  describe("axi maintained by someone else", () => {
    it("AXI_BYPASS=1 lets it through and logs it", () => {
      const { d, logged } = deps();
      expect(decide("AXI_BYPASS=1 gh repo create x --source .", policy, d).decision).toBe("allow");
      expect(logged[0]).toContain("bypass");
    });
    it("tells the agent to ask before filing upstream", () => {
      const { d } = deps();
      expect(decide("gh pr list", policy, d).reason).toMatch(/ask before filing/);
    });
  });

  describe("truncated axi output", () => {
    it.each([
      "gh-axi pr list | tail -2",
      "gh-axi repo view 2>&1 | head -8",
      "for r in a b; do gh-axi label create -R o/$r --name x 2>&1 | tail -2; done",
      "railway-axi status | grep env | cut -c1-40",
      "foo-axi list | head",
      // a truncator after a compound command (#8)
      "for r in a b; do gh-axi repo view $r; done | tail -2",
      "while read r; do gh-axi repo view $r; done < f | head",
      "until false; do gh-axi pr list; done | head",
      "if true; then gh-axi pr list; fi | head",
      "{ gh-axi pr list; } | head",
      "{ gh-axi pr list; echo; } | head",
      "(gh-axi pr list) | head",
      "(gh-axi pr list) |& head",
      "gh-axi pr list | (head -2)",
      "gh-axi pr list | ( (head -2) )",
      "(bash -lc 'gh-axi pr list') | head",
      "bash -lc 'gh-axi pr list' | head",
      "{ sh -c 'gh-axi pr list'; } | tail",
      "cd x && (gh-axi pr list; echo) | tail",
      "if true; then { gh-axi pr list; }; fi | cut -c1-9",
      "N=$((n+1)) gh-axi pr list | head",
      "x=(a b) gh-axi pr list | head",
      "gh-axi pr view $((n+1)) | head",
      "echo $((gh-axi pr list) | head)",
      "gh-axi pr list --limit $((n)) | tail",
      "gh-axi pr list | bash -c 'head -2'",
      'gh-axi pr list | sh -c "tail -1"',
      "N=$(( 1 + 2 )) gh-axi pr list | head",
    ])("denies %s", (cmd) => {
      const { d } = deps();
      const r = decide(cmd, policy, d);
      expect(r.decision).toBe("deny");
      expect(r.reason).toMatch(/axi output is already compact/);
      expect(r.reason).toContain("AXI_TRUNCATE=1");
    });
    it.each([
      "gh-axi pr view 3 | grep state",
      "git log | head -5",
      "gh-axi pr list || tail x",
      "gh-axi pr list; echo | head",
      "for r in a b; do gh-axi repo view $r; done; echo | head",
      "(gh-axi pr list); echo | head",
      "gh-axi pr list | bash -c 'cat'",
      // the pipe applies to echo's output; the axi output only reaches it as an argument
      "echo $(gh-axi pr list) | head",
      "$(gh-axi pr list) | head",
      "bash -c 'echo $(gh-axi pr list)' | head",
      "bash -c 'echo `gh-axi pr list`' | tail",
    ])("allows %s", (cmd) => {
      const { d } = deps();
      expect(decide(cmd, policy, d).decision).toBe("allow");
    });
    // output saved earlier in the same command line, then truncated (#16)
    it.each([
      ['out=$(gh-axi pr list); echo "$out" | head', "$out", "head"],
      ["out=$(gh-axi pr list) && echo $out | tail -3", "$out", "tail"],
      ['out="$(gh-axi pr list 2>&1)"; printf \'%s\\n\' "${out}" | cut -c1-40', "$out", "cut"],
      ['out=`gh-axi pr list`; head -3 <<< "$out"', "$out", "head"],
      ['local out=$(gh-axi pr list); echo "$out" | head', "$out", "head"],
      ['a=1 out=$(gh-axi pr list); echo "$out" | grep x | head', "$out", "head"],
      ['out=$(gh-axi pr list | grep open); echo "$out" | head', "$out", "head"],
      ['out=$(bash -c "gh-axi pr list"); echo "$out" | head', "$out", "head"],
      ["gh-axi pr list > out.txt; tail out.txt", "out.txt", "tail"],
      ["gh-axi pr list >> f; head -n 5 f", "f", "head"],
      ["gh-axi pr list > ./f 2>&1; head f", "f", "head"],
      ["gh-axi pr list &> f; tail f", "f", "tail"],
      ["gh-axi pr list >f && head <f", "f", "head"],
      ["gh-axi pr list > f; cat f | cut -c1-9", "f", "cut"],
      ["gh-axi pr list | grep x > f; head f", "f", "head"],
      ["{ gh-axi pr list; gh-axi issue list; } > f; tail f", "f", "tail"],
      ["(gh-axi pr list) > f; tail f", "f", "tail"],
      ["for r in a b; do gh-axi repo view $r; done > f; head f", "f", "head"],
      ["gh-axi pr list > f; (head f)", "f", "head"],
      ["bash -lc 'gh-axi pr list > f; tail f'", "f", "tail"],
      ["gh-axi pr list > f; bash -c 'head f'", "f", "head"],
      ["railway-axi status > f; tail f", "f", "tail"],
      ["gh-axi pr list > f; head -50 f | tail -10", "f", "tail"],
      ['out=$(gh-axi pr list); head -50 <<< "$out" | tail -5', "$out", "tail"],
      ["bash -c 'gh-axi pr list' > f; tail f", "f", "tail"],
    ])("denies saved output: %s", (cmd, where, cut) => {
      const { d } = deps();
      const r = decide(cmd, policy, d);
      expect(r.decision).toBe("deny");
      expect(r.reason).toContain(`saved in ${where} with ${cut}`);
      expect(r.reason).toMatch(/axi output is already compact/);
      expect(r.reason).toContain("AXI_TRUNCATE=1");
    });
    it.each([
      // legitimate log tailing (#16)
      "gh-axi run watch 9 > f; tail f",
      "gh-axi run watch 9 --exit-status >> ci.log 2>&1; tail -50 ci.log",
      'out=$(gh-axi run watch 9); echo "$out" | tail -20',
      // not an axi
      'out=$(git log); echo "$out" | head',
      "git log > f; head f",
      'out=`ls`; head -3 <<< "$out"',
      // saved, but not truncated, or something else truncated
      'out=$(gh-axi pr list); echo "$out"',
      'out=$(gh-axi pr list); echo "$out" | grep x',
      "gh-axi pr list > f; grep x f",
      "gh-axi pr list > f; cat f",
      'out=$(gh-axi pr list); echo "$output" | head',
      'a=1 out=$(gh-axi pr list); echo "$a" | head',
      "gh-axi pr list > f; head g",
      "gh-axi pr list > f; tail -n 3 notes.txt",
      // a value used as an argument, not printed: its output is git's
      'sha=$(gh-axi api repos/o/r --jq .sha); git show "$sha" | head',
      "gh-axi pr list > f; wc -l f | head",
      // stderr only, or discarded
      "gh-axi pr list 2> err; tail err",
      "gh-axi pr list > /dev/null; head /dev/null",
      // read before it was written
      "head f; gh-axi pr list > f",
      // capture and truncation in separate commands are out of scope
      "tail f",
      'echo "$out" | head',
    ])("allows %s", (cmd) => {
      const { d } = deps();
      expect(decide(cmd, policy, d).decision).toBe("allow");
    });
    it.each(['AXI_TRUNCATE=1 out=$(gh-axi pr list); echo "$out" | head', "gh-axi pr list > f; AXI_TRUNCATE=1 tail f"])(
      "AXI_TRUNCATE=1 lets saved output through and logs it: %s",
      (cmd) => {
        const { d, logged } = deps();
        expect(decide(cmd, policy, d).decision).toBe("allow");
        expect(logged[0]).toContain("truncate");
      },
    );
    it("AXI_TRUNCATE=1 lets it through and logs it", () => {
      const { d, logged } = deps();
      expect(decide("AXI_TRUNCATE=1 gh-axi run view 9 --log | tail -50", policy, d).decision).toBe("allow");
      expect(logged[0]).toContain("truncate");
    });
    it("can be switched off in the policy", () => {
      const { d } = deps();
      expect(decide("gh-axi pr list | tail -2", { ...policy, truncation: false }, d).decision).toBe("allow");
    });
  });

  it("does not let an escaped \\> hide a plain gh (#8)", () => {
    const { d } = deps();
    expect(decide("echo \\>& gh pr list", policy, d).decision).toBe("deny");
  });

  describe("axi you maintain", () => {
    it("AXI_BYPASS=1 is not enough", () => {
      const { d } = deps();
      expect(decide("AXI_BYPASS=1 railway up", policy, d).decision).toBe("deny");
    });
    it("denial explains how to file the gap", () => {
      const { d } = deps();
      const r = decide("railway up", policy, d);
      expect(r.reason).toContain("gh-axi issue create -R me/railway-axi");
      expect(r.reason).toContain("AXI_GAP=me/railway-axi#");
    });
    it("an open gap issue lets it through and logs the issue", () => {
      const { d, logged } = deps({ "me/railway-axi#7": "open" });
      expect(decide("AXI_GAP=me/railway-axi#7 railway up", policy, d).decision).toBe("allow");
      expect(logged[0]).toContain("me/railway-axi#7");
    });
    it.each([
      ["closed", /is closed/],
      ["missing", /is missing/],
      ["unknown", /could not be checked/],
    ] as const)("a %s issue is refused", (state, msg) => {
      const { d } = deps({ "me/railway-axi#7": state });
      const r = decide("AXI_GAP=me/railway-axi#7 railway up", policy, d);
      expect(r.decision).toBe("deny");
      expect(r.reason).toMatch(msg);
    });
    it("an issue on a different repo does not count", () => {
      const { d } = deps({ "me/other#7": "open" });
      expect(decide("AXI_GAP=me/other#7 railway up", policy, d).decision).toBe("deny");
    });
  });
});
