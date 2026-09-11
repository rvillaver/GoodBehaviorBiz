/*
 * URLhaus (abuse.ch) plain-text URL list -> compiled URL rules. No parser needed: one URL per line, no header,
 * no comments (confirmed against the real feed this was built against). Exact-URL matching only for this first
 * cut — not host-based: a listed host can be a shared platform (GitHub, Drive, pastebin...) where blocking the
 * whole host would be far too broad; BlitzPi's own design special-cases that distinction, which we don't need
 * to replicate for a monitor-only v1 (exact-URL matches are still a real, useful signal on their own).
 */
"use strict";

function compileUrlhaus(raw) {
  const urls = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const set = new Set(urls);
  // No rule at all when the set is empty (rather than one rule wrapping an empty list) — keeps the store's
  // generic "compiled to zero rules -> refuse the update" guard meaningful for this adapter too.
  const rules = set.size
    ? [{ id: "urlhaus-listed-url", category: "url", severity: "high", description: "URL currently listed by URLhaus as distributing malware", set: { urls: [...set] } }]
    : [];
  return { rules, skipped: [], count: set.size };
}

module.exports = { compileUrlhaus };
