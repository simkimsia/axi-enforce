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
  /** indices into `args` of quoted words that would otherwise read as redirections: `--title ">"` (#22) */
  literal?: Set<number>;
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
/**
 * `command -v gh` / `command -V gh` only look the name up and print where it is (#23); plain
 * `command gh` and `command -p gh` run it. Flags may be combined: `command -pv gh`.
 */
const LOOKUP_FLAG = /^-[pvV]*[vV][pvV]*$/;
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
  conditional?: boolean;
  /** id of the executable context (root, a `$(...)`, a backtick, a `( )`) it was found in */
  ctx: number;
  /** set when `ctx` is a `( )` subshell: the id of the context around it */
  parent?: number;
  /** set when this segment closes a `( )` subshell (`(...) | head`): that subshell's context id */
  group?: number;
  /** an empty marker: the `( )` subshell `ctx` opens here, so a pipe into it can follow in order */
  opens?: boolean;
  /** ids of the `$(...)` / backtick contexts opened inside this segment, in order */
  subs?: number[];
  /** per entry of `subs`: the offset in `text` of its `_` placeholder, so it maps to a word (#22) */
  subAt?: number[];
}

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
  const conditional = [false];
  // per buffer: the parent id when the context is a `( )` subshell
  const parents: (number | undefined)[] = [undefined];
  // per buffer: a `( )` subshell that just closed in it, so the next flush carries it even if empty
  const closed: (number | undefined)[] = [undefined];
  // per buffer: the `$(...)` / backtick contexts opened in its current segment, and where
  const opened: { id: number; at: number }[][] = [[]];
  let nextId = 1;
  const top = () => stack[stack.length - 1];
  const flush = (pipe = false) => {
    const k = bufs.length - 1;
    const s = bufs[k].trim();
    const group = closed[k];
    if (s || group !== undefined) {
      const seg: Segment = { text: s, pipe, ctx: ids[k] };
      if (conditional[k]) seg.conditional = true;
      if (parents[k] !== undefined) seg.parent = parents[k];
      if (group !== undefined) seg.group = group;
      if (opened[k].length) {
        const lead = bufs[k].length - bufs[k].trimStart().length;
        seg.subs = opened[k].map((o) => o.id);
        seg.subAt = opened[k].map((o) => o.at - lead);
      }
      segs.push(seg);
    }
    bufs[k] = "";
    closed[k] = undefined;
    opened[k] = [];
  };
  const push = (ctx: string) => {
    const parent = ids[ids.length - 1];
    // the `_` placeholder was just added: it is the last character of the buffer
    if (ctx !== "grp") opened[opened.length - 1].push({ id: nextId, at: bufs[bufs.length - 1].length - 1 });
    stack.push(ctx);
    bufs.push("");
    conditional.push(conditional[conditional.length - 1]);
    ids.push(nextId++);
    parents.push(ctx === "grp" ? parent : undefined);
    closed.push(undefined);
    opened.push([]);
    if (ctx === "grp") {
      segs.push({
        text: "",
        pipe: false,
        ctx: ids[ids.length - 1],
        parent,
        opens: true,
        conditional: conditional[conditional.length - 1],
      });
    }
  };
  const pop = () => {
    flush();
    const kind = stack.pop();
    bufs.pop();
    conditional.pop();
    const id = ids.pop();
    parents.pop();
    closed.pop();
    opened.pop();
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
        conditional[conditional.length - 1] = true;
        i++;
      } else {
        flush(true);
        if (src[i + 1] === "&") i++; // `|&` pipes stderr too
      }
      continue;
    }
    if (c === ";" || c === "&" || c === "\n") {
      const empty = !bufs[bufs.length - 1].trim() && closed[closed.length - 1] === undefined;
      flush();
      if (c !== "\n" || !empty) conditional[conditional.length - 1] = c === "&" && src[i + 1] === "&";
      if (c === "&" && src[i + 1] === "&") i++;
      continue;
    }
    add(c);
  }
  while (bufs.length) {
    flush();
    bufs.pop();
    conditional.pop();
    ids.pop();
    parents.pop();
    closed.pop();
    opened.pop();
  }
  return segs;
}

/** Whitespace split that keeps quoted runs together and strips the quotes. */
export function words(segment: string): string[] {
  return lex(segment).words;
}

/** `words()`, plus where each word came from. */
interface Lexed {
  words: string[];
  /** per character of the segment: the index of the word it belongs to (-1 for whitespace) */
  at: number[];
  /** indices of quoted or escaped words that would otherwise read as redirections: `">"`, `\>f` */
  literal: Set<number>;
  expanded: Map<number, Set<number>>;
}

function lex(segment: string): Lexed {
  const out: string[] = [];
  const at: number[] = new Array(segment.length).fill(-1);
  const literal = new Set<number>();
  const expanded = new Map<number, Set<number>>();
  let cur = "";
  let quote: string | null = null;
  let has = false;
  // leading characters of `cur` that were neither quoted nor escaped; -1 while still counting
  let bare = -1;
  const end = () => {
    if (has || cur) {
      const m = cur.match(REDIRECT_WORD);
      const opLen = m ? m[1].length + m[2].length : 0;
      if (m && (bare < 0 ? cur.length : bare) < opLen) literal.add(out.length);
      out.push(cur);
    }
    cur = "";
    has = false;
    bare = -1;
  };
  const stop = () => {
    if (bare < 0) bare = cur.length;
  };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    at[i] = out.length;
    if (quote === '"' && c === "\\" && /[$`"\\]/.test(segment[i + 1] ?? "")) {
      at[i + 1] = out.length;
      cur += segment[++i];
      continue;
    }
    if (c === "$" && quote !== "'") {
      let offsets = expanded.get(out.length);
      if (!offsets) expanded.set(out.length, (offsets = new Set()));
      offsets.add(cur.length);
    }
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      stop();
      quote = c;
      has = true;
      continue;
    }
    // POSIX escape only before a special char; otherwise keep it (Windows paths: C:\bin\gh.exe)
    if (c === "\\" && i + 1 < segment.length && SPECIAL.test(segment[i + 1])) {
      stop();
      at[i + 1] = out.length;
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
      for (let k = i; k <= j && k < segment.length; k++) at[k] = out.length;
      has = true;
      i = j;
      continue;
    }
    if (/\s/.test(c)) {
      at[i] = -1;
      end();
      continue;
    }
    cur += c;
    has = true;
  }
  end();
  return { words: out, at, literal, expanded };
}

/** The literal words of `lx` from word `from` on, renumbered from 0; undefined when none. */
function literalFrom(lx: Lexed, from: number): Set<number> | undefined {
  const s = new Set([...lx.literal].filter((j) => j >= from).map((j) => j - from));
  return s.size ? s : undefined;
}

/** `resolve()` that also marks quoted arguments that only look like redirections. */
function resolveLexed(lx: Lexed): Invocation | null {
  const inv = resolve(lx.words);
  if (!inv) return null;
  const literal = literalFrom(lx, lx.words.length - inv.args.length);
  if (literal) inv.literal = literal;
  return inv;
}

/**
 * The variables a segment assigns, each with the `$(...)` / backtick ids sitting in its own word (#22):
 * `d=$(date) out=$(gh-axi x)` gives d its sub and out its own. Words before `from` are not assignments.
 */
function assignments(seg: Segment, lx: Lexed, from: number): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (let j = from; j < lx.words.length; j++) {
    const m = lx.words[j].match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m) out.set(m[1], []);
  }
  if (!out.size) return out;
  (seg.subs ?? []).forEach((id, k) => {
    const j = lx.at[seg.subAt?.[k] ?? -1] ?? -1;
    const m = j >= from ? lx.words[j]?.match(/^([A-Za-z_][A-Za-z0-9_]*)=/) : null;
    if (m) out.get(m[1])?.push(id);
  });
  return out;
}

/** Where the assignments in a segment start: all words without a program, the arguments of `local` etc. */
function assignFrom(ws: string[], inv: Invocation | null): number {
  if (!inv) return 0;
  return DECLARERS.has(inv.program) ? ws.length - inv.args.length : ws.length;
}

/** Peel assignments and launchers off a word list; returns the real program invocation. */
export function resolve(ws: string[]): Invocation | null {
  let i = 0;
  for (;;) {
    while (i < ws.length && (ASSIGNMENT.test(ws[i]) || RESERVED.has(ws[i]))) i++;
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
    if (name === "command" && lookupOnly(ws, i + 1)) return { program: name, args: ws.slice(i + 1) };
    if (argFlags) {
      i = skipFlags(ws, i + 1, argFlags) + (LAUNCHER_POSITIONALS[name] ?? 0);
      continue;
    }
    return { program: name, args: ws.slice(i + 1) };
  }
}

/** `command`'s flags from `i` include a lookup (`-v`, `-V`): the next word is an argument, not run. */
function lookupOnly(ws: string[], i: number): boolean {
  for (; i < ws.length && ws[i].startsWith("-") && ws[i] !== "--"; i++) if (LOOKUP_FLAG.test(ws[i])) return true;
  return false;
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
function shellScriptIndex(inv: Invocation): number | null {
  if (!SHELLS.has(inv.program)) return null;
  for (let i = 0; i < inv.args.length; i++) {
    const a = inv.args[i];
    if (/^-[a-z]*c[a-z]*$/i.test(a)) return i + 1 < inv.args.length ? i + 1 : null;
    if (!a.startsWith("-")) return null;
  }
  return null;
}

/** `$W`, `${W}`: a variable used as a word. */
const VAR_WORD = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

export function invocations(cmd: string, depth = 0, outer?: Map<string, string[]>): Invocation[] {
  const out: Invocation[] = [];
  // what a `command -v` lookup found, per `$(...)` / backtick context and per variable assigned from one.
  // A `sh -c` script starts from the variables its caller set (#26).
  const found = new Map<number, string[]>();
  const vars = new Map<string, string[]>(outer);
  // what a child shell sees: its caller's environment, so only exported variables (#26)
  const exported = new Set<string>(outer?.keys());
  const lookedIn = (ids: number[]) => ids.flatMap((id) => found.get(id) ?? []);
  const record = (bindings: Map<string, string[]>, name: string, looked: string[]) => {
    if (looked.length) bindings.set(name, looked);
    else bindings.delete(name);
  };
  for (const seg of scan(cmd)) {
    if (!seg.text) continue;
    const lx = lex(seg.text);
    const ws = lx.words;
    const inv = resolve(ws);
    // `W=$(command -v gh)`, `local W=$(command -v gh)`: W holds what the lookup found (#26)
    const references = (value: string) => vars.get(value.match(VAR_WORD)?.[1] ?? "") ?? [];
    const local = new Map(vars);
    const from = assignFrom(ws, inv);
    // `export W=...`, `declare -x W=...`, bare `export W`: W reaches child shells
    const exporting =
      inv?.program === "export" ||
      ((inv?.program === "declare" || inv?.program === "typeset") && inv.args.some((a) => /^-[A-Za-z]*x/.test(a)));
    if (exporting) for (const a of inv.args) if (/^[A-Za-z_][A-Za-z0-9_]*(=|$)/.test(a)) exported.add(a.split("=")[0]);
    // `W=... sh -c '...'`: a prefix assignment is in that command's environment
    const prefixed = new Set<string>();
    for (const [name, ids] of assignments(seg, lx, 0)) {
      const index = ws.findIndex((w) => w.startsWith(`${name}=`));
      const value = ws[index].slice(name.length + 1);
      const looked = [...lookedIn(ids), ...references(value)];
      if (index >= from) record(vars, name, looked);
      else if (index < ws.length - (inv?.args.length ?? 0) - 1) {
        record(local, name, looked);
        prefixed.add(name);
      }
    }
    if (!inv) continue;
    out.push(inv);
    const looked = lookedIn(seg.subs ?? []);
    // `for c in $(command -v gh); do $c ...`: the loop variable holds it too (#26)
    if (HEADERS.has(inv.program) && inv.args[1] === "in" && ASSIGNMENT.test(`${inv.args[0]}=`)) {
      record(vars, inv.args[0], [...looked, ...inv.args.slice(2).flatMap(references)]);
    }
    if (inv.program === "command") {
      // `command -v x 2>/dev/null`: the redirection is not a name that was looked up (#26)
      const names = redirects(inv.args).plain.filter((a) => !a.startsWith("-"));
      found.set(seg.ctx, [...(found.get(seg.ctx) ?? []), ...names]);
    }
    // `$(command -v gh) pr list`, `W=$(command -v gh); $W pr list`: runs what the lookup found
    const ran = inv.program === "_" ? looked : (vars.get(inv.program.match(VAR_WORD)?.[1] ?? "") ?? []);
    for (const name of ran) out.push({ program: programName(name), args: inv.args });
    const scriptIndex = depth < 4 ? shellScriptIndex(inv) : null;
    if (scriptIndex !== null) {
      const env = new Map([...local].filter(([name]) => exported.has(name) || prefixed.has(name)));
      const offsets = lx.expanded.get(ws.length - inv.args.length + scriptIndex);
      const script = inv.args[scriptIndex].replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (ref, braced, bare, offset) => {
          const name = braced ?? bare;
          // the caller already expanded a double-quoted `$W`; a single-quoted one is the child's to expand
          if (!offsets?.has(offset) || vars.get(name) === env.get(name)) return ref;
          return vars.get(name)?.join(" ") || "_";
        },
      );
      out.push(...invocations(script, depth + 1, env));
    }
  }
  return out;
}

/** Words that open a compound command: `{ ...; }`, `if ...; fi`, loops `...; done`. */
const OPENERS = new Set(["{", "if", "while", "until", "for", "select"]);
/** `for x in a b`, `select x in a b`: the rest of the segment is a word list, not a command. */
const HEADERS = new Set(["for", "select"]);
/** A word that starts a redirection: `>f`, `2>&1`, `&>f`, `<f`. */
const REDIRECTION = /^(\d+|&)?[<>]/;
/** Words that close a compound command. A `|` after them pipes the whole group's output. */
const CLOSERS = new Set(["}", "fi", "done"]);

interface Frame {
  /** index into the context's members where the group starts */
  start: number;
  conditional: boolean;
  /** the pipeline piped into the group, if any (`x | while read r; do ...; done`) */
  feed?: Invocation[];
}

/**
 * The pipelines in a command, as lists of invocations joined by `|`, in order.
 * `a | b; c` -> [[a, b], [c]]. Shell -c scripts contribute their own pipelines.
 *
 * A group piped onward counts as one stage holding everything run inside it:
 * `{ a; b; } | c`, `(a; b) | c`, `for ...; do a; done | c` -> [..., [a, b, c]].
 * A pipe into a `( )` subshell continues into its first command: `a | (b)` -> [[a, b]].
 * `$(...)` and backticks feed arguments, not stdin, so they never join the outer pipeline.
 */
export function pipelines(cmd: string, depth = 0): Invocation[][] {
  return walk(cmd, depth, { order: new Map(), captures: [], pipes: new Map() }).out;
}

/**
 * Output saved for later in the same command line (#16):
 * - `var`: a shell variable assigned from `$(...)` or backticks (`out=$(a)`, `local out=$(a)`),
 * - `file`: a file written by stdout redirection (`a > f`, `a >> f`, `{ a; } > f`).
 */
export interface Capture {
  kind: "var" | "file";
  /** the variable name, or the file path as written (a leading `./` dropped) */
  name: string;
  /** the invocations whose output was saved: the pipeline into the file, or what ran in the `$(...)` */
  from: Invocation[];
  /** `order` value from which a later invocation can read the saved output */
  seq: number;
  /** a file written with `>>`: it keeps what was in the file before (#22) */
  append?: boolean;
  conditional?: boolean;
}

/** `pipelines()` plus the data flow outside pipes: what was saved, and the run order of each invocation. */
export interface Flow {
  lines: Invocation[][];
  captures: Capture[];
  /** run order of each invocation in `lines` and `captures` */
  order: Map<Invocation, number>;
  pipes: Map<Invocation, Invocation>;
}

export function flow(cmd: string): Flow {
  const st: FlowState = { order: new Map(), captures: [], pipes: new Map() };
  const { out } = walk(cmd, 0, st);
  // A `case` arm or a function body may never run, and the scanner does not track either, so no
  // writer in such a command is trusted to replace a saved file (#22): fall back to main's behaviour.
  if (DEFERRED.some((re) => re.test(cmd))) for (const c of st.captures) if (c.kind === "file") c.conditional = true;
  return { lines: out, captures: st.captures, order: st.order, pipes: st.pipes };
}

/** `case ... esac`, `function name`, `name()`: code that runs only on a match or a later call. */
const DEFERRED = [/(^|[\s;&|(`])esac(?![\w-])/, /(^|[\s;&|(`{])function\s+[A-Za-z_]/, /[A-Za-z_][\w.:-]*\s*\(\s*\)/];

interface FlowState {
  order: Map<Invocation, number>;
  pipes: Map<Invocation, Invocation>;
  captures: Capture[];
}

/** Builtins whose `name=value` arguments set shell variables: `local out=$(a)`. */
const DECLARERS = new Set(["local", "export", "declare", "typeset", "readonly"]);

/** A redirection word: optional fd (`2`, `&`), the operator, and the target if glued (`>f`). */
const REDIRECT_WORD = /^(\d*|&)(>>|>\||>|<<<|<)(.*)$/s;

/**
 * Split a command's words into plain arguments and redirections.
 * `outputs`: files that receive stdout (`>f`, `>> f`, `1>f`, `&>f`); `2>f` and `>&2` are not stdout.
 * `inputs`: what stdin reads (`< f` targets, `<<< word` strings).
 */
export function redirects(
  ws: string[],
  literal?: ReadonlySet<number>,
): { plain: string[]; inputs: string[]; outputs: string[] } {
  const { plain, inputs, writes } = splitRedirects(ws, literal);
  return { plain, inputs, outputs: writes.map((w) => w.target) };
}

/** `redirects()`, with each stdout file marked when it is appended to (`>>`). `literal`: quoted words, never redirections. */
function splitRedirects(
  ws: string[],
  literal?: ReadonlySet<number>,
): { plain: string[]; inputs: string[]; writes: { target: string; append: boolean }[] } {
  const plain: string[] = [];
  const inputs: string[] = [];
  const writes: { target: string; append: boolean }[] = [];
  for (let i = 0; i < ws.length; i++) {
    const m = literal?.has(i) ? null : ws[i].match(REDIRECT_WORD);
    if (!m) {
      plain.push(ws[i]);
      continue;
    }
    const [, fd, op] = m;
    let target = m[3];
    if (!target && i + 1 < ws.length) target = ws[++i];
    if (!target) continue;
    if (op === "<" || op === "<<<") {
      if (fd === "" || fd === "0") inputs.push(target);
    } else if ((fd === "" || fd === "1" || fd === "&") && !target.startsWith("&")) {
      writes.push({ target, append: op === ">>" });
    }
  }
  return { plain, inputs, writes };
}

/** `./out.txt` and `out.txt` name the same file. */
export function samePath(p: string): string {
  return p.replace(/^(\.\/)+/, "");
}

/** Record the files that `ws` redirects stdout into, as saved output of `from`. */
function captureFiles(
  st: FlowState,
  ws: string[],
  literal: ReadonlySet<number> | undefined,
  from: Invocation[],
  conditional: boolean,
): void {
  for (const { target, append } of splitRedirects(ws, literal).writes) {
    if (target.startsWith("/dev/")) continue;
    const c: Capture = { kind: "file", name: samePath(target), from, seq: st.order.size };
    if (append) c.append = true;
    if (conditional) c.conditional = true;
    st.captures.push(c);
  }
}

/** `pipelines()`, plus `top`: the invocations whose stdout is the command's own stdout. */
function walk(
  cmd: string,
  depth: number,
  st: FlowState,
  conditional = false,
): { out: Invocation[][]; top: Invocation[] } {
  const out: Invocation[][] = [];
  // open pipeline per context: segments of one context arrive in order, inner contexts interleave
  const open = new Map<number, Invocation[]>();
  const tails = new Map<number, Invocation>();
  // per context: every invocation that runs there, including inside its `( )` subshells
  const members = new Map<number, Invocation[]>();
  // per context: the `{ }` / `if` / loop groups not yet closed
  const frames = new Map<number, Frame[]>();
  // per `( )` subshell: the pipeline piped into it
  const fed = new Map<number, Invocation[]>();
  const optional = new Set<number>();
  const listOf = <V>(m: Map<number, V[]>, k: number): V[] => {
    let v = m.get(k);
    if (!v) m.set(k, (v = []));
    return v;
  };

  for (const seg of scan(cmd)) {
    const guarded =
      conditional ||
      !!seg.conditional ||
      optional.has(seg.ctx) ||
      [...frames.values()].some((stack) => stack.some((frame) => frame.conditional));
    if (seg.opens) {
      if (guarded) optional.add(seg.ctx);
      // a pipe into `( )` continues into the subshell, and on into a nested one: `a | ((b))`
      const feed = seg.parent === undefined ? undefined : open.get(seg.parent);
      if (feed && seg.parent !== undefined) {
        open.delete(seg.parent);
        open.set(seg.ctx, feed);
        const tail = tails.get(seg.parent);
        if (tail) tails.set(seg.ctx, tail);
        tails.delete(seg.parent);
        fed.set(seg.ctx, feed);
      }
      continue;
    }
    const mine = listOf(members, seg.ctx);
    const lx = lex(seg.text);
    const ws = lx.words;

    // a group ends here: everything run inside it is this stage of the pipeline
    let unit: Invocation[] | null = null;
    let feed: Invocation[] | undefined;
    const inner = seg.group === undefined ? undefined : members.get(seg.group);
    if (inner?.length) mine.push(...inner);
    if (seg.group !== undefined && inner?.length && (!ws.length || REDIRECTION.test(ws[0]))) {
      unit = inner;
      feed = fed.get(seg.group);
    } else if (CLOSERS.has(ws[0] ?? "")) {
      const frame = frames.get(seg.ctx)?.pop();
      unit = frame ? mine.slice(frame.start) : [];
      feed = frame?.feed;
    }
    if (unit) {
      if (unit.some((inv, i) => i > 0 && st.pipes.get(inv) !== unit![i - 1])) {
        st.pipes.delete(unit[0]);
      }
      tails.delete(seg.ctx);
      if (seg.pipe && (feed || unit.length)) {
        const line = feed ?? [];
        if (!feed) out.push(line);
        for (const inv of unit) if (!line.includes(inv)) line.push(inv);
        open.set(seg.ctx, line);
      } else open.delete(seg.ctx);
      // `{ a; } > f`, `(a) > f`, `done > f`: everything the group printed lands in f
      if (unit.length) {
        const skip = CLOSERS.has(ws[0] ?? "") ? 1 : 0;
        captureFiles(st, ws.slice(skip), literalFrom(lx, skip), [...(feed ?? []), ...unit], guarded);
      }
      continue;
    }

    let header = false;
    for (let i = 0; i < ws.length && (RESERVED.has(ws[i]) || HEADERS.has(ws[i])); i++) {
      if (OPENERS.has(ws[i])) {
        listOf(frames, seg.ctx).push({
          start: mine.length,
          feed: open.get(seg.ctx),
          conditional: guarded || ws[i] !== "{",
        });
      }
      if (HEADERS.has(ws[i])) {
        header = true;
        break;
      }
    }
    const invocationConditional = guarded || (frames.get(seg.ctx)?.some((frame) => frame.conditional) ?? false);
    const inv = header ? null : resolveLexed(lx);
    // `out=$(a)` / `local out=$(a)`: out holds what ran in its own `$(...)`, so `d=$(date) out=$(a)` only marks out
    for (const [name, ids] of header ? [] : assignments(seg, lx, assignFrom(ws, inv))) {
      const saved = ids.flatMap((id) => members.get(id) ?? []);
      if (saved.length) st.captures.push({ kind: "var", name, from: saved, seq: st.order.size });
    }
    if (!inv) {
      open.delete(seg.ctx);
      continue;
    }
    mine.push(inv);
    st.order.set(inv, st.order.size);
    const piped = open.get(seg.ctx);
    const line = piped ?? [];
    if (!piped) out.push(line);
    const previous = piped ? tails.get(seg.ctx) : undefined;
    if (previous) st.pipes.set(inv, previous);
    tails.set(seg.ctx, inv);
    line.push(inv);
    if (seg.pipe) open.set(seg.ctx, line);
    else open.delete(seg.ctx);
    const scriptIndex = depth < 4 ? shellScriptIndex(inv) : null;
    const script = scriptIndex === null ? null : inv.args[scriptIndex];
    let printed: Invocation[] = [];
    if (script) {
      tails.delete(seg.ctx);
      const inner = walk(script, depth + 1, st, invocationConditional);
      // a pipe into the wrapper feeds the script's first top-level pipeline: `gh-axi ... | bash -c 'head'`
      const first = piped ? inner.out.find((l) => l.some((x) => inner.top.includes(x))) : undefined;
      if (first) {
        if (first.length && inner.top.every((x, i) => i === 0 || st.pipes.get(x) === inner.top[i - 1])) {
          st.pipes.set(first[0], inv);
        }
        line.push(...first);
      }
      out.push(...inner.out.filter((l) => l !== first));
      // the script's output is the wrapper's output: `bash -c 'gh-axi ...' | head` truncates gh-axi.
      // Commands inside its $(...) or backticks only feed arguments, so they stay out.
      mine.push(...inner.top);
      if (seg.pipe) for (const x of inner.top) if (!line.includes(x)) line.push(x);
      printed = inner.top.filter((x) => !line.includes(x));
    }
    captureFiles(st, inv.args, inv.literal, [...line, ...printed], invocationConditional);
  }
  return { out, top: members.get(0) ?? [] };
}

/** Turn an argv array (as some agents send) into a shell string with the same meaning. */
export function argvToCommand(argv: string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
