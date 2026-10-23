import { describe, expect, it } from "vitest";
import { argvToCommand, flow, invocations, pipelines, redirects } from "../src/parse.js";

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
    ["N=$(( 1 + 2 )) gh pr list", ["gh"]],
    // an escaped `\>` is a literal, so the `&` backgrounds echo and gh runs (#8)
    ["echo \\>& gh pr list", ["echo", "gh"]],
    // `$((` that closes with a single `)` is a subshell inside `$(`, not arithmetic
    ["x=$((gh pr list) | wc -l); echo $x", ["echo", "gh", "wc"]],
    ["echo \\\\>& gh pr list", ["echo"]],
    ["f() { gh pr list; }", ["f", "gh", "}"]],
    // #23: launchers still run the program; only a lookup (`command -v`) does not
    ["wrangler deploy", ["wrangler"]],
    ["echo $(wrangler whoami)", ["echo", "wrangler"]],
    ["pnpm exec wrangler deploy", ["wrangler"]],
    ["bunx wrangler deploy", ["wrangler"]],
    ["env FOO=1 wrangler deploy", ["wrangler"]],
    ["command wrangler deploy", ["wrangler"]],
    ["command -p wrangler deploy", ["wrangler"]],
    ["builtin command wrangler deploy", ["wrangler"]],
    ["exec wrangler deploy", ["wrangler"]],
    ["/opt/homebrew/bin/wrangler deploy", ["wrangler"]],
    ["$HOME/Library/pnpm/wrangler deploy", ["wrangler"]],
    ["xargs wrangler kv key get", ["wrangler"]],
    ["time wrangler deploy", ["wrangler"]],
    ["nice -n 5 wrangler deploy", ["wrangler"]],
    ["command -v wrangler && wrangler deploy", ["command", "wrangler"]],
    // running what a lookup found runs the CLI
    ["$(command -v wrangler) deploy", ["_", "command", "wrangler"]],
    ['"$(command -v wrangler)" deploy', ["_", "command", "wrangler"]],
    ["exec `command -v gh` pr list", ["_", "command", "gh"]],
    ["W=$(command -v wrangler); $W deploy", ["command", "$W", "wrangler"]],
    ['W=$(command -v wrangler); "${W}" deploy', ["command", "${W}", "wrangler"]],
    // #26: lookups kept by local/export/declare, carried into `sh -c`, and in for-loop variables
    ...["export -n", "declare +x", "typeset +x", "declare +rx", "typeset +rx"].flatMap(
      (remove) => [
        [
          `export W=$(command -v gh); ${remove} W; $W pr list`,
          ["export", "command", remove.split(" ")[0], "$W", "gh"],
        ],
        [
          `export W=$(command -v gh); ${remove} W; export W; bash -c '$W pr list'`,
          ["export", "command", remove.split(" ")[0], "export", "bash", "$W", "gh"],
        ],
        [
          `export W=$(command -v gh); ${remove} W; W=$W bash -c '$W pr list'`,
          ["export", "command", remove.split(" ")[0], "bash", "$W", "gh"],
        ],
        [
          `export W=$(command -v gh); ${remove} W; bash -c "$W pr list"`,
          ["export", "command", remove.split(" ")[0], "bash", "gh"],
        ],
      ],
    ),
    ...["(export -n W)", "echo $(export -n W)", "echo `export -n W`"].map((scope) => [
      `export W=$(command -v gh); ${scope}; bash -c '$W pr list'`,
      ["export", "command", "export", ...(scope.includes("echo") ? ["echo"] : []), "bash", "$W", "gh"],
    ]),
    [
      "W=$(command -v gh); (export W; bash -c '$W pr list'); bash -c '$W pr list'",
      ["command", "export", "bash", "$W", "gh", "bash", "$W"],
    ],
    [
      "export W=$(command -v gh); (W=printf); bash -c '$W pr list'",
      ["export", "command", "bash", "$W", "gh"],
    ],
    ["local W=$(command -v wrangler); $W deploy", ["local", "command", "$W", "wrangler"]],
    ["export W=$(command -v wrangler); $W deploy", ["export", "command", "$W", "wrangler"]],
    ["declare -x W=$(command -v wrangler); $W deploy", ["declare", "command", "$W", "wrangler"]],
    // the caller expands a double-quoted `$W`, so the script runs wrangler itself
    ['W=$(command -v wrangler); sh -c "$W deploy"', ["command", "sh", "wrangler"]],
    ["export W=$(command -v wrangler); sh -c '$W deploy'", ["export", "command", "sh", "$W", "wrangler"]],
    ["for c in $(command -v wrangler); do $c deploy; done", ["for", "command", "$c", "wrangler", "done"]],
    ['W=$(command -v gh); export W="$W"; $W pr list', ["command", "export", "$W", "gh"]],
    ['W=$(command -v gh); local C="${W}"; $C pr list', ["command", "local", "$C", "gh"]],
    ['W=$(command -v gh); declare C="${W}"; $C pr list', ["command", "declare", "$C", "gh"]],
    ['W=$(command -v gh); typeset C="${W}"; $C pr list', ["command", "typeset", "$C", "gh"]],
    ['W=$(command -v gh); readonly C="${W}"; $C pr list', ["command", "readonly", "$C", "gh"]],
    ['W=$(command -v gh); C="$W"; $C pr list', ["command", "$C", "gh"]],
    ['W=$(command -v gh); for c in "$W"; do $c pr list; done', ["command", "for", "$c", "gh", "done"]],
    ["W=$(command -v gh); W=printf sh -c '$W hello'", ["command", "sh", "$W"]],
    ["W=$(command -v gh); W=printf sh -c '$W hello'; $W pr list", ["command", "sh", "$W", "$W", "gh"]],
    ['W=printf; W=$(command -v gh) sh -c "$W hello"', ["command", "sh", "_"]],
    ['W=$(command -v gh); W=printf sh -c "$W pr list"', ["command", "sh", "gh"]],
    ['W=$(command -v gh); W=printf sh -c "${W} pr list"', ["command", "sh", "gh"]],
    ['W=$(command -v gh); W=printf sh -c "\\$W hello"', ["command", "sh", "$W"]],
    ['W=printf; W=$(command -v gh) sh -c "\\$W pr list"', ["command", "sh", "$W", "gh"]],
    ["W=$(command -v gh); W=printf sh -c \"echo $W; \"'$W hello'", ["command", "sh", "echo", "$W"]],
    ["W=$(command -v wrangler 2>/dev/null); $W deploy", ["command", "$W", "wrangler"]],
  ])("%s", (cmd, want) => {
    expect(programs(cmd)).toEqual([...want].sort());
  });
});

describe("invocations: ignores text that never executes", () => {
  it.each([
    ...["export -n", "declare +x", "typeset +x", "declare +xr", "typeset +xr"].flatMap(
      (remove) => [
        [
          `W=$(command -v gh); ${remove} W; bash -c '$W pr list'`,
          ["command", remove.split(" ")[0], "bash", "$W"],
        ],
        [
          `export W=$(command -v gh); ${remove} W; bash -c '$W pr list'`,
          ["export", "command", remove.split(" ")[0], "bash", "$W"],
        ],
        [
          `export W=$(command -v gh); ${remove} W="$W"; bash -c '$W pr list'`,
          ["export", "command", remove.split(" ")[0], "bash", "$W"],
        ],
      ],
    ),
    ...["unset", "unset -v"].map((remove) => [
      `export W=$(command -v gh); ${remove} W; bash -c '$W pr list'`,
      ["export", "command", "unset", "bash", "$W"],
    ]),
    [
      "W=$(command -v gh); fn() { export W; }; bash -c '$W pr list'",
      ["command", "fn", "export", "}", "bash", "$W"],
    ],
    ...["'$W'", "'${W}'", "\\$W", '"\\$W"'].flatMap((value) => [
      [`W=$(command -v gh); ${value} pr list`, ["command", value.includes("{") ? "${W}" : "$W"]],
      ...["", "export ", "local ", "declare ", "typeset ", "readonly "].map((declaration) => [
        `W=$(command -v gh); ${declaration}C=${value}; $C pr list`,
        ["command", ...(declaration ? [declaration.trim()] : []), "$C"],
      ]),
      [
        `W=$(command -v gh); C=${value} bash -c '$C pr list'`,
        ["command", "bash", "$C"],
      ],
      [
        `W=$(command -v gh); for C in ${value}; do $C pr list; done`,
        ["command", "for", "$C", "done"],
      ],
    ]),
    ...["(export W)", "echo $(export W)", "echo `export W`", "(echo $(export W))"].map((scope) => [
      `W=$(command -v gh); ${scope}; bash -c '$W pr list'`,
      ["command", "export", ...(scope.includes("echo") ? ["echo"] : []), "bash", "$W"],
    ]),
    ["gh-axi pr list", ["gh-axi"]],
    ["grep gh file.txt", ["grep"]],
    ["echo 'gh api user; railway up'", ["echo"]],
    ['git commit -m "use gh; then railway"', ["git"]],
    // #23: a lookup or a path that only names the CLI never runs it
    ["command -v gh-axi", ["command"]],
    ["command -v wrangler", ["command"]],
    ["command -V railway", ["command"]],
    ["command -pv gh", ["command"]],
    ["builtin command -v gh", ["command"]],
    ["command -v mise asdf brew", ["command"]],
    ["which gh", ["which"]],
    ["type railway", ["type"]],
    ["type -a netlify", ["type"]],
    ["whereis supabase", ["whereis"]],
    ["hash wrangler", ["hash"]],
    ["REAL=$(command -v gh); echo $REAL", ["command", "echo"]],
    // #26: only the variable the lookup was assigned to holds it, and a later assignment replaces it
    ["d=$(date) W=$(command -v gh); $d", ["date", "command", "$d"]],
    ["W=$(command -v gh); W=ls; $W", ["command", "$W"]],
    ["for c in a b; do $c; done", ["for", "$c", "done"]],
    [
      "W=$(dirname $(readlink -f $(command -v wrangler))); ls $W/../wrangler-dist",
      ["command", "dirname", "ls", "readlink"],
    ],
    ["WR=$(dirname $(readlink -f $(which wrangler)))/..; ls $WR", ["dirname", "ls", "readlink", "which"]],
    ["ls -d $(pnpm root -g)/wrangler/wrangler-dist", ["ls", "pnpm"]],
    ["grep -n workers ~/Library/pnpm/global/5/node_modules/wrangler/wrangler-dist/cli.js", ["grep"]],
    ["cat ~/Projects/haze/wrangler.toml", ["cat"]],
    ["cat <<'EOF' > notes.md\ngh api user\nrailway up\nEOF\nls", ["cat", "ls"]],
    ["git commit -F - <<EOF\nfix: gh pr list broke\nEOF", ["git"]],
    ["cat <<< 'gh api'", ["cat"]],
    // `>&` here is a redirection: bash writes echo's output to a file named gh (#8)
    ["echo >& gh pr list", ["echo"]],
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
    ["sh -c 'wrangler deploy'", ["sh", "wrangler"]],
    // #23, seen in the gap log: the script only reads wrangler's installed files
    [
      "sh -c 'WR=$(dirname $(readlink -f $(command -v wrangler))); F=$WR/../wrangler-dist/cli.js; ls $F; grep -n \"entry-point file at\" $F'",
      ["sh", "command", "dirname", "readlink", "ls", "grep"],
    ],
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
    ["for r in a b; do gh-axi repo view $r 2>&1 | tail -2; done", [["gh-axi", "tail"]]],
    // a group piped onward is one stage holding everything run inside it (#8)
    ["for r in a b; do gh-axi repo view $r; done | tail -2", [["gh-axi"], ["gh-axi", "tail"]]],
    ["while read r; do gh-axi repo view $r; done < f | head", [["read"], ["gh-axi"], ["read", "gh-axi", "head"]]],
    ["if true; then gh-axi pr list; fi | head", [["true"], ["gh-axi"], ["true", "gh-axi", "head"]]],
    ["{ gh-axi pr list; echo; } | head", [["gh-axi"], ["echo"], ["gh-axi", "echo", "head"]]],
    ["(gh-axi pr list) | head", [["gh-axi"], ["gh-axi", "head"]]],
    ["(gh-axi pr list) 2>&1 |& head", [["gh-axi"], ["gh-axi", "head"]]],
    ["((gh-axi pr list)) | head", [["gh-axi"], ["gh-axi", "head"]]],
    ["gh-axi pr list | (head -2)", [["gh-axi", "head"]]],
    ["gh-axi pr list | ( (head -2) )", [["gh-axi", "head"]]],
    ["(bash -lc 'gh-axi pr list') | head", [["bash"], ["gh-axi"], ["bash", "gh-axi", "head"]]],
    ["bash -lc 'gh-axi pr list' | head", [["bash", "gh-axi", "head"], ["gh-axi"]]],
    ["bash -lc 'gh-axi pr list > f; tail f'", [["bash"], ["gh-axi"], ["tail"]]],
    ["gh-axi pr list | (cat) | head", [["gh-axi", "cat", "head"]]],
    ["gh-axi pr list | while read r; do echo $r; done", [["gh-axi", "read"], ["echo"]]],
    ["{ gh-axi pr list; } | grep x | cut -c1-9", [["gh-axi"], ["gh-axi", "grep", "cut"]]],
    ["gh-axi pr list; echo | head", [["gh-axi"], ["echo", "head"]]],
    ["N=$((n+1)) gh-axi pr list | head", [["gh-axi", "head"]]],
    ["gh-axi pr view $((n+(1))) | head", [["gh-axi", "head"]]],
    ["gh-axi pr list | bash -c 'head -2; tail x'", [["gh-axi", "bash", "head"], ["tail"]]],
    ["x=(a b) gh-axi pr list | head", [["a"], ["gh-axi", "head"]]],
    ["for r in a b; do gh-axi repo view $r; done; echo | head", [["gh-axi"], ["echo", "head"]]],
    // $(...) feeds an argument, not stdin, so it never joins the outer pipeline
    ["echo $(gh-axi pr list) | head", [["gh-axi"], ["echo", "head"]]],
    ['echo "$(gh-axi pr list | head -1)"', [["gh-axi", "head"], ["echo"]]],
    ["bash -lc 'gh-axi pr list | tail -3'", [["bash"], ["gh-axi", "tail"]]],
  ])("%s", (cmd, want) => {
    expect(lines(cmd)).toEqual(want);
  });
});

describe("redirects: stdout files and stdin sources", () => {
  it.each([
    [["x", ">", "f"], { plain: ["x"], inputs: [], outputs: ["f"] }],
    [["x", ">>f", "2>&1"], { plain: ["x"], inputs: [], outputs: ["f"] }],
    [["x", "1>", "f", "&>g", ">|h"], { plain: ["x"], inputs: [], outputs: ["f", "g", "h"] }],
    [["x", "2>", "err", ">&2"], { plain: ["x"], inputs: [], outputs: [] }],
    [["-3", "<", "f", "<<<", "$out"], { plain: ["-3"], inputs: ["f", "$out"], outputs: [] }],
    [["a>b", "-->"], { plain: ["a>b", "-->"], inputs: [], outputs: [] }],
  ])("%j", (ws, want) => {
    expect(redirects(ws)).toEqual(want);
  });
  it("leaves literal (quoted) words alone (#22)", () => {
    expect(redirects([">", "f", "x"], new Set([0]))).toEqual({ plain: [">", "f", "x"], inputs: [], outputs: [] });
  });
});

describe("flow: output saved within the command line (#16)", () => {
  const saved = (cmd: string) =>
    flow(cmd).captures.map((c) => [c.kind, c.name, c.from.map((i) => i.program).join(" | ")]);
  it.each([
    ["out=$(gh-axi pr list)", [["var", "out", "gh-axi"]]],
    ['out="$(gh-axi pr list | grep x)"; echo', [["var", "out", "gh-axi | grep"]]],
    ["out=`gh-axi pr list`", [["var", "out", "gh-axi"]]],
    ["local out=$(gh-axi pr list)", [["var", "out", "gh-axi"]]],
    ["a=1 out=$(gh-axi pr list)", [["var", "out", "gh-axi"]]],
    ["out=$(gh-axi pr list) gh-axi x", []],
    // #22: each assignment holds only the `$(...)` in its own word
    [
      "d=$(date) out=$(gh-axi pr list)",
      [
        ["var", "d", "date"],
        ["var", "out", "gh-axi"],
      ],
    ],
    ["tag=v_1 out=$(gh-axi pr list)", [["var", "out", "gh-axi"]]],
    [
      "local a=$(ls) out=`gh-axi pr list`",
      [
        ["var", "a", "ls"],
        ["var", "out", "gh-axi"],
      ],
    ],
    ['gh-axi issue create --title ">" f', []],
    ["gh-axi pr list \\> f", []],
    ["gh-axi pr list > ./f", [["file", "f", "gh-axi"]]],
    ["gh-axi pr list | grep x >> f", [["file", "f", "gh-axi | grep"]]],
    ["{ gh-axi a; gh-axi b; } > f", [["file", "f", "gh-axi | gh-axi"]]],
    ["(gh-axi a) &> f", [["file", "f", "gh-axi"]]],
    ["gh-axi a 2> f; gh-axi b > /dev/null", []],
    ["bash -c 'gh-axi a > f'", [["file", "f", "gh-axi"]]],
  ])("%s", (cmd, want) => {
    expect(saved(cmd)).toEqual(want);
  });
  it("orders captures against the invocations that read them", () => {
    const f = flow("head f; gh-axi a > f; tail f");
    const [head, , tail] = f.lines.map((l) => l[0]);
    const seq = f.captures[0].seq;
    expect(f.order.get(head)).toBeLessThan(seq);
    expect(f.order.get(tail)).toBeGreaterThanOrEqual(seq);
  });
});

it("argv arrays round-trip through argvToCommand", () => {
  expect(programs(argvToCommand(["bash", "-lc", "cd x && gh pr list"]))).toEqual(["bash", "cd", "gh"]);
});
