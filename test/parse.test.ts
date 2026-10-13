import { describe, expect, it } from "vitest";
import { argvToCommand, invocations, pipelines } from "../src/parse.js";

// order is irrelevant to enforcement (inner $(...) is emitted first), so compare sorted
const programs = (cmd: string) =>
  invocations(cmd)
    .map((i) => i.program)
    .sort();

describe("invocations: catches the CLI wherever it executes", () => {
  it.each([
    ["gh pr list", ["gh"]],
    ["/opt/homebrew/bin/gh api user", ["gh"]],
    ["cd x && gh pr list", ["cd", "gh"]],
    ["ls; gh api user", ["ls", "gh"]],
    ["git log | gh gist create", ["git", "gh"]],
    ["sha=$(gh api repos/o/r --jq .sha)", ["gh"]],
    ['echo "$(gh api user)"', ["echo", "gh"]],
    ["echo `gh api user`", ["echo", "gh"]],
    ["(gh api user)", ["gh"]],
    ["GH_HOST=x gh pr list", ["gh"]],
    ["env GH_TOKEN=1 gh pr list", ["gh"]],
    ["sudo -u bob railway up", ["railway"]],
    ["npx wrangler deploy", ["wrangler"]],
    ["npx -y wrangler deploy", ["wrangler"]],
    ["pnpm dlx wrangler deploy", ["wrangler"]],
    ["npm exec -- wrangler deploy", ["wrangler"]],
    ["bunx netlify status", ["netlify"]],
    ["xargs -n1 gh issue view", ["gh"]],
    ["timeout 5 gh api user", ["gh"]],
    ["C:\\tools\\gh.exe pr list", ["gh"]],
    ["GH.EXE pr list", ["gh"]],
    ["& 'C:\\Program Files\\GitHub CLI\\gh.exe' api user", ["gh"]],
    ["railway.cmd up; echo done", ["railway", "echo"]],
    ["for r in a b; do gh pr list; done", ["for", "gh", "done"]],
    ["if true; then railway up; fi", ["true", "railway", "fi"]],
    ["gh api user 2>&1 | cat", ["gh", "cat"]],
    ["gh api user &> out.txt; ls", ["gh", "ls"]],
  ])("%s", (cmd, want) => {
    expect(programs(cmd)).toEqual([...want].sort());
  });
});

describe("invocations: ignores text that never executes", () => {
  it.each([
    ["gh-axi pr list", ["gh-axi"]],
    ["grep gh file.txt", ["grep"]],
    ["echo 'gh api user; railway up'", ["echo"]],
    ['git commit -m "use gh; then railway"', ["git"]],
    ["command -v gh-axi", ["gh-axi"]],
    ["cat <<'EOF' > notes.md\ngh api user\nrailway up\nEOF\nls", ["cat", "ls"]],
    ["git commit -F - <<EOF\nfix: gh pr list broke\nEOF", ["git"]],
    ["cat <<< 'gh api'", ["cat"]],
  ])("%s", (cmd, want) => {
    expect(programs(cmd)).toEqual([...want].sort());
  });
});

it("keeps the subcommand args", () => {
  expect(invocations("npm view react version")[0]).toEqual({ program: "npm", args: ["view", "react", "version"] });
});

describe("shell -c scripts are parsed too", () => {
  it.each([
    ['bash -lc "gh issue list"', ["bash", "gh"]],
    ["sh -c 'cd x && railway up'", ["sh", "cd", "railway"]],
    ['zsh -c "echo \\"$(gh api user)\\""', ["zsh", "echo", "gh"]],
  ])("%s", (cmd, want) => {
    expect(programs(cmd)).toEqual([...want].sort());
  });
});

describe("pipelines: which programs share a pipe", () => {
  const lines = (cmd: string) => pipelines(cmd).map((l) => l.map((i) => i.program));
  it.each([
    ["gh-axi pr list | tail -2", [["gh-axi", "tail"]]],
    ["gh-axi pr list 2>&1 | head -5", [["gh-axi", "head"]]],
    ["gh-axi pr list |& tail", [["gh-axi", "tail"]]],
    ["gh-axi pr list || tail x", [["gh-axi"], ["tail"]]],
    ["gh-axi pr list; tail x", [["gh-axi"], ["tail"]]],
    ["gh-axi pr list | grep x | cut -c1-9", [["gh-axi", "grep", "cut"]]],
    ["for r in a b; do gh-axi repo view $r 2>&1 | tail -2; done", [["for"], ["gh-axi", "tail"], ["done"]]],
    ['echo "$(gh-axi pr list | head -1)"', [["gh-axi", "head"], ["echo"]]],
    ["bash -lc 'gh-axi pr list | tail -3'", [["bash"], ["gh-axi", "tail"]]],
  ])("%s", (cmd, want) => {
    expect(lines(cmd)).toEqual(want);
  });
});

it("argv arrays round-trip through argvToCommand", () => {
  expect(programs(argvToCommand(["bash", "-lc", "cd x && gh pr list"]))).toEqual(["bash", "cd", "gh"]);
});
