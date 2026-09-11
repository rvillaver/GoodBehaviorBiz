/*
 * Evaluates a compiled Sigma rule's {selections, condition} tree against observed fields (CommandLine, Image).
 * Separate from the compiler on purpose: this runs on every guarded Bash call (guard-bash.js), the compiler
 * only runs during `feeds update` — keeping the hot path to plain regex tests over pre-compiled JSON, no
 * TOML/YAML/zip parsing at hook-invocation time.
 *
 * `Image` values should be normalized to start with "/" before calling (e.g. "nc" -> "/nc") — real Sigma rules
 * almost always write `Image|endswith: '/nc'` (matching any full path ending in the program name), and a
 * bash command is usually typed bare with no path at all; without the synthetic leading slash, endswith
 * patterns would never match a bare command name. Confirmed against real SigmaHQ rules this session — without
 * this, the netcat-reverse-shell rule (and most Image-based rules) never fire on ordinary shell usage.
 */
"use strict";

function matchesPattern(text, pattern) {
  try { return new RegExp(pattern.source, pattern.flags).test(text); } catch (e) { return false; }
}

function matcherMatches(matcher, fields) {
  const raw = fields[matcher.field];
  const values = Array.isArray(raw) ? raw : raw !== undefined && raw !== null ? [raw] : [];
  if (!values.length) return false;
  const oneValueMatches = (v) => matcher.all
    ? matcher.patterns.every((p) => matchesPattern(v, p))
    : matcher.patterns.some((p) => matchesPattern(v, p));
  return values.some(oneValueMatches);
}

function selectionMatches(matchers, fields) {
  return matchers.every((m) => matcherMatches(m, fields));
}

function escapeRe(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
}

function namesFor(glob, allNames) {
  const re = new RegExp(`^${escapeRe(glob)}$`, "i");
  return allNames.filter((n) => re.test(n));
}

function evaluateSigmaCondition(cond, selections, fields) {
  switch (cond.t) {
    case "sel": {
      const matchers = selections[cond.name];
      return Boolean(matchers) && selectionMatches(matchers, fields);
    }
    case "of": {
      const names = namesFor(cond.glob, Object.keys(selections));
      const matches = names.filter((n) => selections[n] && selectionMatches(selections[n], fields));
      return cond.count === 1 ? matches.length > 0 : names.length > 0 && matches.length === names.length;
    }
    case "not": return !evaluateSigmaCondition(cond.a, selections, fields);
    case "and": return evaluateSigmaCondition(cond.a, selections, fields) && evaluateSigmaCondition(cond.b, selections, fields);
    case "or": return evaluateSigmaCondition(cond.a, selections, fields) || evaluateSigmaCondition(cond.b, selections, fields);
    default: return false;
  }
}

/** True if `rule.sigma.{selections,condition}` matches these command fields. */
function sigmaRuleMatches(rule, fields) {
  return evaluateSigmaCondition(rule.sigma.condition, rule.sigma.selections, fields);
}

/** True if any gitleaks-style {regex, flags} rule matches the given text. */
function regexRuleMatches(rule, text) {
  try { return new RegExp(rule.regex, rule.flags).test(text); } catch (e) { return false; }
}

/** True if `url` is exactly listed in a compiled urlhaus rule's set. */
function urlSetMatches(rule, url) {
  return Array.isArray(rule.set && rule.set.urls) && rule.set.urls.includes(url);
}

module.exports = { evaluateSigmaCondition, sigmaRuleMatches, regexRuleMatches, urlSetMatches, matchesPattern };
