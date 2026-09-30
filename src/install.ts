import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { onPath } from "./deps.js";

// Every agent's entry is recognised by this marker in its command string.
const MARKER = "axi-enforce";

interface Agent {
  binary: string;
  status(): string;
  install(hook: string, dry: boolean): string;
  uninstall(dry: boolean): string;
}

const home = () => process.env.AXI_ENFORCE_HOME || homedir();

/** The command agents run. Absolute when possible, so agent PATHs don't matter. */
export function hookCommand(agent: string): string {
  if (onPath("axi-enforce")) return `axi-enforce hook ${agent}`;
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "axi-enforce.js");
  return `"${process.execPath}" "${script}" hook ${agent}`;
}

// ---------- JSON settings files with Claude-style { hooks: { Event: [ {matcher, hooks:[...]} ] } }

type Json = Record<string, unknown>;

function readJson(path: string): Json {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as Json;
  } catch (err) {
    throw new Error(`${path} is not plain JSON (${(err as Error).message}); edit it by hand, see docs/agents`);
  }
}

function writeJson(path: string, data: Json, dry: boolean): void {
  if (dry) return;
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.bak-axi-enforce`);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

interface Group {
  matcher?: string;
  hooks?: { command?: string }[];
}

function groups(data: Json, event: string): Group[] {
  const hooks = (data.hooks ??= {}) as Record<string, Group[]>;
  return (hooks[event] ??= []);
}

function hasOurs(g: Group): boolean {
  return (g.hooks ?? []).some((h) => h.command?.includes(MARKER));
}

function hookedEvent(path: string, event: string): boolean {
  const data = readJson(path);
  const list = ((data.hooks as Json | undefined)?.[event] ?? []) as Group[];
  return list.some(hasOurs);
}

function settingsAgent(opts: {
  binary: string;
  path: () => string;
  event: string;
  matcher: string;
  timeout: number;
  note?: string;
}): Agent {
  return {
    binary: opts.binary,
    status() {
      try {
        return hookedEvent(opts.path(), opts.event) ? `installed (${opts.path()})` : "not installed";
      } catch (err) {
        return (err as Error).message;
      }
    },
    install(hook, dry) {
      const path = opts.path();
      const data = readJson(path);
      const list = groups(data, opts.event);
      const entry = { type: "command", command: hook, timeout: opts.timeout };
      const existing = list.find(hasOurs);
      if (existing) existing.hooks = (existing.hooks ?? []).map((h) => (h.command?.includes(MARKER) ? entry : h));
      else list.push({ matcher: opts.matcher, hooks: [entry] });
      writeJson(path, data, dry);
      return `${dry ? "would write" : existing ? "updated" : "installed"} ${opts.event} hook in ${path}${opts.note ? `. ${opts.note}` : ""}`;
    },
    uninstall(dry) {
      const path = opts.path();
      if (!existsSync(path)) return "nothing to remove";
      const data = readJson(path);
      const hooks = data.hooks as Record<string, Group[]> | undefined;
      const list = hooks?.[opts.event];
      if (!list?.some(hasOurs)) return "nothing to remove";
      hooks![opts.event] = list
        .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !h.command?.includes(MARKER)) }))
        .filter((g) => g.hooks.length > 0);
      writeJson(path, data, dry);
      return `${dry ? "would remove" : "removed"} hook from ${path}`;
    },
  };
}

// ---------- Cursor: { version: 1, hooks: { beforeShellExecution: [ {command} ] } }

const cursorPath = () => join(home(), ".cursor", "hooks.json");
const cursor: Agent = {
  binary: "cursor-agent",
  status() {
    const list = ((readJson(cursorPath()).hooks as Json | undefined)?.beforeShellExecution ?? []) as {
      command?: string;
    }[];
    return list.some((h) => h.command?.includes(MARKER)) ? `installed (${cursorPath()})` : "not installed";
  },
  install(hook, dry) {
    const data = readJson(cursorPath());
    data.version ??= 1;
    const hooks = (data.hooks ??= {}) as Record<string, { command?: string }[]>;
    const list = (hooks.beforeShellExecution ??= []).filter((h) => !h.command?.includes(MARKER));
    list.push({ command: hook });
    hooks.beforeShellExecution = list;
    writeJson(cursorPath(), data, dry);
    return (
      `${dry ? "would write" : "installed"} beforeShellExecution hook in ${cursorPath()}. ` +
      `cursor-agent builds from before hook support ignore it: run \`cursor-agent update\`, or see docs/agents/cursor.md for the static deny-list fallback`
    );
  },
  uninstall(dry) {
    if (!existsSync(cursorPath())) return "nothing to remove";
    const data = readJson(cursorPath());
    const hooks = data.hooks as Record<string, { command?: string }[]> | undefined;
    const list = hooks?.beforeShellExecution;
    if (!list?.some((h) => h.command?.includes(MARKER))) return "nothing to remove";
    hooks!.beforeShellExecution = list.filter((h) => !h.command?.includes(MARKER));
    writeJson(cursorPath(), data, dry);
    return `${dry ? "would remove" : "removed"} hook from ${cursorPath()}`;
  },
};

// ---------- OpenCode: a plugin file

const opencodePath = () => join(home(), ".config", "opencode", "plugins", "axi-enforce.js");
const pluginSource = () =>
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "opencode", "axi-enforce.js");
const opencode: Agent = {
  binary: "opencode",
  status() {
    return existsSync(opencodePath()) ? `installed (${opencodePath()})` : "not installed";
  },
  install(hook, dry) {
    const src = readFileSync(pluginSource(), "utf8").replace(
      "__AXI_ENFORCE_HOOK__",
      hook.replace(/\\/g, "\\\\").replace(/"/g, '\\"'),
    );
    if (!dry) {
      mkdirSync(dirname(opencodePath()), { recursive: true });
      writeFileSync(opencodePath(), src);
    }
    return `${dry ? "would write" : "installed"} plugin ${opencodePath()} (restart opencode to load it)`;
  },
  uninstall(dry) {
    if (!existsSync(opencodePath())) return "nothing to remove";
    if (!dry) rmSync(opencodePath());
    return `${dry ? "would remove" : "removed"} ${opencodePath()}`;
  },
};

export const AGENTS: Record<string, Agent> = {
  claude: settingsAgent({
    binary: "claude",
    path: () => join(home(), ".claude", "settings.json"),
    event: "PreToolUse",
    matcher: "Bash",
    timeout: 15, // seconds
  }),
  codex: settingsAgent({
    binary: "codex",
    path: () => join(home(), ".codex", "hooks.json"),
    event: "PreToolUse",
    matcher: "^Bash$",
    timeout: 15, // seconds
    note: "Codex skips new hooks until you approve them: open codex and run /hooks once",
  }),
  opencode,
  gemini: settingsAgent({
    binary: "gemini",
    path: () => join(home(), ".gemini", "settings.json"),
    event: "BeforeTool",
    matcher: "run_shell_command",
    timeout: 15000, // milliseconds
  }),
  qwen: settingsAgent({
    binary: "qwen",
    path: () => join(home(), ".qwen", "settings.json"),
    event: "PreToolUse",
    matcher: "run_shell_command",
    timeout: 15000, // milliseconds
  }),
  cursor,
};

export function install(agent: string, dry: boolean): string {
  const msg = AGENTS[agent].install(hookCommand(agent), dry);
  // an absolute "node" "script" line is not a command in PowerShell; a PATH shim works everywhere
  const winWarning =
    process.platform === "win32" && !onPath("axi-enforce")
      ? " WARNING: axi-enforce is not on PATH; on Windows install it globally (pnpm add -g axi-enforce) and rerun install."
      : "";
  return msg + winWarning;
}

export function uninstall(agent: string, dry: boolean): string {
  return AGENTS[agent].uninstall(dry);
}
