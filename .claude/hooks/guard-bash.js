#!/usr/bin/env node
/*
 * GoodBehavior guard-bash — a PreToolUse hook (matcher: Bash and PowerShell) that denies a small set of hard-shape
 * commands outright, and audits every decision (allow and deny) it makes.
 *
 * This is the fast-lane net: Claude Code's own permission system (rules, sandbox, managed settings)
 * is the first line. This hook adds only what native can't do — a blocklist scan that still fires
 * under bypassPermissions, since hooks run regardless of permission mode.
 *
 * Fail CLOSED (opposite of done-gate, which fails open on purpose): malformed stdin, any error anywhere in
 * the decision path, or a fault that stops this file from finishing LOAD, all deny the command. The audit entry is written before the decision
 * is returned. Deny reasons never echo the raw matched command text (redaction discipline for the
 * future injection layer) — only the named shape.
 *
 * Protocol: PreToolUse decisions use the permissionDecision JSON on stdout (not the exit-code
 * convention done-gate uses for Stop). Always exits 0; the JSON carries the verdict.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

// Registered BEFORE any other work in this file, and deliberately self-contained: it must stay correct even
// when the code below it never finished loading. Only main() used to be wrapped in try/catch, so a throw at
// module scope — a `const` read before its own declaration was the real case — crashed the process before the
// stdin handler was registered: nothing on stdout, nothing audited, and EVERY COMMAND ALLOWED. That is the
// wrong failure mode for a blocklist. This handler closes the window that the try/catch around main() can't
// reach; a load-time fault now denies like every other fault in the decision path.
process.on("uncaughtException", (err) => {
  try {
    const base = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const dir = path.join(base, ".claude", "goodbehavior", "audit");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, new Date().toISOString().slice(0, 10) + ".jsonl"),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        tool: "Bash",
        shape: "guard-error:load-failure",
        decision: "deny",
        session_id: null,
      }) + "\n");
  } catch (e) { /* best effort — an audit failure must not stop the deny from being emitted */ }
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "GoodBehavior guard-bash: failing closed (load-failure) — the guard could not finish loading, so it " +
          "cannot evaluate this command and denies it. Reason: " + String((err && err.message) || err),
      },
    }));
  } catch (e) { /* noop */ }
  process.exit(0);
});

if (process.env.GUARD_BASH_TEST_FORCE_LOAD_THROW) throw new Error("forced test load throw");

// The tools this hook decides for. Both carry the command in `tool_input.command`.
const GUARDED_TOOLS = new Set(["Bash", "PowerShell"]);
const SHELL_EXECS = new Set(["sh", "bash", "zsh", "ksh", "dash", "ash", "csh", "tcsh", "source"]);
const NC_NAMES = new Set(["nc", "ncat", "netcat", "nc.traditional", "nc.openbsd"]);
const WRITE_VERBS = new Set(["rm", "mv", "cp", "tee", "dd", "truncate", "ln", "touch", "mkdir", "rmdir", "chmod", "chown"]);
// The POSIX system roots. Windows has its own (WIN_SYSTEM_PREFIX_RE). Shared by the rm-shape check and the zone
// classifier (Phase 3) so the two never drift apart. Deliberately the UNION across macOS and Linux rather
// than a per-platform switch: a prefix that doesn't exist on this host can never match a real path, so the
// union costs nothing and removes a whole class of "wrong on the other OS" bug.
// Two categories are deliberately NOT here. The directories homes live in would reclassify every ordinary
// home path as "system" and flood the severity channel — they are protected roots instead (protectedRoots()).
// Mount points (`/mnt`, `/media`, and the macOS equivalent) hold user data, not system files: home zone.
const SYSTEM_PREFIXES = [
  "/etc", "/usr", "/bin", "/sbin", "/var", "/boot", "/root",         // both
  "/System", "/Library", "/private", "/Applications",                // macOS
  "/opt", "/srv", "/lib", "/lib32", "/lib64", "/proc", "/sys", "/dev", // Linux (and /dev on both)
];
// ---- path dialects: one directory, several spellings, and on Windows they cross grammars ----

const WIN_DRIVE_RE = /^([A-Za-z]):[\\/]/;   // C:\… or C:/…
const WIN_DRIVE_BARE_RE = /^([A-Za-z]):$/;  // C:
const UNC_RE = /^\\\\[^\\]/;              // \\server\share

/** Canonical form is POSIX with an MSYS-style drive prefix: a drive-letter path, its forward-slash variant,
 *  and the Git Bash `/c/...` form all become one string, so ONE protected-root set and ONE zone ladder serve
 *  both grammars. Conversion is
 *  conditional on the token actually looking Windows-shaped — a blanket backslash swap would corrupt POSIX
 *  paths where `\` is an escape (`/tmp/my\ dir`). Anything else passes through untouched. */
function toCanonicalPath(raw) {
  if (typeof raw !== "string" || raw === "") return raw;
  const drive = WIN_DRIVE_RE.exec(raw);
  if (drive) return "/" + drive[1].toLowerCase() + raw.slice(2).replace(/\\/g, "/");
  const bare = WIN_DRIVE_BARE_RE.exec(raw);
  if (bare) return "/" + bare[1].toLowerCase();
  if (UNC_RE.test(raw)) return raw.replace(/\\/g, "/");
  return raw;
}

// Windows protected roots, drive-letter agnostic so they hold whichever volume the system lives on: a whole
// drive (`/c`), the directory user profiles live in (`/c/Users`), any single profile under it, and the system
// directories. Written as patterns rather than derived from os.homedir() so the Windows rules are testable
// from a POSIX host too — a `/c/...` path can't collide with a real POSIX one in practice.
const WIN_PROTECTED_RE = /^\/[a-z]\/?$|^\/[a-z]\/users(\/[^/]+)?$|^\/[a-z]\/(windows|program files( \(x86\))?|programdata)$/i;
const WIN_SYSTEM_PREFIX_RE = /^\/[a-z]\/(windows|program files( \(x86\))?|programdata)(\/|$)/i;

const HOME = os.homedir();
// Everything DERIVED is computed lazily and memoized, never at module scope. Module-scope work that throws
// takes the whole file down before the decision path exists; the same work behind an accessor throws inside
// main()'s try/catch instead, where it denies WITH a properly attributed audit line (cwd, session, tool). The
// uncaughtException handler above is the backstop for whatever still escapes, not the first line of defence.
let _homeCanon = null;
/** HOME in canonical form, for PATH MATH only. `HOME` itself stays native because feedsDir() builds real
 *  filesystem paths from it, and on Windows those need the backslashes. */
function homeCanon() {
  if (_homeCanon === null) _homeCanon = toCanonicalPath(HOME || "");
  return _homeCanon;
}
// The roots a recursive force-delete must never be pointed at. DERIVED from os.homedir(), not listed as
// literal tokens: an expanded home path and `~` name the same directory, and a guard that only knows the
// second spelling is a guard you get past by expanding a tilde. The home's PARENT is in here too (the
// directory homes live in) — deleting it takes every account on the box with it.
let _protectedRoots = null;
function protectedRoots() {
  if (_protectedRoots) return _protectedRoots;
  const out = new Set(["/"]);
  for (const pre of SYSTEM_PREFIXES) out.add(pre);
  const home = homeCanon() ? path.posix.normalize(homeCanon()).replace(/\/+$/, "") : "";
  if (home.startsWith("/") && home !== "/") {
    out.add(home);
    const parent = path.posix.dirname(home);
    if (parent !== "/" && parent !== home) out.add(parent);
  }
  _protectedRoots = out;
  return out;
}
// Character devices are named like paths but aren't places on disk. Without this, adding "/dev" to
// SYSTEM_PREFIXES would make every `2>/dev/null` report a SYSTEM-zone write — the most severe label the
// ladder has, and the one that short-circuits the search for the command's real target.
const DEV_STREAMS = /^\/dev\/(null|zero|full|tty|console|stdin|stdout|stderr|u?random|fd\/\d+)$/;
// The OS temp dir commonly resolves UNDER a system prefix (macOS: os.tmpdir() -> /var/folders/... ->
// realpath /private/var/folders/...), which collides with "/var"/"/private" in SYSTEM_PREFIXES. Checked
// before the system-prefix test so temp-dir paths don't misclassify as "system" (BlitzPi's zones.ts has the
// exact same collision and resolves it the same way — scratch checked first).
let _scratchDirs = null;
function scratchDirs() {
  if (_scratchDirs) return _scratchDirs;
  const out = new Set();
  for (const d of [os.tmpdir(), "/tmp"]) {
    out.add(path.posix.normalize(d));
    try { out.add(fs.realpathSync(d)); } catch (e) { /* absent on this platform */ }
  }
  _scratchDirs = [...out];
  return _scratchDirs;
}
// An unexpanded expansion in a path — can't be known, treat conservatively. Covers POSIX `$VAR`/backtick and
// the cmd/PowerShell `%VAR%` form, so a Windows path is never guessed into looking safe either.
const UNRESOLVED_EXPANSION = /[$`]|%[A-Za-z_][A-Za-z0-9_()]*%/;


/** Exact roots a recursive force-delete must never name, in either grammar. */
function isProtectedRoot(p) {
  return protectedRoots().has(p) || WIN_PROTECTED_RE.test(p);
}

// ---- command parsing (quote-aware, just enough to avoid tripping on quoted strings) ----

function splitStatements(cmd) {
  // Splits on unquoted ; && || | & \n, keeping original text (including quotes) per segment.
  const stmts = [];
  let cur = "";
  let sep = null;
  let inS = false;
  let inD = false;
  let i = 0;
  const n = cmd.length;
  const push = () => { stmts.push({ sep, text: cur }); cur = ""; };
  while (i < n) {
    const c = cmd[i];
    if (inS) {
      cur += c;
      if (c === "'") inS = false;
      i++; continue;
    }
    if (inD) {
      if (c === "\\" && i + 1 < n) { cur += c + cmd[i + 1]; i += 2; continue; }
      cur += c;
      if (c === '"') inD = false;
      i++; continue;
    }
    if (c === "'") { inS = true; cur += c; i++; continue; }
    if (c === '"') { inD = true; cur += c; i++; continue; }
    if (c === "\\" && i + 1 < n) { cur += c + cmd[i + 1]; i += 2; continue; }
    if (c === "&" && cmd[i + 1] === "&") { push(); sep = "&&"; i += 2; continue; }
    if (c === "|" && cmd[i + 1] === "|") { push(); sep = "||"; i += 2; continue; }
    if (c === ";" || c === "|" || c === "&" || c === "\n") { push(); sep = c; i++; continue; }
    cur += c; i++;
  }
  push();
  return stmts;
}

function splitWords(text) {
  const words = [];
  let cur = "";
  let inS = false;
  let inD = false;
  let i = 0;
  const n = text.length;
  const flush = () => { if (cur !== "") { words.push(cur); cur = ""; } };
  while (i < n) {
    const c = text[i];
    if (inS) { cur += c; if (c === "'") inS = false; i++; continue; }
    if (inD) {
      if (c === "\\" && i + 1 < n) { cur += c + text[i + 1]; i += 2; continue; }
      cur += c; if (c === '"') inD = false; i++; continue;
    }
    if (c === "'") { inS = true; cur += c; i++; continue; }
    if (c === '"') { inD = true; cur += c; i++; continue; }
    if (c === "\\" && i + 1 < n) { cur += c + text[i + 1]; i += 2; continue; }
    if (/\s/.test(c)) { flush(); i++; continue; }
    cur += c; i++;
  }
  flush();
  return words;
}

function unquote(tok) {
  if (tok.length >= 2) {
    const f = tok[0];
    const l = tok[tok.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) return tok.slice(1, -1);
  }
  return tok;
}

function unquotedSubstringPresent(cmd, needle) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (inS) { if (c === "'") inS = false; continue; }
    if (inD) {
      if (c === "\\") { i++; continue; }
      if (c === '"') inD = false;
      continue;
    }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === "\\") { i++; continue; }
    if (cmd.startsWith(needle, i)) return true;
  }
  return false;
}

function parseCommand(words) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
  if (i >= words.length) return null;
  const parts = words[i].split("/");
  const cmd = parts[parts.length - 1] || words[i];
  return { cmd, args: words.slice(i + 1) };
}

// ---- shape checks ----

function hasExecFlag(args) {
  return args.some((a) => {
    if (a === "--exec" || a === "--sh-exec") return true;
    if (/^-[a-zA-Z]+$/.test(a)) return a.slice(1).includes("e");
    return false;
  });
}

/** Does this `rm` target name a protected root? Resolves the token FIRST — tilde, $HOME, the statement's cwd,
 *  a trailing `/*` glob — and only then tests the result, so every spelling of the same directory gets the same
 *  answer. Comparing raw tokens (the old shape) meant `rm -rf ~` denied while the expanded home path walked past.
 *  A token still carrying an unexpanded `$VAR` is NOT treated as dangerous: its value is unknowable here, and
 *  the zone ladder already handles it conservatively downstream. */
function isDangerousPath(tok, cwd) {
  if (typeof tok !== "string" || tok === "") return false;
  // `rm -rf ~/*` empties the same directory `rm -rf ~` removes — test what the glob expands within.
  const bare = /\/\*+$/.test(tok) ? tok.replace(/\/\*+$/, "/") : tok;
  const r = resolveTarget(bare, cwd);
  if (r.unresolved) return false;
  const p = r.path.replace(/\/+$/, "") || "/";
  return isProtectedRoot(p);
}

function isRecursiveForceDelete(args, cwd) {
  let hasR = false;
  let hasF = false;
  const targets = [];
  for (const a of args) {
    if (a === "--recursive") hasR = true;
    else if (a === "--force") hasF = true;
    else if (/^-[a-zA-Z]+$/.test(a)) {
      if (a.includes("r") || a.includes("R")) hasR = true;
      if (a.includes("f")) hasF = true;
    } else if (!a.startsWith("-")) {
      targets.push(a);
    }
  }
  return hasR && hasF && targets.some((t) => isDangerousPath(t, cwd));
}

function stdoutDownload(cmd, args) {
  if (cmd === "curl") {
    for (const a of args) {
      if (a === "-o" || a === "-O" || a === "--output") return false;
      if (a[0] === "-" && a[1] !== "-" && /^-\w*[oO]\w*$/.test(a)) return false;
    }
    return true;
  }
  if (cmd === "wget") {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--output-document=-") return true;
      if (a === "-O" && args[i + 1] === "-") return true;
      // combined short flags ending in O- (e.g. -qO-, the common "wget -qO- url | sh" idiom)
      if (/^-[a-zA-Z]*O-$/.test(a)) return true;
    }
    return false;
  }
  return false;
}

/** `startCwd` is the project root: hard shapes are cwd-aware because `cd ~ && rm -rf .` names a protected
 *  root just as surely as naming the home directory outright does. Uses segmentsWithCwd (not splitStatements) for
 *  that cwd, which also means `( … )` subshells are now split into their own statements rather than being
 *  read as one word starting with "(" — so `(sudo rm)` and `(curl url) | sh` are seen, where before they
 *  hid behind the paren. */
function detectShape(command, startCwd) {
  if (!command || typeof command !== "string") return null;
  if (unquotedSubstringPresent(command, "/dev/tcp/") || unquotedSubstringPresent(command, "/dev/udp/")) {
    return "reverse-shell";
  }
  const stmts = segmentsWithCwd(command, startCwd);
  let chainHasDownload = false;
  for (const { sep, text, cwd } of stmts) {
    // A paren boundary emits an empty statement. Skipping it before the pipe test keeps `(curl url) | sh`
    // one chain instead of letting the blank segment reset it.
    if (!text.trim()) continue;
    if (sep !== "|") chainHasDownload = false;
    const words = splitWords(text).map(unquote);
    const parsed = parseCommand(words);
    if (!parsed) continue;
    const { cmd, args } = parsed;
    if (cmd === "sudo" || cmd === "doas") return "sudo-doas";
    if (NC_NAMES.has(cmd) && hasExecFlag(args)) return "reverse-shell";
    if (cmd === "rm" && isRecursiveForceDelete(args, cwd)) return "recursive-delete-protected-path";
    if ((cmd === "curl" || cmd === "wget") && stdoutDownload(cmd, args)) {
      chainHasDownload = true;
    } else if (SHELL_EXECS.has(cmd) && chainHasDownload) {
      return "download-piped-to-shell";
    }
  }
  return null;
}

// ---- PowerShell dialect: on Windows the PowerShell tool is the PRIMARY shell, and it is a SEPARATE tool
// from Bash with its own tool_name. The hook subscribes to both; everything below is the second grammar.
// Shared with the POSIX lane: path canonicalization, the protected roots, the zone ladder, the audit, the feeds.
// Different here: the verbs, the switch syntax, and the download-to-execute idiom. ----

const PS_DELETE_VERBS = new Set(["remove-item", "ri", "rd", "rmdir", "del", "erase", "rm"]);
const PS_DOWNLOADERS = new Set(["invoke-webrequest", "iwr", "invoke-restmethod", "irm", "curl", "wget"]);
const PS_EXECS = new Set(["iex", "invoke-expression"]);
const PS_CD_VERBS = new Set(["cd", "chdir", "set-location", "sl", "pushd"]);
const PS_WRITE_VERBS = new Set([
  ...PS_DELETE_VERBS,
  "new-item", "ni", "set-content", "sc", "add-content", "ac", "out-file", "clear-content",
  "copy-item", "cpi", "copy", "cp", "move-item", "mi", "move", "mv", "mkdir", "md", "xcopy", "robocopy",
]);
// The PowerShell reverse shell, the counterpart of the bash /dev/tcp one-liner.
const PS_REVERSE_SHELL_RE = /net\.sockets\.tcp(client|listener)/i;

/** A cmd-style switch (`/s`, `/q`, `/f`) — NOT a path. Reading these as absolute POSIX paths is what made the
 *  guard ask about "/f" while the command's real target walked past unexamined. */
function isCmdSwitch(tok) {
  return /^\/[A-Za-z?][A-Za-z0-9?:-]*$/.test(tok);
}

/** Recursive+forced delete in either Windows grammar: PowerShell's `-Recurse -Force` (accepting the unambiguous
 *  prefixes PowerShell itself accepts), or cmd's `/s`, which recurses and suppresses the prompt in one switch. */
function psIsRecursiveForceDelete(args, cwd) {
  let recurse = false;
  let force = false;
  const targets = [];
  for (const a of args) {
    if (a.startsWith("-")) {
      if (/^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(a)) recurse = true;
      else if (/^-f(o(r(c(e)?)?)?)?$/i.test(a)) force = true;
      continue;
    }
    if (isCmdSwitch(a)) {
      if (/^\/s$/i.test(a)) { recurse = true; force = true; }
      continue;
    }
    targets.push(a);
  }
  return recurse && force && targets.some((t) => isDangerousPath(t, cwd));
}

function detectShapePowerShell(command, startCwd) {
  if (!command || typeof command !== "string") return null;
  if (PS_REVERSE_SHELL_RE.test(maskQuoted(command))) return "reverse-shell";
  let chainHasDownload = false;
  for (const { sep, text, cwd } of segmentsWithCwd(command, startCwd)) {
    if (!text.trim()) continue;
    if (sep !== "|") chainHasDownload = false;
    const parsed = parseCommand(splitWords(text).map(unquote));
    if (!parsed) continue;
    const cmd = parsed.cmd.toLowerCase().replace(/\.exe$/, "");
    const args = parsed.args;
    if (cmd === "sudo" || cmd === "doas") return "sudo-doas";
    // Start-Process -Verb RunAs is the UAC elevation prompt: the Windows counterpart of sudo.
    if (cmd === "start-process" && args.some((a, i) => /^-verb$/i.test(a) && /^runas$/i.test(args[i + 1] || ""))) {
      return "elevated-execution";
    }
    if (PS_DELETE_VERBS.has(cmd) && psIsRecursiveForceDelete(args, cwd)) return "recursive-delete-protected-path";
    if (cmd === "format-volume" || (cmd === "format" && args.some((a) => WIN_DRIVE_BARE_RE.test(a)))) {
      return "format-volume";
    }
    if (PS_DOWNLOADERS.has(cmd)) chainHasDownload = true;
    else if (PS_EXECS.has(cmd) && chainHasDownload) return "download-piped-to-shell";
  }
  return null;
}

/** Does this token name a place on disk, in the Windows grammars? Switches are the thing to exclude: cmd's
 *  start with `/` and would otherwise read as absolute POSIX paths, PowerShell's start with `-`. */
function looksLikePath(tok) {
  if (!tok || tok.startsWith("-") || isCmdSwitch(tok)) return false;
  if (WIN_DRIVE_RE.test(tok) || WIN_DRIVE_BARE_RE.test(tok) || UNC_RE.test(tok)) return true;
  if (tok.startsWith("~") || tok.startsWith("/")) return true;
  if (tok.includes("../") || tok.includes("..\\")) return true;
  return /^(?:\$\{?HOME\}?|%USERPROFILE%|\$env:USERPROFILE)/i.test(tok);
}

function extractTargetsPowerShell(command, projectRootAbs) {
  const stripped = command.replace(URL_RE, (u) => " ".repeat(u.length));
  const targets = new Map();
  for (const { text, cwd } of segmentsWithCwd(stripped, projectRootAbs)) {
    if (!text.trim()) continue;
    const parsed = parseCommand(splitWords(text).map(unquote));
    if (!parsed) continue;
    const cmd = parsed.cmd.toLowerCase().replace(/\.exe$/, "");
    if (PS_CD_VERBS.has(cmd)) continue; // navigation is not a touch — same rule the POSIX lane applies to `cd`
    const write = PS_WRITE_VERBS.has(cmd);
    const outside = cwd !== projectRootAbs; // a relative arg counts once the statement has moved out of the project
    for (const tok of parsed.args) {
      if (!looksLikePath(tok) && !(write && outside && !tok.startsWith("-") && !isCmdSwitch(tok))) continue;
      const r = resolveTarget(tok, cwd);
      const prev = targets.get(r.path);
      targets.set(r.path, { write: (prev && prev.write) || write, unresolved: r.unresolved });
    }
  }
  return [...targets.entries()]
    .filter(([p]) => !DEV_STREAMS.test(p))
    .map(([p, v]) => ({ path: p, write: v.write, unresolved: v.unresolved }));
}

// ---- zones and targets (Phase 3): what does this command touch, once it's past the hard-shape check? ----

/** Splits on the same operators as splitStatements, PLUS `( … )` subshell scoping for cwd (a `cd` inside
 *  parens doesn't leak to what follows), and tracks the absolute directory each statement runs in after any
 *  preceding `cd`. `cwd` starts at `startCwd` (the project root) and is always an absolute POSIX path string. */
function segmentsWithCwd(command, startCwd) {
  const segs = [];
  const stack = [];
  let cwd = startCwd;
  let cur = "";
  let inS = false;
  let inD = false;
  let i = 0;
  const n = command.length;
  const applyCd = (text) => {
    const words = splitWords(text).map(unquote);
    const parsed = parseCommand(words);
    if (!parsed || parsed.cmd !== "cd") return;
    const rest = parsed.args.filter((a) => a !== "--");
    const arg = rest.length ? rest[0] : "~"; // bare `cd` goes home
    if (arg === "-" || UNRESOLVED_EXPANSION.test(arg)) return; // `cd -` / `cd "$var"` — can't know, leave cwd as-is
    const a = toCanonicalPath(arg);
    if (a === "~" || a === "~/") { cwd = homeCanon(); return; }
    if (a.startsWith("~/")) { cwd = path.posix.join(homeCanon(), a.slice(2)); return; }
    if (a.startsWith("/")) { cwd = path.posix.normalize(a); return; }
    cwd = path.posix.normalize(path.posix.join(cwd, a));
  };
  let sep = null;
  const push = (nextSep) => { const text = cur; segs.push({ sep, text, cwd }); cur = ""; sep = nextSep; applyCd(text); };
  while (i < n) {
    const c = command[i];
    if (inS) { cur += c; if (c === "'") inS = false; i++; continue; }
    if (inD) {
      if (c === "\\" && i + 1 < n) { cur += c + command[i + 1]; i += 2; continue; }
      cur += c; if (c === '"') inD = false; i++; continue;
    }
    if (c === "'") { inS = true; cur += c; i++; continue; }
    if (c === '"') { inD = true; cur += c; i++; continue; }
    if (c === "\\" && i + 1 < n) { cur += c + command[i + 1]; i += 2; continue; }
    if (c === "(") { push(null); stack.push(cwd); i++; continue; }
    if (c === ")") { push(null); cwd = stack.length ? stack.pop() : cwd; i++; continue; }
    if (c === "&" && command[i + 1] === "&") { push("&&"); i += 2; continue; }
    if (c === "|" && command[i + 1] === "|") { push("||"); i += 2; continue; }
    if (c === ";" || c === "|" || c === "&" || c === "\n") { push(c); i++; continue; }
    cur += c; i++;
  }
  push(null);
  return segs;
}

/** `~`/`$HOME` expansion (against the REAL home — GoodBehaviorBiz doesn't sandbox, so `~` really is `~`)
 *  then resolution against the statement's cwd. A target still carrying an unresolved `$`/backtick expansion
 *  is returned as-is with unresolved:true — never guessed into looking safe. */
function resolveTarget(raw, cwd) {
  let t = toCanonicalPath(raw);
  if (t === "~" || t === "~/") t = homeCanon();
  else if (t.startsWith("~/")) t = path.posix.join(homeCanon(), t.slice(2));
  else {
    // $HOME / ${HOME} (POSIX and Git Bash), %USERPROFILE% (cmd), $env:USERPROFILE (PowerShell) — the same
    // directory under four names. `~` is also what Git Bash reports for the Windows profile.
    const m = /^(?:\$\{HOME\}|\$HOME|%USERPROFILE%|\$env:USERPROFILE)(?=$|[\/])/i.exec(t);
    if (m) t = path.posix.join(homeCanon(), toCanonicalPath(t.slice(m[0].length)).replace(/^\//, ""));
  }
  if (UNRESOLVED_EXPANSION.test(t)) return { path: t, unresolved: true };
  if (t.startsWith("/")) return { path: path.posix.normalize(t), unresolved: false };
  return { path: path.posix.normalize(path.posix.join(cwd, t)), unresolved: false };
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`;|&)<>]*/gi;

/** Same length as `text`; quoted-interior chars become "Q" (delimiters and unquoted chars pass through). Used to
 *  find safe match POSITIONS for the two path regexes below without a real command word/arg tokenizer — content
 *  is then read back from the ORIGINAL text at those positions, so a value is never taken from inside a quote
 *  (a commit message quoting "/dev/tcp/" must not read as a path any more than it reads as a reverse-shell shape). */
function maskQuoted(text) {
  let out = "";
  let inS = false;
  let inD = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inS) { out += c === "'" ? c : "Q"; if (c === "'") inS = false; continue; }
    if (inD) {
      if (c === "\\" && i + 1 < text.length) { out += "QQ"; i++; continue; }
      out += c === '"' ? c : "Q";
      if (c === '"') inD = false;
      continue;
    }
    if (c === "'") { inS = true; out += c; continue; }
    if (c === '"') { inD = true; out += c; continue; }
    if (c === "\\" && i + 1 < text.length) { out += text[i] + text[i + 1]; i++; continue; }
    out += c;
  }
  return out;
}

/** The absolute/~ paths a command names, and whether each is a write target — statement-cwd aware. Not a full
 *  shell parser: write detection covers redirections, the write-verb list, and curl/wget output files; any
 *  other absolute/~/../ path mentioned is a read. URLs are stripped first so `https://host/path` is never
 *  misread as the path `//host/path`. */
function extractTargets(command, projectRootAbs) {
  const stripped = command.replace(URL_RE, (u) => " ".repeat(u.length));
  const segs = segmentsWithCwd(stripped, projectRootAbs);
  const targets = new Map(); // resolved path -> { write, unresolved }
  const add = (raw, write, cwd) => {
    const r = resolveTarget(raw, cwd);
    const prev = targets.get(r.path);
    targets.set(r.path, { write: (prev && prev.write) || write, unresolved: r.unresolved });
  };
  for (const { text, cwd } of segs) {
    if (!text.trim()) continue;
    const masked = maskQuoted(text);

    const redir = /(^|[^0-9<>&])>>?\s*("?~?\/?[^\s"';|&)]+)/gd;
    let m;
    while ((m = redir.exec(masked))) {
      const [gs, ge] = m.indices[2];
      add(text.slice(gs, ge).replace(/^["']|["']$/g, ""), true, cwd);
    }

    const words = splitWords(text).map(unquote);
    const parsed = parseCommand(words);
    if (parsed && WRITE_VERBS.has(parsed.cmd)) {
      const outside = cwd !== projectRootAbs; // a relative arg counts once the statement has cd'd out of the project
      for (const tok of parsed.args) {
        if (!tok || tok.startsWith("-")) continue;
        if (/^[~/]/.test(tok) || tok.includes("../") || outside) add(tok, true, cwd);
      }
    }
    if (parsed && parsed.cmd === "curl") {
      for (let k = 0; k < parsed.args.length; k++) {
        if ((parsed.args[k] === "-o" || parsed.args[k] === "--output") && parsed.args[k + 1]) { add(parsed.args[k + 1], true, cwd); k++; }
      }
    }
    if (parsed && parsed.cmd === "wget") {
      for (let k = 0; k < parsed.args.length; k++) {
        const a = parsed.args[k];
        if ((a === "-O" || a === "-o" || a === "--output-document") && parsed.args[k + 1] && parsed.args[k + 1] !== "-") { add(parsed.args[k + 1], true, cwd); k++; }
      }
    }

    // `cd`'s own destination is not a "read" — cwd-tracking already accounts for it, and flagging every plain
    // `cd /elsewhere` would ask on mere navigation before anything is actually touched there.
    if (!(parsed && parsed.cmd === "cd")) {
      const any = /(?:^|[\s=:,"'`(><|&])((?:~|\/)[^\s"'`;|&)<>]*|\.\.\/[^\s"'`;|&)<>]*)/gd;
      while ((m = any.exec(masked))) {
        const [gs, ge] = m.indices[1];
        const r = resolveTarget(text.slice(gs, ge), cwd);
        if (!targets.has(r.path)) targets.set(r.path, { write: false, unresolved: r.unresolved });
      }
    }
  }
  return [...targets.entries()]
    .filter(([p]) => !DEV_STREAMS.test(p))
    .map(([p, v]) => ({ path: p, write: v.write, unresolved: v.unresolved }));
}

/** project / project-adjacent (sibling of the project root) / system / home (catch-all — the common case, and
 *  also where any other stray absolute path lands: never assume "project" for something we're unsure about). */
function classifyZone(absPath, projectRootAbs) {
  const p = path.posix.normalize(absPath);
  const under = (root) => p === root || p.startsWith(root + "/");
  if (under(projectRootAbs)) return "project";
  if (scratchDirs().some(under)) return "home"; // temp-dir space is not system-owned — see scratchDirs()
  if (SYSTEM_PREFIXES.some((pre) => p === pre || p.startsWith(pre + "/"))) return "system";
  if (WIN_SYSTEM_PREFIX_RE.test(p)) return "system";
  const parent = path.posix.dirname(projectRootAbs);
  if (parent !== projectRootAbs && under(parent)) return "project-adjacent";
  return "home";
}

/** project (any action) is silent — the normal case. A sibling project READ is common (shared code, imports)
 *  and also silent. Everything else — sibling WRITEs, anything under home, anything under system — is gray:
 *  guarded lane asks, fast lane allows + audits (hard shapes deny in both, already handled before this runs). */
function isGray(write, zone) {
  if (zone === "project") return false;
  if (zone === "project-adjacent" && !write) return false;
  return true;
}

/** The project's own recorded lane (adopt-goodbehavior's "Confirmed lane" step) — NOT a live read of the
 *  session's actual permission mode, which hooks are never told (PreToolUse stdin carries no such field).
 *  Defaults to "guarded", the safer posture, if settings.json is missing/unreadable/says nothing. */
function readLane(cwd) {
  try {
    const base = process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd();
    const settings = JSON.parse(fs.readFileSync(path.join(base, ".claude", "settings.json"), "utf8"));
    if (settings.permissions && settings.permissions.defaultMode === "bypassPermissions") return "fast";
  } catch (e) { /* no settings.json, or unreadable — guarded is the safe default */ }
  return "guarded";
}

// ---- threat feeds (Phase 6): opt-in, monitor-mode only — never affects the deny/ask/allow decision above,
// only adds an extra audited line when a command matches a compiled feed rule. Reads pre-compiled rules.json
// only (no TOML/YAML/zip parsing at hook-invocation time — that only happens in `feeds update`). The matching
// logic here is intentionally a self-contained copy of scripts/feeds/evaluate.js, not a require() of it: this
// file must keep working when copied standalone to a machine-wide location (templates/OWNER-SETUP.md), where
// the surrounding scripts/feeds/ tree isn't present. Both copies are tested against the same real fixtures. ----

function feedsDir() { return process.env.GOODBEHAVIOR_FEEDS_DIR || path.join(HOME, ".goodbehavior", "feeds"); }
function feedOptedIn() { try { return fs.existsSync(path.join(feedsDir(), "opt-in")); } catch (e) { return false; } }
function readFeedRules(name) {
  try {
    const p = path.join(feedsDir(), name, "rules.json");
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(parsed.rules) ? parsed.rules : [];
  } catch (e) { return []; } // not fetched yet, or unreadable — no matches, never an error
}

/** Age in days of a feed's data, from its manifest `fetched_at`. null when unknown (never fetched, or
 *  unreadable) — callers treat null as STALE, never as fresh: an unknown age is not evidence of freshness. */
function feedAgeDays(name) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(feedsDir(), name, "manifest.json"), "utf8"));
    if (!m.fetched_at) return null;
    const ms = Date.now() - new Date(m.fetched_at).getTime();
    return ms >= 0 ? ms / 86400000 : null;
  } catch (e) { return null; }
}

// How long a feed's data stays good enough to act on. `urls` is the short one on purpose: URLhaus lists URLs
// *currently* distributing malware, so a stale copy asserts a fact it can no longer back.
const FEED_MAX_AGE_DAYS = { urls: 7, commands: 30, secrets: 30 };

/** deny | ask | monitor for one feed hit. Disposition tracks MATCH PRECISION, not the lane:
 *   urls     — exact string vs a live malware-distribution list. Denied. A bad entry can only block commands
 *              containing that exact URL, so the blast radius of a poisoned rule is bounded and recoverable
 *              (`feeds rollback`). Downgraded to ask when the list is stale.
 *   commands — Sigma, judged on CommandLine+Image only (rules needing unavailable fields are skipped at
 *              compile time, never guessed). Human judgment is exactly what's wanted: ask.
 *   secrets  — translated Go-RE2 regexes; the one feed with a demonstrated over-match (see checkFeeds).
 *              Asks where a human is present, monitors in the fast lane. Blocking cannot un-leak a credential
 *              that is already in the command, so the audit line is the real product here.
 * Lane is consulted ONLY for `secrets` — the noisiest feed defers to the lane; the precise ones don't. */
function feedDisposition(feed, lane) {
  const stale = !(feedAgeDays(feed) !== null && feedAgeDays(feed) <= (FEED_MAX_AGE_DAYS[feed] || 30));
  if (feed === "urls") return stale ? "ask" : "deny";
  if (feed === "commands") return "ask";
  if (feed === "secrets") return lane === "guarded" ? "ask" : "monitor";
  return "monitor";
}

/** Plain-language why, for a human deciding in the moment. Names the feed and rule id, NEVER the matched
 *  text — same redaction discipline as hard shapes, and it matters most for `secrets`, where echoing the
 *  match would copy the credential into the audit trail and the transcript. */
function feedReason(feed, id, disposition) {
  const age = feedAgeDays(feed);
  const when = age === null ? "age unknown" : `list fetched ${Math.floor(age)}d ago`;
  const tag = `feed:${feed}:${id}`;
  if (feed === "urls") {
    return disposition === "deny"
      ? `GoodBehavior guard-bash: blocked — this command contains a URL that URLhaus lists as currently ` +
        `distributing malware (${tag}, ${when}). The URL is not repeated here; the audit trail has the rule id.`
      : `GoodBehavior guard-bash: this command contains a URL listed by URLhaus as distributing malware ` +
        `(${tag}), but the list is stale (${when}) — held for your confirmation rather than blocked, because ` +
        `a stale list can no longer back the claim. Refresh with \`feeds update urls\`.`;
  }
  if (feed === "commands") {
    return `GoodBehavior guard-bash: this command matches a known-malicious command shape from the Sigma ` +
      `ruleset (${tag}, ${when}). Confirm only if you recognise it as legitimate for this project.`;
  }
  if (feed === "secrets") {
    return `GoodBehavior guard-bash: this command contains a credential-shaped pattern (${tag}, ${when}). ` +
      `If that is a real secret it will land in this project's audit trail and your shell history. Confirm ` +
      `only if you meant to pass it on the command line.`;
  }
  return `GoodBehavior guard-bash: matched ${tag} (${when}).`;
}

function feedMatchesPattern(text, pattern) {
  try { return new RegExp(pattern.source, pattern.flags).test(text); } catch (e) { return false; }
}
function feedMatcherMatches(matcher, fields) {
  const raw = fields[matcher.field];
  const values = Array.isArray(raw) ? raw : raw !== undefined && raw !== null ? [raw] : [];
  if (!values.length) return false;
  const oneMatches = (v) => matcher.all
    ? matcher.patterns.every((p) => feedMatchesPattern(v, p))
    : matcher.patterns.some((p) => feedMatchesPattern(v, p));
  return values.some(oneMatches);
}
function feedSelectionMatches(matchers, fields) { return matchers.every((m) => feedMatcherMatches(m, fields)); }
function feedNamesFor(glob, allNames) {
  const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return allNames.filter((n) => re.test(n));
}
function feedEvalCondition(cond, selections, fields) {
  switch (cond.t) {
    case "sel": { const m = selections[cond.name]; return Boolean(m) && feedSelectionMatches(m, fields); }
    case "of": {
      const names = feedNamesFor(cond.glob, Object.keys(selections));
      const hit = names.filter((n) => selections[n] && feedSelectionMatches(selections[n], fields));
      return cond.count === 1 ? hit.length > 0 : names.length > 0 && hit.length === names.length;
    }
    case "not": return !feedEvalCondition(cond.a, selections, fields);
    case "and": return feedEvalCondition(cond.a, selections, fields) && feedEvalCondition(cond.b, selections, fields);
    case "or": return feedEvalCondition(cond.a, selections, fields) || feedEvalCondition(cond.b, selections, fields);
    default: return false;
  }
}

/** All programs this (possibly compound) command invokes, across every statement — reuses the same
 *  splitter/parser as the hard-shape/zone checks above. Used as Sigma's "Image" field. */
function invokedPrograms(command) {
  const names = new Set();
  for (const { text } of splitStatements(command)) {
    const parsed = parseCommand(splitWords(text).map(unquote));
    if (parsed && parsed.cmd) names.add(parsed.cmd);
  }
  return [...names].map((n) => (n.startsWith("/") ? n : "/" + n)); // see evaluate.js header: endswith('/x') needs a leading slash even for a bare command name
}

/** URL-looking substrings in the (unquoted, per maskQuoted) parts of the command — same URL_RE already used
 *  to strip URLs before path-target extraction, reused here to find them instead. */
function commandUrls(command) {
  const masked = maskQuoted(command);
  const urls = [];
  let m;
  const re = new RegExp(URL_RE.source, "gi");
  while ((m = re.exec(masked))) urls.push(command.slice(m.index, m.index + m[0].length));
  return urls;
}

/** Returns [{feed, id}] for every compiled feed rule this command matches. Silent no-op (empty array, no
 *  file reads beyond the opt-in check) unless the owner/adopter has opted in via `node scripts/feeds.js opt-in`. */
function checkFeeds(command) {
  if (!feedOptedIn()) return [];
  const hits = [];
  const fields = { CommandLine: command, Image: invokedPrograms(command) };
  for (const rule of readFeedRules("commands")) {
    if (rule.sigma && feedEvalCondition(rule.sigma.condition, rule.sigma.selections, fields)) hits.push({ feed: "commands", id: rule.id });
  }
  for (const rule of readFeedRules("secrets")) {
    // gitleaks-compiled rules use {regex, flags}; feedMatchesPattern expects {source, flags} (the Sigma pattern
    // shape) — without this translation, pattern.source is undefined and new RegExp(undefined) matches
    // EVERY string. Caught live: a stale test feed made this visible as a hit on "git status".
    if (rule.regex !== undefined && feedMatchesPattern(command, { source: rule.regex, flags: rule.flags })) {
      hits.push({ feed: "secrets", id: rule.id });
    }
  }
  const urls = commandUrls(command);
  if (urls.length) {
    for (const rule of readFeedRules("urls")) {
      const set = rule.set && rule.set.urls;
      if (Array.isArray(set) && urls.some((u) => set.includes(u))) hits.push({ feed: "urls", id: rule.id });
    }
  }
  return hits;
}

// ---- audit ----

function auditPath(cwd) {
  const base = process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd();
  const dir = path.join(base, ".claude", "goodbehavior", "audit");
  const day = new Date().toISOString().slice(0, 10);
  return path.join(dir, `${day}.jsonl`);
}

function writeAudit(cwd, entry) {
  try {
    const p = auditPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + "\n");
  } catch (e) {
    // Best-effort: an audit-write failure must never block the decision path from completing.
  }
}

// ---- decision output ----

function emitDecision(permissionDecision, reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason,
    },
  };
  try { process.stdout.write(JSON.stringify(out)); } catch (e) { /* noop */ }
}
function emitDeny(reason) { emitDecision("deny", reason); }
function emitAsk(reason) { emitDecision("ask", reason); }

function denyClosed(reason, cwd, sessionId, toolName) {
  writeAudit(cwd, {
    timestamp: new Date().toISOString(),
    tool: toolName || "Bash",
    shape: `guard-error:${reason}`,
    decision: "deny",
    session_id: sessionId,
  });
  emitDeny(`GoodBehavior guard-bash: failing closed (${reason}) — could not evaluate the command safely, so it is denied.`);
  process.exit(0);
}

function main(input) {
  if (process.env.GUARD_BASH_TEST_FORCE_THROW) throw new Error("forced test throw");
  const toolName = input.tool_name || "";
  // Both command surfaces, not just Bash. On Windows the PowerShell tool is the primary shell and carries the
  // same `tool_input.command` field; subscribing to Bash alone left that whole surface unguarded.
  if (!GUARDED_TOOLS.has(toolName)) { process.exit(0); return; }
  const ps = toolName === "PowerShell";
  const command = (input.tool_input && input.tool_input.command) || "";
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || null;
  // `cwd` stays native (writeAudit and readLane build real filesystem paths from it); `root` is canonical
  // because every path comparison downstream happens in canonical space.
  const root = path.posix.normalize(toCanonicalPath(process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd()));

  const shape = ps ? detectShapePowerShell(command, root) : detectShape(command, root);
  if (shape) {
    writeAudit(cwd, { timestamp: new Date().toISOString(), tool: toolName, shape, decision: "deny", session_id: sessionId });
    emitDeny(
      `GoodBehavior guard-bash: blocked — matched hard shape "${shape}". This command is denied outright in ` +
      "the fast lane; the guard is a blocklist net, not a sandbox."
    );
    process.exit(0);
  }

  // Threat feeds (opt-in): every hit is audited with the disposition it earned; the strongest one can deny or
  // ask. Wrapped so a fault in feed logic degrades to monitor-only rather than riding the outer fail-closed
  // path — a bug here must never deny every command on the machine.
  let feedVerdict = null; // {disposition, feed, id}
  try {
    const feedLane = readLane(cwd);
    const RANK = { monitor: 0, ask: 1, deny: 2 };
    for (const hit of checkFeeds(command)) {
      const disposition = feedDisposition(hit.feed, feedLane);
      writeAudit(cwd, {
        timestamp: new Date().toISOString(), tool: toolName, shape: `feed:${hit.feed}:${hit.id}`,
        decision: disposition, session_id: sessionId,
      });
      if (!feedVerdict || RANK[disposition] > RANK[feedVerdict.disposition]) feedVerdict = { disposition, ...hit };
    }
  } catch (e) { feedVerdict = null; }

  if (feedVerdict && feedVerdict.disposition === "deny") {
    emitDeny(feedReason(feedVerdict.feed, feedVerdict.id, "deny"));
    process.exit(0);
  }
  if (feedVerdict && feedVerdict.disposition === "ask") {
    emitAsk(feedReason(feedVerdict.feed, feedVerdict.id, "ask"));
    process.exit(0);
  }

  // Past the hard shapes: does this command touch somewhere outside the project? (Phase 3 zone ladder.)
  let notable = null; // {zone, write, path} — the most notable target found, if any
  for (const t of (ps ? extractTargetsPowerShell(command, root) : extractTargets(command, root))) {
    const zone = t.unresolved ? "home" : classifyZone(t.path, root);
    if (!isGray(t.write, zone)) continue;
    if (!notable) notable = { zone, write: t.write, path: t.path };
    if (zone === "system") { notable = { zone, write: t.write, path: t.path }; break; } // most severe — stop looking
  }

  if (!notable) {
    writeAudit(cwd, { timestamp: new Date().toISOString(), tool: toolName, shape: null, decision: "allow", zone: "project", session_id: sessionId });
    process.exit(0);
  }

  const lane = readLane(cwd);
  if (lane === "guarded") {
    writeAudit(cwd, {
      timestamp: new Date().toISOString(), tool: toolName, shape: null, decision: "ask",
      zone: notable.zone, write: notable.write, session_id: sessionId,
    });
    emitAsk(
      `GoodBehavior guard-bash: this command ${notable.write ? "writes to" : "reads from"} "${notable.path}", ` +
      `outside the project (${notable.zone} zone) — confirm before proceeding.`
    );
    process.exit(0);
  }

  // fast lane: gray zones allow + audit (hard shapes already denied above)
  writeAudit(cwd, {
    timestamp: new Date().toISOString(), tool: toolName, shape: null, decision: "allow",
    zone: notable.zone, write: notable.write, session_id: sessionId,
  });
  process.exit(0);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => {
  let input = null;
  try {
    try {
      input = JSON.parse(buf);
    } catch (e) {
      denyClosed("malformed-stdin", null, null);
      return;
    }
    main(input);
  } catch (e) {
    denyClosed("internal-error", (input && input.cwd) || null, (input && input.session_id) || null,
      (input && input.tool_name) || null);
  }
});
