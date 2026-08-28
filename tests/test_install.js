#!/usr/bin/env node
/*
 * install.js round-trip test — installs the REAL bundle into a temp target and checks the guarantees:
 * only planned profiles land (never all four), the manifest records true sha256s, settings.json merges
 * without duplication, existing files are never clobbered, and a re-run is a clean no-op.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const INSTALL = path.join(ROOT, "scripts", "install.js");

const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function runInstall(planPath) {
  const r = spawnSync("node", [INSTALL, "--plan", planPath], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`install.js failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function main() {
  const failures = [];
  const check = (label, cond, detail = "") => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond) failures.push(`${label} ${detail}`);
  };

  const target = fs.mkdtempSync(path.join(os.tmpdir(), "gb-install-"));
  try {
    // a fake existing project file that must never be clobbered
    fs.mkdirSync(path.join(target, ".claude", "skills", "verify-goodbehavior"), { recursive: true });
    const sentinel = path.join(target, ".claude", "skills", "verify-goodbehavior", "SKILL.md");
    fs.writeFileSync(sentinel, "LOCAL ADAPTATION — do not clobber\n");
    // a pre-existing settings.json with the user's own hook that must survive the merge
    fs.writeFileSync(path.join(target, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));

    const plan = {
      source: ROOT, target,
      skills: ["verify-goodbehavior", "learn-goodbehavior", "update-goodbehavior"],
      profiles: ["analysis", "development"],
      hook: true,
      templates: { "docs/plans/ROADMAP.md": "templates/ROADMAP.md" },
    };
    const planPath = path.join(target, "plan.json");
    fs.writeFileSync(planPath, JSON.stringify(plan));

    const report = runInstall(planPath);

    check("planned skills copied", fs.existsSync(path.join(target, ".claude/skills/learn-goodbehavior/SKILL.md")));
    check("planned profiles copied",
      fs.existsSync(path.join(target, ".claude/goodbehavior/profiles/analysis.md")) &&
      fs.existsSync(path.join(target, ".claude/goodbehavior/profiles/development.md")));
    check("UNplanned profiles absent (minimal footprint)",
      !fs.existsSync(path.join(target, ".claude/goodbehavior/profiles/creative.md")) &&
      !fs.existsSync(path.join(target, ".claude/goodbehavior/profiles/research.md")));
    check("template landed", fs.existsSync(path.join(target, "docs/plans/ROADMAP.md")));
    let execOk = true;
    try { fs.accessSync(path.join(target, ".claude/hooks/done-gate.js"), fs.constants.X_OK); }
    catch (e) { execOk = false; }
    check("hook landed executable", execOk);
    check("existing file never clobbered", fs.readFileSync(sentinel, "utf8").includes("LOCAL ADAPTATION"));
    check("clobber-skip reported", report.skipped.some((s) => s.includes("verify-goodbehavior")));

    const manifest = JSON.parse(fs.readFileSync(path.join(target, ".claude/goodbehavior/manifest.json"), "utf8"));
    check("manifest has sourceCommit", Boolean(manifest.sourceCommit));
    const hashesOk = Object.entries(manifest.files).every(([k, v]) => sha256(path.join(target, k)) === v.sha256);
    check("manifest sha256s match files as installed", hashesOk);
    check("manifest tracks the installed profiles",
      ".claude/goodbehavior/profiles/analysis.md" in manifest.files);

    const settings = JSON.parse(fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf8"));
    check("user's own hook preserved", "PostToolUse" in settings.hooks);
    const countWired = (stops) => stops.reduce((n, e) =>
      n + (e.hooks || []).filter((h) => (h.command || "").includes("done-gate")).length, 0);
    check("Stop hook wired exactly once", countWired(settings.hooks.Stop || []) === 1);

    // idempotency: re-run must create nothing new and not double-wire
    const report2 = runInstall(planPath);
    check("re-run creates nothing", report2.created.length === 0);
    const settings2 = JSON.parse(fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf8"));
    check("re-run does not double-wire the hook", countWired(settings2.hooks.Stop || []) === 1);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }

  console.log(`test_install: ${failures.length ? "FAILED: " + failures.join("; ") : "all passed"}`);
  return failures.length ? 1 : 0;
}

process.exit(main());
