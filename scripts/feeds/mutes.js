/*
 * Per-project feed-rule mutes — the data half of `feeds.js mute`.
 *
 * Why this exists: a hook `ask` gets the host's bare yes/no prompt. There is no "always allow" for a hook
 * decision, so the same rule re-asks on every match forever — one rule asked a real user 115 times in three
 * weeks and got "yes" 115 times. The hook therefore has to carry its own memory, and this is it.
 *
 * A mute is a claim about one codebase's normal work ("this repo greps for the word password"), so it lives in
 * that project's tree where a reader can see it, not machine-wide. A muted rule still matches and is still
 * audited — it only stops DECIDING (floored at `monitor` in guard-bash.js's feedDisposition). Nothing here can
 * make a hit invisible; that is the point.
 *
 * Pure data + rendering only: the interactive menu lives in scripts/feeds.js, where the human is.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const MUTE_FILE = path.join(".claude", "goodbehavior", "feeds-ignore.json");
const FEED_NAMES = ["commands", "secrets", "urls"];

function mutePath(projectDir) { return path.join(projectDir, MUTE_FILE); }

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

/** Current mutes, newest first. Malformed file reads as "no mutes" — the safe direction, and the same
 *  degradation guard-bash.js's own reader takes. */
function readMutes(projectDir) {
  const parsed = readJson(mutePath(projectDir));
  const muted = parsed && Array.isArray(parsed.muted) ? parsed.muted : [];
  return muted.filter((e) => e && typeof e.id === "string");
}

function writeMutes(projectDir, entries) {
  const p = mutePath(projectDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = {
    _comment: "Feed rules this project has muted. A muted rule is still matched and still audited — it just " +
      "stops asking. Written by `feeds.js mute`; safe to edit by hand. Remove an entry to un-mute.",
    muted: entries.slice().sort((a, b) => String(a.description || a.id).localeCompare(String(b.description || b.id))),
  };
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + "\n");
  return p;
}

/** How often each feed rule has fired in this project's own audit trail, by rule id.
 *  The audit records the rule id and never the command text, so this can say WHICH rule fired and HOW OFTEN,
 *  never what was run when it fired. That redaction is deliberate; don't "fix" it by logging commands. */
function auditTally(projectDir) {
  const dir = path.join(projectDir, ".claude", "goodbehavior", "audit");
  const tally = new Map(); // id -> {feed, id, count, asks, last}
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch (e) { return tally; }
  for (const f of files.sort()) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n"); } catch (e) { continue; }
    for (const line of lines) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch (e) { continue; } // a truncated tail line is not a reason to fail
      const shape = typeof o.shape === "string" ? o.shape : "";
      if (!shape.startsWith("feed:")) continue;
      const [, feed, ...rest] = shape.split(":");
      const id = rest.join(":");
      if (!id) continue;
      const cur = tally.get(id) || { id, feed, count: 0, asks: 0, last: null };
      cur.count += 1;
      if (o.decision === "ask" || o.decision === "deny") cur.asks += 1;
      if (o.timestamp) cur.last = o.timestamp;
      tally.set(id, cur);
    }
  }
  return tally;
}

/** Compact, human-readable summary of what a rule actually matches — the thing a person needs in order to
 *  judge it, since the audit cannot show them the command. Sigma selections render as `field: a | b`;
 *  a gitleaks rule renders as its regex. Truncated: this is a menu line, not documentation. */
function describePatterns(rule, max = 2) {
  const parts = [];
  if (rule && rule.sigma && rule.sigma.selections) {
    for (const matchers of Object.values(rule.sigma.selections)) {
      for (const m of (Array.isArray(matchers) ? matchers : [matchers])) {
        if (!m || !Array.isArray(m.patterns)) continue;
        const pats = m.patterns.map((p) => (p && p.source) || "").filter(Boolean);
        if (pats.length) parts.push(`${m.field}: ${pats.slice(0, 4).join(" | ")}${pats.length > 4 ? " | …" : ""}`);
      }
    }
  } else if (rule && rule.regex) {
    parts.push(String(rule.regex));
  }
  const shown = parts.slice(0, max).join("  ·  ");
  const more = parts.length > max ? `  (+${parts.length - max} more)` : "";
  return (shown + more).slice(0, 150) || "(no pattern recorded)";
}

/** Every rule across the installed feeds, by id. */
function ruleIndex(feedsDir) {
  const index = new Map();
  for (const feed of FEED_NAMES) {
    const parsed = readJson(path.join(feedsDir, feed, "rules.json"));
    for (const rule of (parsed && Array.isArray(parsed.rules) ? parsed.rules : [])) {
      if (rule && typeof rule.id === "string") index.set(rule.id, { feed, rule });
    }
  }
  return index;
}

/** The menu's rows.
 *
 *  Default source is THIS PROJECT'S AUDIT TRAIL, not the full corpus: of 121 installed Sigma rules, ten
 *  produced 97% of one user's interruptions. Listing all 121 would bury the ten that matter. `all: true`
 *  widens it to every installed rule for when you want to look ahead instead of back.
 *
 *  Preselection: a rule arrives checked when it has actually interrupted this project (asks > 0) and is not a
 *  `urls` rule. `urls` is never preselected — it denies on a verbatim match against a live
 *  malware-distribution list, which is the one feed precise enough to be worth the interruption. It can still
 *  be muted deliberately; it just never gets muted by a default. */
function buildRows({ projectDir, feedsDir, all = false }) {
  const tally = auditTally(projectDir);
  const index = ruleIndex(feedsDir);
  const mutedNow = new Map(readMutes(projectDir).map((e) => [e.id, e]));

  const ids = new Set(all ? index.keys() : []);
  for (const id of tally.keys()) ids.add(id);
  for (const id of mutedNow.keys()) ids.add(id);

  const rows = [];
  for (const id of ids) {
    const hit = tally.get(id);
    const known = index.get(id);
    const prior = mutedNow.get(id);
    const feed = (hit && hit.feed) || (known && known.feed) || (prior && prior.feed) || "?";
    rows.push({
      id,
      feed,
      description: (known && known.rule.description) || (prior && prior.description) ||
        "(not in the installed feed — muted earlier, or the feed changed)",
      severity: (known && known.rule.severity) || "?",
      file: (known && known.rule.meta && known.rule.meta.file) || null,
      patterns: known ? describePatterns(known.rule) : "(rule no longer installed)",
      count: hit ? hit.count : 0,
      asks: hit ? hit.asks : 0,
      last: hit ? hit.last : null,
      muted: Boolean(prior),
      reason: prior ? prior.reason : null,
      muted_at: prior ? prior.muted_at : null,
      selected: Boolean(prior) || Boolean(hit && hit.asks > 0 && feed !== "urls"),
    });
  }
  // Loudest first — the ranking IS the recommendation. Ties fall back to the description so the order is
  // stable across runs (a menu whose numbering moves between runs is a menu you can mis-click).
  rows.sort((a, b) => b.asks - a.asks || b.count - a.count || String(a.description).localeCompare(String(b.description)));
  return rows;
}

/** Fold a selection back into mute entries, preserving the reason/date of ones already muted so re-running
 *  the menu and writing again doesn't rewrite history. */
function applySelection(rows, selectedIds, { reason = null, now = new Date().toISOString() } = {}) {
  const chosen = new Set(selectedIds);
  const out = [];
  for (const r of rows) {
    if (!chosen.has(r.id)) continue;
    out.push({
      id: r.id,
      feed: r.feed,
      description: r.description,
      reason: r.muted && r.reason ? r.reason : (reason || `benign in this project (${r.asks} ask${r.asks === 1 ? "" : "s"} in the audit trail)`),
      muted_at: r.muted ? (r.muted_at || now) : now,
    });
  }
  return out;
}

/** One menu keystroke-line, applied to a selection. Pure on purpose: the menu's behavior is the part worth
 *  testing, and it should not need a pty to test it — the readline wrapper in feeds.js stays thin enough to
 *  read. Returns the next selection plus what the caller should do: keep looping, write, or quit.
 *
 *  An unrecognized line is an `error` the caller re-prompts on. It is never silently treated as "write":
 *  a typo must not commit a mute. */
function applyMenuInput(rows, selected, input) {
  const next = new Set(selected);
  // No input at all (EOF — stdin closed) is a QUIT, never a write. A bare Enter is a deliberate keystroke and
  // does mean "write the preselection"; a closed pipe is not a keystroke, and must not commit a mute.
  if (input == null) return { selected: next, action: "quit" };
  const answer = String(input).trim().toLowerCase();
  if (answer === "q") return { selected: next, action: "quit" };
  if (answer === "w" || answer === "") return { selected: next, action: "write" };
  if (answer === "a") { rows.forEach((r) => next.add(r.id)); return { selected: next, action: "continue" }; }
  if (answer === "n") { next.clear(); return { selected: next, action: "continue" }; }

  const tokens = answer.split(/[\s,]+/).filter(Boolean);
  const bad = tokens.filter((t) => !/^\d+$/.test(t) || +t < 1 || +t > rows.length);
  if (bad.length || !tokens.length) return { selected: next, action: "error", bad };
  for (const t of tokens) {
    const id = rows[+t - 1].id;
    if (next.has(id)) next.delete(id); else next.add(id);
  }
  return { selected: next, action: "continue" };
}

module.exports = { MUTE_FILE, mutePath, readMutes, writeMutes, auditTally, ruleIndex, describePatterns, buildRows, applySelection, applyMenuInput };
