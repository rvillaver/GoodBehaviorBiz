/*
 * SigmaHQ release zip -> compiled command-shape rules. Design reference: BlitzPi's src/feeds/adapters/sigma.ts
 * (imports js-yaml) — re-derived here on our own zero-dependency ../yaml.js + ../zip.js.
 *
 * We only ever see ONE thing at runtime: the command line a Bash call is about to run (plus, approximately,
 * which program(s) it invokes). So this adapter keeps only the Sigma fields we can actually evaluate
 * (CommandLine, Image) and SKIPS — counting, never silently dropping — any rule that needs process context we
 * don't have (ParentImage, User, LogonId, CurrentDirectory, ...) in a POSITIVE position. A `not filter_*` that
 * needs such context is left unevaluated as "no filter" (more hits, never fewer) — which is exactly why this
 * whole feed is monitor-mode only: a rule that can fire more often than the real Sigma semantics intend must
 * never be allowed to deny anything on its own.
 */
"use strict";
const { parseYaml } = require("../yaml");
const { readZip } = require("../zip");

const RULE_DIRS = /^rules(?:-[a-z]+)?\/(linux|macos)\/process_creation\/[^/]+\.ya?ml$/;
const FIELD_MAP = { commandline: "CommandLine", image: "Image", originalfilename: "Image" };
const UNSUPPORTED_MODS = new Set(["base64", "base64offset", "utf16", "utf16le", "utf16be", "wide", "cidr", "lt", "lte", "gt", "gte", "expand", "fieldref"]);
const LEVEL = { informational: "low", low: "low", medium: "medium", high: "high", critical: "critical" };

function escapeRe(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
}

function toPattern(value, mods) {
  const v = String(value);
  const flags = mods.includes("cased") ? "" : "i";
  if (mods.includes("re")) return { source: v, flags }; // a raw Sigma |re value — caller try/catches on compile
  const body = escapeRe(v);
  if (mods.includes("contains")) return { source: body, flags };
  if (mods.includes("startswith")) return { source: `^${body}`, flags };
  if (mods.includes("endswith")) return { source: `${body}$`, flags };
  return { source: `^${body}$`, flags };
}

/** One Sigma selection (a map of field|mods -> value(s), or a list of such maps meaning OR-of-maps) ->
 *  matchers, or null if it needs a field/modifier we can't evaluate at all. */
function compileSelection(sel) {
  if (Array.isArray(sel)) {
    const parts = sel.map(compileSelection);
    if (parts.some((p) => p === null)) return null;
    const flat = parts.flat();
    // OR-of-AND-groups isn't representable in our flat matcher list — only fold when every map in the list
    // compiled to exactly one matcher (the common real-world case: OR of single field|mod checks).
    if (flat.length !== parts.length) return null;
    return [{ field: flat[0].field, all: false, patterns: flat.flatMap((m) => m.patterns) }];
  }
  if (!sel || typeof sel !== "object") return null;
  const matchers = [];
  for (const [key, raw] of Object.entries(sel)) {
    const [fieldName, ...mods] = key.split("|");
    const field = FIELD_MAP[fieldName.toLowerCase()];
    if (!field) return null;
    if (mods.some((m) => UNSUPPORTED_MODS.has(m))) return null;
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.length) return null;
    matchers.push({ field, all: mods.includes("all"), patterns: values.map((v) => toPattern(v, mods)) });
  }
  return matchers.length ? matchers : null;
}

// condition grammar: expr := term (('and'|'or') term)* ; term := 'not' term | '(' expr ')' | '1 of X' | 'all of X' | name
function parseCondition(src) {
  const toks = src.replace(/\(/g, " ( ").replace(/\)/g, " ) ").trim().split(/\s+/).filter(Boolean);
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  function term() {
    const t = next();
    if (t === undefined) throw new Error("unexpected end of condition");
    if (t.toLowerCase() === "not") return { t: "not", a: term() };
    if (t === "(") { const e = expr(); if (next() !== ")") throw new Error("missing )"); return e; }
    if ((t === "1" || t.toLowerCase() === "all") && (peek() || "").toLowerCase() === "of") {
      next();
      const g = next();
      if (!g) throw new Error("of what?");
      return { t: "of", count: t === "1" ? 1 : "all", glob: (g.toLowerCase() === "them" ? "*" : g).toLowerCase() };
    }
    if (/^\d+$/.test(t)) throw new Error(`unsupported count "${t} of"`);
    return { t: "sel", name: t };
  }
  function expr() {
    let left = term();
    while (peek() && /^(and|or)$/i.test(peek())) {
      const op = next().toLowerCase();
      left = { t: op, a: left, b: term() };
    }
    return left;
  }
  const out = expr();
  if (i !== toks.length) throw new Error(`trailing tokens in condition: ${toks.slice(i).join(" ")}`);
  return out;
}

function namesFor(glob, allNames) {
  const re = new RegExp(`^${escapeRe(glob)}$`, "i");
  return allNames.filter((n) => re.test(n));
}

/** Does this condition reference any selection we can't evaluate, in a POSITIVE (non-negated) position? Then
 *  the rule cannot fire correctly and must be skipped rather than silently under/over-matching. */
function needsUnsupported(cond, selections, negated) {
  const names = Object.keys(selections);
  switch (cond.t) {
    case "sel": return !negated && selections[cond.name] === null;
    case "of": return !negated && namesFor(cond.glob, names).some((n) => selections[n] === null);
    case "not": return needsUnsupported(cond.a, selections, !negated);
    default: return needsUnsupported(cond.a, selections, negated) || needsUnsupported(cond.b, selections, negated);
  }
}

function referenced(cond, allNames) {
  switch (cond.t) {
    case "sel": return [cond.name];
    case "of": return namesFor(cond.glob, allNames);
    case "not": return referenced(cond.a, allNames);
    default: return [...referenced(cond.a, allNames), ...referenced(cond.b, allNames)];
  }
}

function compileSigmaRule(yamlText, file) {
  let doc;
  try { doc = parseYaml(yamlText); } catch (e) { return { skip: `yaml: ${e instanceof Error ? e.message : String(e)}` }; }
  if (!doc || typeof doc !== "object" || !doc.detection || typeof doc.detection !== "object") return { skip: "no detection block" };
  const id = String(doc.id || file);
  const det = doc.detection;
  const condSrc = det.condition;
  if (typeof condSrc !== "string") return { skip: "condition is not a single string" };
  let condition;
  try { condition = parseCondition(condSrc); } catch (e) { return { skip: `condition: ${e instanceof Error ? e.message : String(e)}` }; }
  const selections = {};
  for (const [name, sel] of Object.entries(det)) {
    if (name === "condition") continue;
    try { selections[name] = compileSelection(sel); } catch (e) { selections[name] = null; }
  }
  const names = Object.keys(selections);
  const refs = referenced(condition, names);
  const unknown = refs.find((r) => !(r in selections));
  if (unknown) return { skip: `condition references unknown selection (${unknown})` };
  if (needsUnsupported(condition, selections, false)) return { skip: "needs fields we cannot evaluate (parent process, user, cwd, ...)" };
  const tags = Array.isArray(doc.tags) ? doc.tags.map(String) : [];
  return {
    rule: {
      id,
      category: "command",
      severity: LEVEL[String(doc.level || "medium").toLowerCase()] || "medium",
      description: String(doc.title || id),
      sigma: { selections, condition },
      meta: { file, tags: tags.filter((t) => t.startsWith("attack.")).slice(0, 8) },
    },
  };
}

function compileSigma(buf) {
  const entries = readZip(buf).filter((e) => RULE_DIRS.test(e.name));
  if (!entries.length) throw new Error("no rules/{linux,macos}/process_creation/*.yml found in the bundle");
  const rules = [];
  const skipped = [];
  for (const e of entries) {
    const r = compileSigmaRule(e.data().toString("utf8"), e.name);
    if (r.rule) rules.push(r.rule);
    else skipped.push({ id: e.name.split("/").pop(), reason: r.skip || "?" });
  }
  return { rules, skipped, sourceVersion: `sigma_all_rules.zip (${entries.length} linux/macos process_creation rules)` };
}

module.exports = { compileSelection, parseCondition, needsUnsupported, referenced, compileSigmaRule, compileSigma, toPattern, escapeRe };
