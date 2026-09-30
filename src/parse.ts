// Finds the programs a shell command string would invoke, without running it.
//
// Deliberately a small scanner, not a full shell parser. It must catch the
// plain CLI wherever it can execute (after ; && || |, inside $(...) and
// backticks, including inside double quotes, behind VAR=x / env / npx) and
// must NOT fire on text that never executes (single-quoted strings, heredoc
// bodies such as commit messages, arguments like `grep gh`).

export interface Invocation {
  /** basename of the program, e.g. "gh" for /opt/homebrew/bin/gh */
  program: string;
  /** remaining words, e.g. ["pr", "list"] */
  args: string[];
}

/** Launchers that run the next word as the real program. Value = flags that take an argument. */
const LAUNCHERS: Record<string, string[]> = {
  env: ["-u", "-C", "-S"],
  command: [],
  builtin: [],
  exec: ["-a"],
  sudo: ["-u", "-g", "-h", "-p", "-C"],
  doas: ["-u", "-C"],
  time: [],
  nohup: [],
  nice: ["-n"],
  timeout: ["-s", "-k"],
  xargs: ["-I", "-n", "-P", "-L", "-d", "-E", "-s"],
  npx: ["-p", "--package"],
  bunx: ["-p", "--package"],
  uvx: ["--from", "--with"],
};
/** Launchers that take positional arguments before the program: `timeout 5 gh`. */
const LAUNCHER_POSITIONALS: Record<string, number> = { timeout: 1 };
/** Two-word launchers: `pnpm dlx gh`, `npm exec gh`, ... */
const LAUNCHER_PAIRS: Record<string, string[]> = {
  pnpm: ["dlx", "exec"],
  npm: ["exec"],
  yarn: ["dlx", "exec"],
  bun: ["x"],
};

const SPECIAL = /[\s'"\\$`;&|()<>]/;

/** "C:\\bin\\gh.exe" / "/usr/bin/gh" -> "gh" (Windows is case-insensitive, so GH.EXE -> gh too) */
export function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  const bare = base.replace(/\.(exe|cmd|bat|ps1)$/i, "");
  return bare === base ? base : bare.toLowerCase();
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Drop heredoc bodies: everything after `<<EOF` up to the terminator line. */
export function stripHeredocs(cmd: string): string {
  const lines = cmd.split("\n");
  const out: string[] = [];
  let terminator: { word: string; dash: boolean } | null = null;
  for (const line of lines) {
    if (terminator) {
      const probe = terminator.dash ? line.replace(/^\t+/, "") : line;
      if (probe.trim() === terminator.word) terminator = null;
      continue;
    }
    out.push(line);
    // `<<<` is a here-string (single line), not a heredoc
    const m = line.match(/(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/);
    if (m) terminator = { word: m[3], dash: m[1] === "-" };
  }
  return out.join("\n");
}

/** Split into simple-command segments, following the contexts where code executes. */
export function segments(cmd: string): string[] {
  const src = stripHeredocs(cmd);
  const segs: string[] = [];
  // context stack: "root" | "sub" ($( or ( ) | "bt" (backtick) | "dq" | "sq"
  const stack: string[] = ["root"];
  // one text buffer per executable context; quoted text is appended to the enclosing buffer
  const bufs: string[] = [""];
  const top = () => stack[stack.length - 1];
  const flush = () => {
    const s = bufs[bufs.length - 1].trim();
    if (s) segs.push(s);
    bufs[bufs.length - 1] = "";
  };
  const push = (ctx: string) => {
    stack.push(ctx);
    bufs.push("");
  };
  const pop = () => {
    flush();
    stack.pop();
    bufs.pop();
  };
  const add = (c: string) => (bufs[bufs.length - 1] += c);

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const ctx = top();
    if (ctx === "sq") {
      add(c);
      if (c === "'") stack.pop();
      continue;
    }
    if (c === "\\" && i + 1 < src.length) {
      add(c + src[i + 1]);
      i++;
      continue;
    }
    if (c === "$" && src[i + 1] === "(" && src[i + 2] !== "(") {
      add("_"); // placeholder so `x=$(...)` stays one word in the outer segment
      push("sub");
      i++;
      continue;
    }
    if (c === "`") {
      if (ctx === "bt") pop();
      else {
        add("_");
        push("bt");
      }
      continue;
    }
    if (ctx === "dq") {
      add(c);
      if (c === '"') stack.pop();
      continue;
    }
    // executable context: root, sub, bt
    if (c === "'") {
      add(c);
      stack.push("sq");
      continue;
    }
    if (c === '"') {
      add(c);
      stack.push("dq");
      continue;
    }
    if (c === ")" && ctx === "sub") {
      pop();
      continue;
    }
    if (c === "(") {
      flush();
      push("sub");
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n") {
      flush();
      continue;
    }
    add(c);
  }
  while (bufs.length) {
    flush();
    bufs.pop();
  }
  return segs;
}

/** Whitespace split that keeps quoted runs together and strips the quotes. */
export function words(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
      continue;
    }
    // POSIX escape only before a special char; otherwise keep it (Windows paths: C:\bin\gh.exe)
    if (c === "\\" && i + 1 < segment.length && SPECIAL.test(segment[i + 1])) {
      cur += segment[++i];
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Peel assignments and launchers off a word list; returns the real program invocation. */
export function resolve(ws: string[]): Invocation | null {
  let i = 0;
  for (;;) {
    while (i < ws.length && ASSIGNMENT.test(ws[i])) i++;
    if (i >= ws.length) return null;
    const w = ws[i];
    const name = programName(w);
    const pair = LAUNCHER_PAIRS[name];
    if (pair && pair.includes(ws[i + 1] ?? "")) {
      i += 2;
      i = skipFlags(ws, i, []);
      continue;
    }
    const argFlags = LAUNCHERS[name];
    if (argFlags) {
      i = skipFlags(ws, i + 1, argFlags) + (LAUNCHER_POSITIONALS[name] ?? 0);
      continue;
    }
    return { program: name, args: ws.slice(i + 1) };
  }
}

function skipFlags(ws: string[], i: number, argFlags: string[]): number {
  while (i < ws.length && ws[i].startsWith("-")) {
    if (ws[i] === "--") return i + 1;
    if (argFlags.includes(ws[i])) i++;
    i++;
  }
  return i;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);

/** `bash -lc "<script>"` → the script; otherwise null. */
function shellScript(inv: Invocation): string | null {
  if (!SHELLS.has(inv.program)) return null;
  for (let i = 0; i < inv.args.length; i++) {
    const a = inv.args[i];
    if (/^-[a-z]*c[a-z]*$/i.test(a)) return inv.args[i + 1] ?? null;
    if (!a.startsWith("-")) return null;
  }
  return null;
}

export function invocations(cmd: string, depth = 0): Invocation[] {
  const out: Invocation[] = [];
  for (const seg of segments(cmd)) {
    const inv = resolve(words(seg));
    if (!inv) continue;
    out.push(inv);
    const script = depth < 4 ? shellScript(inv) : null;
    if (script) out.push(...invocations(script, depth + 1));
  }
  return out;
}

/** Turn an argv array (as some agents send) into a shell string with the same meaning. */
export function argvToCommand(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
