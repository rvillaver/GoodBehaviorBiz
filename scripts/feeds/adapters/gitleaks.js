/*
 * gitleaks.toml -> compiled secret rules. Design reference: BlitzPi's src/feeds/adapters/gitleaks.ts (which
 * imports a third-party TOML library) — re-derived here on top of our own zero-dependency ../toml.js.
 *
 * gitleaks regexes are Go RE2. The one translation that matters for real rules: inline flags. `(?i)` at the
 * start becomes JS's `i` flag; a mid-pattern `(?i)` is removed and the whole rule made case-insensitive
 * (slightly broader match — acceptable for a monitor-only signal). Rules whose regex still doesn't compile as
 * JS RegExp (e.g. POSIX character classes like [[:alnum:]], which RE2 supports and JS doesn't) are skipped and
 * counted, never silently dropped.
 */
"use strict";
const { parseToml } = require("../toml");

function toJsRegex(src) {
  let s = src;
  let flags = "";
  if (s.startsWith("(?i)")) { s = s.slice(4); flags += "i"; }
  if (/\(\?i\)/.test(s)) { s = s.replace(/\(\?i\)/g, ""); if (!flags.includes("i")) flags += "i"; }
  s = s.replace(/\(\?[ims]+\)/g, ""); // any other inline flag group: drop (rare, best-effort)
  s = s.replace(/\\z/g, "$"); // Go end-of-text -> JS end-of-string (close enough without multiline mode)
  s = s.replace(/\(\?P</g, "(?<"); // Python/PCRE named-group syntax -> JS's (confirmed against the real feed:
  // this alone fixed the only real-regex skip in all 222 rules of the live gitleaks.toml checked this session)
  return { regex: s, flags };
}

// A real gitleaks.toml carries 200+ rules. This floor exists because the parser is deliberately permissive
// (never throws on unrecognized syntax, just skips it) — fetch the WRONG document (confirmed live: gitleaks'
// own README.md contains example `[[rules]]` blocks as documentation) and it would otherwise "successfully"
// compile a handful of spurious rules instead of failing loudly. A real feed is never this small.
const MIN_PLAUSIBLE_RULES = 20;

function compileGitleaks(raw) {
  const doc = parseToml(raw);
  if (!Array.isArray(doc.rules) || doc.rules.length < MIN_PLAUSIBLE_RULES) {
    throw new Error(`not a gitleaks config: found ${Array.isArray(doc.rules) ? doc.rules.length : 0} [[rules]] entries, expected ${MIN_PLAUSIBLE_RULES}+`);
  }
  const rules = [];
  const skipped = [];
  for (const r of doc.rules) {
    const id = String(r.id || "");
    if (!id || !r.regex) { skipped.push({ id: id || "?", reason: "no id/regex" }); continue; }
    const { regex, flags } = toJsRegex(r.regex);
    try { new RegExp(regex, flags); } catch (e) {
      skipped.push({ id, reason: `regex: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    rules.push({
      id,
      category: "secret",
      severity: "high",
      description: String(r.description || id),
      regex,
      flags,
      keywords: (r.keywords || []).map((k) => String(k).toLowerCase()),
    });
  }
  return { rules, skipped, sourceVersion: typeof doc.title === "string" ? doc.title : undefined };
}

module.exports = { toJsRegex, compileGitleaks };
