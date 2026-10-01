#!/usr/bin/env node
/*
 * Feed-rule mute menu logic (scripts/feeds/mutes.js) — the data half of `feeds.js mute`.
 *
 * What's actually at stake here is the PRESELECTION. The menu arrives with boxes already ticked, so the
 * rule deciding which ones get ticked is the rule deciding what a hurried human silences. It must tick only
 * what this project's own audit trail shows has interrupted them, and it must never tick a `urls` rule —
 * that feed denies on a verbatim match against a live malware-distribution list, the one feed precise enough
 * to be worth the interruption.
 *
 * Fixtures are hand-built audit JSONL + rules.json, not live feed data: the question is the bookkeeping.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const mutes = require("../scripts/feeds/mutes");

const SIGMA_NOISY = { id: "r-nohup", category: "command", severity: "medium", description: "Nohup Execution",
  sigma: { selections: { sel: [{ field: "Image", all: false, patterns: [{ source: "/nohup$", flags: "i" }] }] }, condition: { t: "sel", name: "sel" } },
  meta: { file: "rules/linux/process_creation/nohup.yml", tags: [] } };
const SIGMA_QUIET = { id: "r-quiet", category: "command", severity: "low", description: "Never Fires Here",
  sigma: { selections: { sel: [{ field: "Image", all: false, patterns: [{ source: "/xyzzy$", flags: "i" }] }] }, condition: { t: "sel", name: "sel" } },
  meta: { file: "rules/linux/process_creation/xyzzy.yml", tags: [] } };
const SECRET = { id: "r-apikey", category: "secret", severity: "high", description: "Generic API Key", regex: "api[_-]?key", flags: "i" };
const URLRULE = { id: "r-badurl", category: "url", severity: "high", description: "Listed malware URL", set: { urls: ["http://bad.example.invalid/x"] } };

function mkFeeds(base) {
  const dir = path.join(base, "feeds");
  for (const [name, rules] of Object.entries({ commands: [SIGMA_NOISY, SIGMA_QUIET], secrets: [SECRET], urls: [URLRULE] })) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "rules.json"), JSON.stringify({ rules, skipped: [] }));
  }
  return dir;
}

/** A project whose audit trail holds the given [shape, decision] events, spread over two days so the
 *  multi-file read path is exercised too. */
function mkProject(base, events) {
  const dir = path.join(base, "proj");
  const auditDir = path.join(dir, ".claude", "goodbehavior", "audit");
  fs.mkdirSync(auditDir, { recursive: true });
  const days = ["2026-09-30", "2026-10-01"];
  const byDay = { [days[0]]: [], [days[1]]: [] };
  events.forEach(([shape, decision], i) => {
    byDay[days[i % 2]].push(JSON.stringify({ timestamp: `${days[i % 2]}T0${i % 10}:00:00.000Z`, tool: "Bash", shape, decision, session_id: "t" }));
  });
  for (const d of days) fs.writeFileSync(path.join(auditDir, `${d}.jsonl`), byDay[d].join("\n") + "\n");
  return dir;
}

function main() {
  const failures = [];
  const check = (label, cond, detail = "") => {
    if (cond) { console.log(`  PASS  ${label}`); return; }
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gb-mutes-"));
  try {
    const feedsDir = mkFeeds(base);
    const projectDir = mkProject(base, [
      ["feed:commands:r-nohup", "ask"], ["feed:commands:r-nohup", "ask"], ["feed:commands:r-nohup", "ask"],
      ["feed:secrets:r-apikey", "monitor"], ["feed:secrets:r-apikey", "monitor"],
      ["feed:urls:r-badurl", "deny"],
      [null, "allow"], ["sudo-doas", "deny"],      // non-feed lines must not be counted as rules
      ["feed:commands:r-gone", "ask"],             // fired, but no longer in the installed feed
    ]);

    {
      const t = mutes.auditTally(projectDir);
      check("tally: counts a rule across multiple audit files", t.get("r-nohup") && t.get("r-nohup").count === 3,
        JSON.stringify(t.get("r-nohup")));
      check("tally: separates asks from total sightings",
        t.get("r-apikey").count === 2 && t.get("r-apikey").asks === 0, JSON.stringify(t.get("r-apikey")));
      check("tally: ignores non-feed audit lines (zone decisions, hard shapes)", !t.has(null) && !t.has("sudo-doas"));
      check("tally: a deny counts as an interruption, same as an ask", t.get("r-badurl").asks === 1);
    }

    {
      const rows = mutes.buildRows({ projectDir, feedsDir });
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      check("rows: default source is the project's audit trail, not the whole corpus",
        !byId["r-quiet"], `rows=${rows.map((r) => r.id).join(",")}`);
      check("rows: loudest first — the ranking is the recommendation", rows[0].id === "r-nohup", rows[0].id);
      check("rows: PRESELECTS a rule that has actually interrupted this project", byId["r-nohup"].selected === true);
      check("rows: never preselects a urls rule, however often it fired", byId["r-badurl"].selected === false);
      check("rows: doesn't preselect a rule that only ever monitored (it never interrupted anyone)",
        byId["r-apikey"].selected === false);
      check("rows: carries the pattern summary, since the audit can't show the command",
        /nohup/.test(byId["r-nohup"].patterns), byId["r-nohup"].patterns);
      check("rows: a secrets rule renders its regex as the pattern", /api/.test(byId["r-apikey"].patterns), byId["r-apikey"].patterns);
      check("rows: a rule that fired but is no longer installed is still listed, and says so",
        byId["r-gone"] && /not in the installed feed|no longer installed/.test(byId["r-gone"].description + byId["r-gone"].patterns),
        JSON.stringify(byId["r-gone"]));
      check("rows: severity comes through for the human's judgment", byId["r-nohup"].severity === "medium");
    }

    {
      const all = mutes.buildRows({ projectDir, feedsDir, all: true });
      check("rows --all: widens to every installed rule", all.some((r) => r.id === "r-quiet"));
      check("rows --all: a never-fired rule is not preselected",
        all.find((r) => r.id === "r-quiet").selected === false);
    }

    {
      const rows = mutes.buildRows({ projectDir, feedsDir });
      const entries = mutes.applySelection(rows, ["r-nohup"], { reason: null });
      const file = mutes.writeMutes(projectDir, entries);
      check("write: lands at the per-project path the hook reads",
        file === path.join(projectDir, ".claude", "goodbehavior", "feeds-ignore.json"), file);
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      check("write: file explains itself to whoever opens it next", typeof onDisk._comment === "string" && /audited/.test(onDisk._comment));
      check("write: records a reason, so a mute isn't an unexplained silence",
        /audit trail/.test(onDisk.muted[0].reason), JSON.stringify(onDisk.muted[0]));
      check("write: records when it was muted", Boolean(onDisk.muted[0].muted_at));

      const reread = mutes.buildRows({ projectDir, feedsDir });
      const nohup = reread.find((r) => r.id === "r-nohup");
      check("round-trip: an already-muted rule reads back as muted", nohup.muted === true);
      check("round-trip: and stays selected, so writing again doesn't silently un-mute it", nohup.selected === true);

      const again = mutes.applySelection(reread, ["r-nohup"], { reason: "a different reason" });
      check("round-trip: re-writing preserves the ORIGINAL reason and date (not rewritten history)",
        again[0].reason === onDisk.muted[0].reason && again[0].muted_at === onDisk.muted[0].muted_at,
        JSON.stringify(again[0]));
    }

    {
      const p = path.join(projectDir, ".claude", "goodbehavior", "feeds-ignore.json");
      fs.writeFileSync(p, "{ not json at all");
      check("degrade: a malformed mute file reads as NO mutes (never as all of them)", mutes.readMutes(projectDir).length === 0);
      fs.writeFileSync(p, JSON.stringify({ muted: [{ nope: 1 }, "r-nohup", { id: "r-nohup" }] }));
      check("degrade: entries without a string id are dropped, the valid one survives",
        mutes.readMutes(projectDir).length === 1 && mutes.readMutes(projectDir)[0].id === "r-nohup");
      fs.rmSync(p);
      check("degrade: no mute file at all is simply no mutes", mutes.readMutes(projectDir).length === 0);
    }

    // The menu loop's behavior, without a pty. feeds.js's readline wrapper only renders and reads a line;
    // every decision is here. A typo must never commit a mute — that's the one input the loop can't guess at.
    {
      const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
      const sel = (ids) => new Set(ids);
      const step = (selected, input) => mutes.applyMenuInput(rows, selected, input);

      check("menu: a row number toggles that row ON", step(sel([]), "2").selected.has("b"));
      check("menu: the same number toggles it back OFF", !step(sel(["b"]), "2").selected.has("b"));
      check("menu: several numbers in one line all toggle",
        ["a", "c"].every((id) => step(sel([]), "1 3").selected.has(id)) && !step(sel([]), "1 3").selected.has("b"));
      check("menu: commas work as well as spaces", step(sel([]), "1,3").selected.size === 2);
      check("menu: 'a' selects all", step(sel([]), "a").selected.size === 3);
      check("menu: 'n' clears the selection", step(sel(["a", "b"]), "n").selected.size === 0);
      check("menu: 'q' quits and the caller writes nothing", step(sel(["a"]), "q").action === "quit");
      check("menu: 'w' writes", step(sel(["a"]), "w").action === "write");
      check("menu: a bare Enter means write (the preselection is the default)", step(sel(["a"]), "").action === "write");
      check("menu: toggling keeps looping rather than writing", step(sel([]), "1").action === "continue");
      check("menu: an out-of-range number is an error, not a write",
        step(sel([]), "9").action === "error" && step(sel([]), "9").bad[0] === "9");
      check("menu: a typo is an error, not a write (a mistyped line must never commit a mute)",
        step(sel(["a"]), "yes").action === "error");
      check("menu: an error leaves the selection untouched",
        step(sel(["a"]), "nope").selected.has("a") && step(sel(["a"]), "nope").selected.size === 1);
      check("menu: a partly-valid line is rejected whole, not applied halfway",
        step(sel([]), "1 99").action === "error" && step(sel([]), "1 99").selected.size === 0);
      check("menu: input is case-insensitive and tolerates padding", step(sel([]), "  W  ").action === "write");
      check("menu: EOF (no input at all) QUITS — a closed pipe is not a keystroke and must not commit a mute",
        step(sel(["a"]), null).action === "quit" && step(sel(["a"]), undefined).action === "quit");
      check("menu: but a bare Enter still means write — a real keystroke, unlike EOF",
        step(sel(["a"]), "").action === "write");
    }

    {
      const empty = path.join(base, "empty-proj");
      fs.mkdirSync(empty, { recursive: true });
      check("empty project: no audit trail yet -> no rows, no crash",
        mutes.buildRows({ projectDir: empty, feedsDir }).length === 0);
      check("empty project: tally on a missing audit dir is empty, not an error",
        mutes.auditTally(empty).size === 0);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }

  console.log(`test_mutes: ${failures.length ? "FAILED: " + failures.join("; ") : "all passed"}`);
  return failures.length ? 1 : 0;
}

process.exit(main());
