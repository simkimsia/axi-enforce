// End-to-end: run the built CLI (dist/) the way each agent does, with each agent's payload shape.
// Uses a fake PATH containing a stub `railway-axi` and `gh-axi`, and a temp policy file.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const BIN = resolve(__dirname, "..", "dist", "bin", "axi-enforce.js");
const PLUGIN = resolve(__dirname, "..", "plugins", "opencode", "axi-enforce.js");
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "axi-enforce-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const axi of ["railway-axi", "gh-axi"]) {
    const stub = join(bin, process.platform === "win32" ? `${axi}.cmd` : axi);
    writeFileSync(stub, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
    chmodSync(stub, 0o755);
  }
  const policy = join(dir, "policy.json");
  writeFileSync(policy, JSON.stringify({ owners: ["simkimsia"], log: join(dir, "gaps.log") }));
  env = { ...process.env, PATH: [bin, process.env.PATH].join(delimiter), AXI_ENFORCE_POLICY: policy };
});

function run(agent: string, payload: unknown) {
  const r = spawnSync(process.execPath, [BIN, "hook", agent], {
    input: JSON.stringify(payload),
    env,
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const claudeShape = (command: unknown) => ({ tool_name: "Bash", tool_input: { command } });
const geminiShape = (command: string) => ({ tool_name: "run_shell_command", tool_input: { command } });

describe.each([
  ["claude", claudeShape, (o: string) => JSON.parse(o).hookSpecificOutput.permissionDecision === "deny"],
  ["codex", claudeShape, (o: string) => JSON.parse(o).hookSpecificOutput.permissionDecision === "deny"],
  ["gemini", geminiShape, (o: string) => JSON.parse(o).decision === "deny"],
  ["qwen", geminiShape, (o: string) => JSON.parse(o).decision === "deny"],
  ["cursor", (command: string) => ({ command, cwd: "/tmp" }), (o: string) => JSON.parse(o).permission === "deny"],
  ["opencode", (command: string) => ({ command }), (o: string) => JSON.parse(o).decision === "deny"],
] as const)("%s", (agent, shape, denied) => {
  it("denies plain railway", () => {
    const r = run(agent, shape("cd app && railway up"));
    expect(r.code).toBe(0);
    expect(denied(r.out)).toBe(true);
    expect(r.out).toContain("gh-axi issue create -R simkimsia/railway-axi");
  });
  it("denies truncated axi output", () => {
    const r = run(agent, shape("gh-axi repo view 2>&1 | tail -2"));
    expect(r.code).toBe(0);
    expect(denied(r.out)).toBe(true);
    expect(r.out).toContain("AXI_TRUNCATE=1");
  });
  it("allows the axi", () => {
    const r = run(agent, shape("railway-axi status"));
    expect(r.code).toBe(0);
    expect(r.out === "" || !denied(r.out)).toBe(true);
  });
  it("fails open on garbage input", () => {
    const r = spawnSync(process.execPath, [BIN, "hook", agent], { input: "not json", env, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("allowing");
  });
});

it("codex argv arrays are understood", () => {
  const r = run("codex", claudeShape(["bash", "-lc", "gh pr list"]));
  expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision).toBe("deny");
});

// the plugin test builds a POSIX-shell command line
describe.skipIf(process.platform === "win32")("opencode plugin", () => {
  it("throws the reason for plain CLIs and passes the axi", async () => {
    process.env.AXI_ENFORCE_HOOK = `AXI_ENFORCE_POLICY='${env.AXI_ENFORCE_POLICY}' PATH='${env.PATH}' '${process.execPath}' '${BIN}' hook opencode`;
    const { AxiEnforce } = await import(PLUGIN);
    const hooks = await AxiEnforce();
    const before = hooks["tool.execute.before"];
    await expect(before({ tool: "bash" }, { args: { command: "gh pr list" } })).rejects.toThrow(/Use gh-axi/);
    await expect(before({ tool: "bash" }, { args: { command: "gh-axi pr list" } })).resolves.toBeUndefined();
    await expect(before({ tool: "read" }, { args: { filePath: "x" } })).resolves.toBeUndefined();
  });
});
