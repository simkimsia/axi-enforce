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
    ])("denies %s", (cmd) => {
      const { d } = deps();
      const r = decide(cmd, policy, d);
      expect(r.decision).toBe("deny");
      expect(r.reason).toMatch(/axi output is already compact/);
      expect(r.reason).toContain("AXI_TRUNCATE=1");
    });
    it.each([
      "gh-axi pr view 3 | grep state",
      "gh-axi pr list > out.txt; tail out.txt",
      "git log | head -5",
      "gh-axi pr list || tail x",
    ])("allows %s", (cmd) => {
      const { d } = deps();
      expect(decide(cmd, policy, d).decision).toBe("allow");
    });
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
