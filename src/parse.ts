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

/** Shell reserved words that can sit in front of a command: `do gh pr list`, `then railway up`. */
const RESERVED = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{"]);

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

/** One simple command. `pipe`: its stdout feeds the next segment in the same context (`|`, `|&`). */
export interface Segment {
  text: string;
  pipe: boolean;
  /** id of the executable context (root, a `$(...)`, a backtick, a `( )`) it was found in */
  ctx: number;
  /** set when `ctx` is a `( )` subshell: the id of the context around it */
  parent?: number;
  /** set when this segment closes a `( )` subshell (`(...) | head`): that subshell's context id */
  group?: number;
  /** an empty marker: the `( )` subshell `ctx` opens here, so a pipe into it can follow in order */
  opens?: boolean;
  /** ids of the `$(...)` / backtick contexts inside this segment; they ran before it, reading its stdin */
  subs?: number[];
}

/** `case WORD in` at command position: the patterns that follow are not commands. */
const CASE_HEAD = /^\s*(?:(?:!|\{|then|do|else|elif|if|while|until)\s+)*case\s+\S+\s+in$/;
/** `name` or `function name` right before `()`: a function definition. */
const FUNC_HEAD = /^\s*(?:function\s+)?([\w.:+@-]+)\s*$/;

/** Split into simple-command segments, following the contexts where code executes. */
export function segments(cmd: string): string[] {
  return scan(cmd)
    .map((s) => s.text)
    .filter((t) => t);
}

/** `>` or `<` at the end of `buf`, not escaped: the `&` after it belongs to a redirection (`2>&1`). */
function endsInRedirect(buf: string): boolean {
  const m = buf.match(/(\\*)[<>]$/);
  return m !== null && m[1].length % 2 === 0;
}

/** The `(` at `open` closes with `))`: `$((n+1))` is arithmetic, `$((cmd) | x)` a subshell in `$(`. */
function arithmetic(src: string, open: number): boolean {
  if (src[open] !== "(") return false;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src[i + 1] === ")";
  }
  return false;
}

/** Like `segments`, with pipe links and context ids, so pipelines can be rebuilt. */
export function scan(cmd: string): Segment[] {
  const src = stripHeredocs(cmd);
  const segs: Segment[] = [];
  // context stack: "root" | "sub" ($(...)) | "grp" (a `( )` subshell) | "bt" (backtick) | "dq" | "sq"
  // | "ar" (arithmetic `$((...))`) | "ap" (a parenthesis inside it)
  const stack: string[] = ["root"];
  // one text buffer per executable context; quoted text is appended to the enclosing buffer
  const bufs: string[] = [""];
  const ids: number[] = [0];
  // per buffer: the parent id when the context is a `( )` subshell
  const parents: (number | undefined)[] = [undefined];
  // per buffer: a `( )` subshell that just closed in it, so the next flush carries it even if empty
  const closed: (number | undefined)[] = [undefined];
  // per buffer: `$(...)` / backtick contexts opened in the current segment
  const subs: number[][] = [[]];
  // per buffer: open `case` statements, and whether a pattern (`a|b)`) is being read
  const cases: number[] = [0];
  const inPat: boolean[] = [false];
  let nextId = 1;
  const top = () => stack[stack.length - 1];
  const flush = (pipe = false) => {
    const k = bufs.length - 1;
    const s = bufs[k].trim();
    const group = closed[k];
    if (s || group !== undefined) {
      const seg: Segment = { text: s, pipe, ctx: ids[k] };
      if (parents[k] !== undefined) seg.parent = parents[k];
      if (group !== undefined) seg.group = group;
      if (subs[k].length) seg.subs = subs[k];
      segs.push(seg);
      if (/^esac\b/.test(s) && cases[k] > 0) cases[k]--;
    }
    bufs[k] = "";
    closed[k] = undefined;
    subs[k] = [];
  };
  const push = (ctx: string) => {
    const parent = ids[ids.length - 1];
    if (ctx !== "grp") subs[subs.length - 1].push(nextId);
    stack.push(ctx);
    bufs.push("");
    ids.push(nextId++);
    parents.push(ctx === "grp" ? parent : undefined);
    closed.push(undefined);
    subs.push([]);
    cases.push(0);
    inPat.push(false);
    if (ctx === "grp") segs.push({ text: "", pipe: false, ctx: ids[ids.length - 1], parent, opens: true });
  };
  const pop = () => {
    flush();
    const kind = stack.pop();
    bufs.pop();
    const id = ids.pop();
    parents.pop();
    closed.pop();
    subs.pop();
    cases.pop();
    inPat.pop();
    if (kind === "grp") closed[closed.length - 1] = id;
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
    if (c === "$" && src[i + 1] === "(" && arithmetic(src, i + 2)) {
      // arithmetic `$((...))` is part of the word, not a subshell
      add("$((");
      stack.push("ar");
      i += 2;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
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
    if (ctx === "ar" || ctx === "ap") {
      add(c);
      if (c === "(") stack.push("ap");
      else if (c === ")" && ctx === "ap") stack.pop();
      else if (c === ")" && src[i + 1] === ")") {
        add(")");
        i++;
        stack.pop();
      }
      continue;
    }
    // executable context: root, sub, bt
    const k = bufs.length - 1;
    if (inPat[k]) {
      // a case pattern never runs: `a|b)` is one pattern, not a pipe
      if (/^\s*esac$/.test(bufs[k]) && /[\s;&|)]/.test(c)) inPat[k] = false;
      else if (c === ")") {
        bufs[k] = "";
        inPat[k] = false;
        continue;
      } else if (/\s/.test(c) && !bufs[k].trim()) continue;
      else if (c === "(" || c === "|") {
        add(c);
        continue;
      }
    }
    if (/\s/.test(c) && CASE_HEAD.test(bufs[k])) {
      flush();
      cases[k]++;
      inPat[k] = true;
      continue;
    }
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
    if (c === ")" && (ctx === "sub" || ctx === "grp")) {
      pop();
      continue;
    }
    if (c === "(") {
      const fn = bufs[k].match(FUNC_HEAD);
      const close = src.slice(i + 1).match(/^\s*\)/);
      if (fn && close) {
        // `f()` and `function f()` both read as `function f`
        bufs[k] = `function ${fn[1]} `;
        i += close[0].length;
        continue;
      }
      flush();
      push("grp");
      continue;
    }
    // `2>&1`, `>&2`, `&>file`: part of a redirection, not a separator. An escaped `\>` is a
    // literal character, so `echo \>& gh` still runs gh in the background.
    if (c === "&" && (endsInRedirect(bufs[bufs.length - 1]) || src[i + 1] === ">")) {
      add(c);
      continue;
    }
    if (c === "|") {
      if (src[i + 1] === "|") {
        flush(); // `||`: a new command, not a pipe
        i++;
      } else {
        flush(true);
        if (src[i + 1] === "&") i++; // `|&` pipes stderr too
      }
      continue;
    }
    if (c === ";" && cases[k] > 0 && (src[i + 1] === ";" || src[i + 1] === "&")) {
      // `;;`, `;&`, `;;&` end a case item; a pattern comes next
      flush();
      i += src[i + 1] === ";" && src[i + 2] === "&" ? 2 : 1;
      inPat[k] = true;
      continue;
    }
    if (c === ";" || c === "&" || c === "\n") {
      flush();
      continue;
    }
    add(c);
  }
  while (bufs.length) {
    flush();
    bufs.pop();
    ids.pop();
    parents.pop();
    closed.pop();
    subs.pop();
    cases.pop();
    inPat.pop();
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
    // arithmetic `$(( 1 + 2 ))` is one word, spaces and all
    if (c === "$" && segment.startsWith("((", i + 1)) {
      let depth = 0;
      let j = i + 1;
      for (; j < segment.length; j++) {
        if (segment[j] === "(") depth++;
        else if (segment[j] === ")" && --depth === 0) break;
      }
      cur += segment.slice(i, j + 1);
      has = true;
      i = j;
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
    while (i < ws.length) {
      if (ASSIGNMENT.test(ws[i]) || RESERVED.has(ws[i])) i++;
      else if (ws[i] === "function")
        i += 2; // `function f { ...`: the body is the command
      else break;
    }
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

/** Words that open a compound command: `{ ...; }`, `if ...; fi`, loops `...; done`, `case ... esac`. */
const OPENERS = new Set(["{", "if", "while", "until", "for", "select", "case"]);
/** `for x in a b`, `case x in`: the rest of the segment is a word list, not a command. */
const HEADERS = new Set(["for", "select", "case"]);
/** A word that starts a redirection: `>f`, `2>&1`, `&>f`, `<f`. */
const REDIRECTION = /^(\d+|&)?[<>]/;
/** Words that close a compound command. A `|` after them pipes the whole group's output. */
const CLOSERS = new Set(["}", "fi", "done", "esac"]);

/** Redirections that send stdout to a file (`> f`, `>> f`, `&> f`, `>&2`), so no pipe gets it. `2>&1` doesn't. */
function stdoutAway(ws: string[]): boolean {
  return ws.some((w, i) => {
    const m = w.match(/^(?:1|&)?>>?(.*)$/);
    return m !== null && (m[1] || ws[i + 1]) !== "&1";
  });
}

interface Frame {
  /** index into the context's members where the group starts */
  start: number;
  /** index into the context's `all` list where the group starts */
  allStart: number;
  /** the pipeline piped into the group, if any (`x | while read r; do ...; done`) */
  feed?: Invocation[];
  /** set when the group is the body of `function <fn>` */
  fn?: string;
}

/** A function body: commands whose stdout is the call's stdout, and commands in its `$(...)`. */
interface Body {
  writes: Invocation[];
  reads: Invocation[];
}

/** Per pipeline: invocations that read its stdin but write elsewhere (`x | echo "$(head)"` -> head). */
const READ_ONLY = new WeakMap<Invocation[], Set<Invocation>>();

/** Does `inv` only read this pipeline, so its own output never flows down it? */
export function readsOnly(line: Invocation[], inv: Invocation): boolean {
  return READ_ONLY.get(line)?.has(inv) ?? false;
}

/**
 * The pipelines in a command, as lists of invocations joined by `|`, in order.
 * `a | b; c` -> [[a, b], [c]]. Shell -c scripts contribute their own pipelines.
 *
 * A group piped onward counts as one stage holding everything run inside it:
 * `{ a; b; } | c`, `(a; b) | c`, `for ...; do a; done | c`, `case ... esac | c` -> [..., [a, b, c]].
 * So does a call to a function defined earlier in the command: `f() { a; }; f | c` -> [..., [f, a, c]].
 * A pipe into a `( )` subshell or a `bash -c` script continues into its first command.
 * `$(...)` and backticks feed arguments, not stdout, so they never join an outgoing pipe. They do
 * inherit stdin: `a | echo "$(b)"` -> [[a, echo, b]], with b marked by `readsOnly()`.
 */
export function pipelines(cmd: string, depth = 0): Invocation[][] {
  return walk(cmd, depth).out;
}

/** `pipelines()`, plus `top`: the invocations whose stdout is the command's own stdout. */
function walk(cmd: string, depth: number, feed0?: Invocation[]): { out: Invocation[][]; top: Invocation[] } {
  const out: Invocation[][] = [];
  // open pipeline per context: segments of one context arrive in order, inner contexts interleave
  const open = new Map<number, Invocation[]>();
  if (feed0) open.set(0, feed0);
  // per context: every invocation whose stdout is that context's stdout, including `( )` subshells
  const members = new Map<number, Invocation[]>();
  // per context: every invocation run there at all, including inside `$(...)` and backticks
  const all = new Map<number, Invocation[]>();
  // per context: the `{ }` / `if` / loop / `case` groups not yet closed
  const frames = new Map<number, Frame[]>();
  // per `( )` subshell: the pipeline piped into it
  const fed = new Map<number, Invocation[]>();
  // per context: a `function f` waiting for its `{` body
  const pendingFn = new Map<number, string>();
  const fns = new Map<string, Body>();
  const listOf = <V>(m: Map<number, V[]>, k: number): V[] => {
    let v = m.get(k);
    if (!v) m.set(k, (v = []));
    return v;
  };
  // add a stage's invocations to a pipeline; `reads` only read it
  const join = (line: Invocation[], writes: Invocation[], reads: Invocation[] = []) => {
    for (const x of writes) if (!line.includes(x)) line.push(x);
    for (const x of reads) {
      if (line.includes(x)) continue;
      line.push(x);
      let ro = READ_ONLY.get(line);
      if (!ro) READ_ONLY.set(line, (ro = new Set()));
      ro.add(x);
    }
  };

  for (const seg of scan(cmd)) {
    if (seg.opens) {
      // a pipe into `( )` continues into the subshell, and on into a nested one: `a | ((b))`
      const feed = seg.parent === undefined ? undefined : open.get(seg.parent);
      if (feed && seg.parent !== undefined) {
        open.delete(seg.parent);
        open.set(seg.ctx, feed);
        fed.set(seg.ctx, feed);
      }
      continue;
    }
    const mine = listOf(members, seg.ctx);
    const every = listOf(all, seg.ctx);
    // commands in this segment's `$(...)` / backticks: they read its stdin, their stdout is an argument
    const reads = (seg.subs ?? []).flatMap((id) => all.get(id) ?? []);
    every.push(...reads);
    let ws = words(seg.text);

    // a group ends here: everything run inside it is this stage of the pipeline
    let unit: Invocation[] | null = null;
    let feed: Invocation[] | undefined;
    let away = false;
    const inner = seg.group === undefined ? undefined : members.get(seg.group);
    if (inner?.length) mine.push(...inner);
    if (seg.group !== undefined) every.push(...(all.get(seg.group) ?? []));
    if (seg.group !== undefined && inner?.length && (!ws.length || REDIRECTION.test(ws[0]))) {
      unit = inner;
      feed = fed.get(seg.group);
      away = stdoutAway(ws);
    } else if (CLOSERS.has(ws[0] ?? "")) {
      const frame = frames.get(seg.ctx)?.pop();
      unit = frame ? mine.slice(frame.start) : [];
      feed = frame?.feed;
      away = stdoutAway(ws.slice(1));
      if (frame?.fn) {
        // a definition runs nothing; a later call runs the body
        const writes = unit;
        fns.set(frame.fn, { writes, reads: every.slice(frame.allStart).filter((x) => !writes.includes(x)) });
        unit = [];
        feed = undefined;
      }
    }
    if (unit) {
      if (seg.pipe && !away && (feed || unit.length)) {
        const line = feed ?? [];
        if (!feed) out.push(line);
        join(line, unit);
        open.set(seg.ctx, line);
      } else open.delete(seg.ctx);
      continue;
    }

    if (ws[0] === "function" && ws.length > 1) {
      pendingFn.set(seg.ctx, ws[1]);
      ws = ws.slice(2);
    }
    let header = false;
    for (let i = 0; i < ws.length && (RESERVED.has(ws[i]) || HEADERS.has(ws[i])); i++) {
      if (OPENERS.has(ws[i])) {
        // this segment's own `$(...)` runs inside the group: `{ echo "$(head)"; }`
        const frame: Frame = { start: mine.length, allStart: every.length - reads.length, feed: open.get(seg.ctx) };
        const fn = pendingFn.get(seg.ctx);
        if (fn !== undefined) {
          frame.fn = fn;
          frame.feed = undefined;
          pendingFn.delete(seg.ctx);
        }
        listOf(frames, seg.ctx).push(frame);
      }
      if (HEADERS.has(ws[i])) {
        header = true;
        break;
      }
    }
    const piped = open.get(seg.ctx);
    const inv = header ? null : resolve(ws);
    if (!inv) {
      // `x | v=$(head)`: the substitution still reads the pipe
      if (piped) join(piped, [], reads);
      open.delete(seg.ctx);
      continue;
    }
    mine.push(inv);
    every.push(inv);
    const line = piped ?? [];
    if (!piped) out.push(line);
    line.push(inv);
    if (piped) join(line, [], reads);
    if (seg.pipe) open.set(seg.ctx, line);
    else open.delete(seg.ctx);
    const body = fns.get(inv.program);
    if (body) {
      // a call runs the body: `f | head` truncates whatever f prints
      mine.push(...body.writes);
      every.push(...body.writes, ...body.reads);
      if (piped || seg.pipe) join(line, body.writes);
      if (piped) join(line, [], body.reads);
    }
    const script = depth < 4 ? shellScript(inv) : null;
    if (script) {
      // a pipe into the wrapper feeds the script's first command: `gh-axi ... | bash -c 'head'`
      const inner = walk(script, depth + 1, piped ? line : undefined);
      out.push(...inner.out);
      // the script's output is the wrapper's output: `bash -c 'gh-axi ...' | head` truncates gh-axi.
      // Commands inside its $(...) or backticks only feed arguments, so they stay out.
      mine.push(...inner.top);
      every.push(...inner.out.flat());
      if (seg.pipe) join(line, inner.top);
    }
  }
  return { out, top: members.get(0) ?? [] };
}

/** Turn an argv array (as some agents send) into a shell string with the same meaning. */
export function argvToCommand(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
