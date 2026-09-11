#!/usr/bin/env node
/*
 * report.js aggregation tests — synthesize audit JSONL matching guard-bash.js/guard-injection.js's real
 * entry shapes, run the script, and check totals/notable-filtering/date-scoping/missing-dir handling.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPORT = path.join(__dirname, "..", "scripts", "report.js");

function writeAuditFile(target, date, entries) {
  const dir = path.join(target, ".claude", "goodbehavior", "audit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${date}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function runReport(target, extraArgs = []) {
  const r = spawnSync("node", [REPORT, "--target", target, ...extraArgs], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`report.js failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function main() {
  const failures = [];
  const check = (label, cond, detail = "") => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond) failures.push(`${label} ${detail}`);
  };

  const target = fs.mkdtempSync(path.join(os.tmpdir(), "gb-report-"));
  try {
    // no audit dir at all yet
    {
      const out = runReport(target);
      check("no audit dir: reports zero events, not an error", out.totals.events === 0);
      check("no audit dir: warns rather than silently reporting empty", out.warnings.length === 1);
    }

    writeAuditFile(target, "2026-09-10", [
      { timestamp: "2026-09-10T10:00:00Z", tool: "Bash", shape: "sudo-doas", decision: "deny", session_id: "s1" },
      { timestamp: "2026-09-10T10:01:00Z", tool: "Bash", shape: null, decision: "allow", zone: "project", session_id: "s1" },
      { timestamp: "2026-09-10T10:02:00Z", tool: "Bash", shape: null, decision: "ask", zone: "home", write: true, session_id: "s1" },
    ]);
    writeAuditFile(target, "2026-09-11", [
      { timestamp: "2026-09-11T09:00:00Z", tool: "Bash", shape: null, decision: "allow", zone: "home", write: true, session_id: "s2" },
      { timestamp: "2026-09-11T09:01:00Z", tool: "UserPromptSubmit", shape: "ignore-instructions", decision: "annotated", session_id: "s2" },
      { timestamp: "2026-09-11T09:02:00Z", tool: "PostToolUse:Read", shape: "exfiltrate", decision: "annotated", session_id: "s2" },
      { timestamp: "2026-09-11T09:03:00Z", tool: "Bash", shape: null, decision: "allow", zone: "project", session_id: "s2" },
      { timestamp: "2026-09-11T09:04:00Z", tool: "Bash", shape: "feed:commands:80915f59-9b56-4616-9de0-fd0dea6c12fe", decision: "monitor", session_id: "s2" },
    ]);

    const out = runReport(target);
    check("totals: all 8 events counted", out.totals.events === 8);
    check("totals by_decision correct",
      out.totals.by_decision.deny === 1 && out.totals.by_decision.allow === 3 &&
      out.totals.by_decision.ask === 1 && out.totals.by_decision.annotated === 2 && out.totals.by_decision.monitor === 1);
    check("totals by_tool correct", out.totals.by_tool.Bash === 6 && out.totals.by_tool.UserPromptSubmit === 1 && out.totals.by_tool["PostToolUse:Read"] === 1);
    check("totals by_shape correct", out.totals.by_shape["sudo-doas"] === 1 && out.totals.by_shape["ignore-instructions"] === 1 && out.totals.by_shape.exfiltrate === 1);

    check("notable excludes the two plain project-zone allows",
      !out.notable.some((e) => e.decision === "allow" && e.zone === "project"));
    check("notable includes the deny", out.notable.some((e) => e.decision === "deny"));
    check("notable includes the ask", out.notable.some((e) => e.decision === "ask"));
    check("notable includes both annotated entries", out.notable.filter((e) => e.decision === "annotated").length === 2);
    check("notable includes the fast-lane gray-zone allow (zone home, decision allow)",
      out.notable.some((e) => e.decision === "allow" && e.zone === "home"));
    check("notable includes the threat-feed monitor hit (found live: this was missing before the fix)",
      out.notable.some((e) => e.decision === "monitor" && e.shape && e.shape.startsWith("feed:")));
    check("notable count is exactly 6 (8 total minus 2 plain allows)", out.notable.length === 6);
    check("notable sorted chronologically", out.notable.every((e, i) => i === 0 || String(out.notable[i - 1].timestamp) <= String(e.timestamp)));

    // date scoping
    {
      const scoped = runReport(target, ["--since", "2026-09-11", "--until", "2026-09-11"]);
      check("--since/--until scopes to one file", scoped.period.files.length === 1 && scoped.period.files[0] === "2026-09-11.jsonl");
      check("--since/--until scopes totals accordingly", scoped.totals.events === 5);
    }

    // malformed line in a file is skipped with a warning, not a crash
    {
      const dir = path.join(target, ".claude", "goodbehavior", "audit");
      fs.appendFileSync(path.join(dir, "2026-09-10.jsonl"), "not valid json\n");
      const out2 = runReport(target);
      check("malformed line skipped, not crashed", out2.totals.events === 8 && out2.warnings.some((w) => w.includes("unparseable")));
    }
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }

  console.log(`test_report: ${(failures.length === 0) ? "all passed" : "FAILED: " + failures.join("; ")}`);
  return failures.length ? 1 : 0;
}

process.exit(main());
