#!/usr/bin/env node
/*
 * GoodBehavior audit report — the mechanical half of /report-goodbehavior.
 *
 * Reads every <target>/.claude/goodbehavior/audit/YYYY-MM-DD.jsonl file, optionally filtered to a date
 * range, and aggregates into one JSON summary: totals by decision/tool/shape, and the full list of "notable"
 * entries — anything that wasn't a plain in-project allow (deny, ask, a fast-lane gray-zone allow, or an
 * injection annotation). The skill turns this into the owner-readable narrative; this script only does the
 * deterministic parsing/counting, same split as install.js/update.js.
 *
 * Usage: node scripts/report.js --target /path/to/project [--since YYYY-MM-DD] [--until YYYY-MM-DD]
 */
"use strict";
const fs = require("fs");
const path = require("path");

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  let target = null;
  let since = null;
  let until = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") target = argv[++i];
    else if (argv[i] === "--since") since = argv[++i];
    else if (argv[i] === "--until") until = argv[++i];
  }
  if (!target) die("error: --target is required");
  target = path.resolve(target);

  const auditDir = path.join(target, ".claude", "goodbehavior", "audit");
  const out = {
    target,
    period: { since: since || null, until: until || null, files: [] },
    totals: { events: 0, by_decision: {}, by_tool: {}, by_shape: {} },
    notable: [],
    warnings: [],
  };

  if (!fs.existsSync(auditDir)) {
    out.warnings.push(`no audit directory at ${auditDir} — nothing has been logged yet, or the guard isn't wired here`);
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return 0;
  }

  const files = fs.readdirSync(auditDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .filter((f) => (!since || f.slice(0, 10) >= since) && (!until || f.slice(0, 10) <= until))
    .sort();
  out.period.files = files;

  for (const f of files) {
    const lines = fs.readFileSync(path.join(auditDir, f), "utf8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch (e) { out.warnings.push(`${f}: unparseable line skipped`); continue; }
      out.totals.events++;
      const decision = entry.decision || "unknown";
      const tool = entry.tool || "unknown";
      out.totals.by_decision[decision] = (out.totals.by_decision[decision] || 0) + 1;
      out.totals.by_tool[tool] = (out.totals.by_tool[tool] || 0) + 1;
      if (entry.shape) out.totals.by_shape[entry.shape] = (out.totals.by_shape[entry.shape] || 0) + 1;
      // "notable" = anything that wasn't a plain silent in-project allow: a deny, an ask, a fast-lane
      // gray-zone allow (has a zone other than "project"), an injection annotation, or a threat-feed hit
      // (decision:"monitor", Phase 6) — a feed match is exactly the kind of thing this report exists to surface.
      const notable = decision === "deny" || decision === "ask" || decision === "annotated" || decision === "monitor" ||
        (decision === "allow" && entry.zone && entry.zone !== "project");
      if (notable) out.notable.push(entry);
    }
  }
  out.notable.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  return 0;
}

process.exit(main());
