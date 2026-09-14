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

function countWired(entries, needle) {
  return (entries || []).reduce((n, e) => n + (e.hooks || []).filter((h) => (h.command || "").includes(needle)).length, 0);
}

// G2-3: a project already adopted (pre-guard-bash era, done-gate only) gets a new hook via an
// additions-only re-run of install.js — the mechanism /update-goodbehavior documents for upstream
// additions that also need settings.json wiring. Must not disturb the existing wiring or local adaptations.
function testAdditionsOnlyHookUpgrade(check) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "gb-install-upgrade-"));
  try {
    const initialPlan = { source: ROOT, target, skills: [], profiles: [], hooks: ["done-gate"], templates: {} };
    const initialPlanPath = path.join(target, "plan-initial.json");
    fs.writeFileSync(initialPlanPath, JSON.stringify(initialPlan));
    runInstall(initialPlanPath);

    // a local adaptation made after initial adoption, before the upstream hook addition
    fs.mkdirSync(path.join(target, ".claude", "goodbehavior", "profiles"), { recursive: true });
    const adaptation = path.join(target, ".claude", "goodbehavior", "profiles", "custom.md");
    fs.writeFileSync(adaptation, "LOCAL CUSTOM PROFILE — do not clobber\n");

    const settingsBefore = JSON.parse(fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf8"));
    check("pre-upgrade: only done-gate wired", countWired(settingsBefore.hooks.Stop, "done-gate") === 1 && !settingsBefore.hooks.PreToolUse);

    // additions-only re-run: just the new hook, nothing else in the plan
    const additionPlan = { source: ROOT, target, skills: [], profiles: [], hooks: ["guard-bash"], templates: {} };
    const additionPlanPath = path.join(target, "plan-addition.json");
    fs.writeFileSync(additionPlanPath, JSON.stringify(additionPlan));
    const report = runInstall(additionPlanPath);

    check("addition: guard-bash file landed", fs.existsSync(path.join(target, ".claude/hooks/guard-bash.js")));
    check("addition: reported as created, not skipped",
      report.created.some((c) => c.includes("guard-bash")) && !report.skipped.some((s) => s.includes("guard-bash")));

    const settingsAfter = JSON.parse(fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf8"));
    check("addition: guard-bash wired exactly once", countWired(settingsAfter.hooks.PreToolUse, "guard-bash") === 1);
    check("addition: done-gate wiring untouched (still exactly once)", countWired(settingsAfter.hooks.Stop, "done-gate") === 1);
    check("addition: local adaptation survives", fs.readFileSync(adaptation, "utf8").includes("LOCAL CUSTOM PROFILE"));

    const manifest = JSON.parse(fs.readFileSync(path.join(target, ".claude/goodbehavior/manifest.json"), "utf8"));
    check("addition: manifest gained guard-bash entry", ".claude/hooks/guard-bash.js" in manifest.files);
    check("addition: manifest kept the original done-gate entry", ".claude/hooks/done-gate.js" in manifest.files);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

// G4: guard-injection is ONE file shared by two hook names (different events). planFiles() must dedupe by
// target path — copy/hash/chmod exactly once — while wireSettings() still wires both events independently.
function testSharedFileHookDedup(check) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "gb-install-shared-"));
  try {
    const plan = { source: ROOT, target, skills: [], profiles: [], hooks: ["guard-injection-prompt", "guard-injection-content"], templates: {} };
    const planPath = path.join(target, "plan.json");
    fs.writeFileSync(planPath, JSON.stringify(plan));
    const report = runInstall(planPath);

    const createdHits = report.created.filter((c) => c === ".claude/hooks/guard-injection.js");
    check("shared file copied exactly once (not once per hook name)", createdHits.length === 1, JSON.stringify(report.created));
    check("shared file landed executable",
      (() => { try { fs.accessSync(path.join(target, ".claude/hooks/guard-injection.js"), fs.constants.X_OK); return true; } catch (e) { return false; } })());

    const settings = JSON.parse(fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf8"));
    check("wired under UserPromptSubmit (no matcher)",
      countWired(settings.hooks.UserPromptSubmit, "guard-injection") === 1 &&
      !(settings.hooks.UserPromptSubmit || []).some((e) => "matcher" in e));
    check("wired under PostToolUse with Read|WebFetch matcher",
      countWired(settings.hooks.PostToolUse, "guard-injection") === 1 &&
      (settings.hooks.PostToolUse || []).some((e) => (e.hooks || []).some((h) => (h.command || "").includes("guard-injection")) && e.matcher === "Read|WebFetch"));

    const manifest = JSON.parse(fs.readFileSync(path.join(target, ".claude/goodbehavior/manifest.json"), "utf8"));
    check("manifest carries exactly one entry for the shared file", ".claude/hooks/guard-injection.js" in manifest.files);

    // re-run: idempotent for both event wirings, still one file
    const report2 = runInstall(planPath);
    check("re-run creates nothing", report2.created.length === 0);
    const settings2 = JSON.parse(fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf8"));
    check("re-run does not double-wire either event",
      countWired(settings2.hooks.UserPromptSubmit, "guard-injection") === 1 &&
      countWired(settings2.hooks.PostToolUse, "guard-injection") === 1);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function main() {
  const failures = [];
  const check = (label, cond, detail = "") => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond) failures.push(`${label} ${detail}`);
  };

  testAdditionsOnlyHookUpgrade(check);
  testSharedFileHookDedup(check);

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
      hooks: ["done-gate", "guard-bash", "guard-injection-prompt", "guard-injection-content"],
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
    const execOk = (rel) => { try { fs.accessSync(path.join(target, rel), fs.constants.X_OK); return true; } catch (e) { return false; } };
    check("done-gate hook landed executable", execOk(".claude/hooks/done-gate.js"));
    check("guard-bash hook landed executable", execOk(".claude/hooks/guard-bash.js"));
    check("guard-injection hook landed executable", execOk(".claude/hooks/guard-injection.js"));
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
    check("Stop hook wired exactly once", countWired(settings.hooks.Stop, "done-gate") === 1);
    check("PreToolUse/Bash guard wired exactly once", countWired(settings.hooks.PreToolUse, "guard-bash") === 1);
    // BOTH command surfaces: on native Windows the PowerShell tool is the primary shell, and a Bash-only
    // matcher leaves it unguarded entirely.
    check("guard-bash entry matches both Bash and PowerShell",
      (settings.hooks.PreToolUse || []).some((e) => {
        const tools = String(e.matcher || "").split("|");
        return (e.hooks || []).some((h) => (h.command || "").includes("guard-bash")) &&
          tools.includes("Bash") && tools.includes("PowerShell");
      }));

    // idempotency: re-run must create nothing new and not double-wire
    const report2 = runInstall(planPath);
    check("re-run creates nothing", report2.created.length === 0);
    const settings2 = JSON.parse(fs.readFileSync(path.join(target, ".claude", "settings.json"), "utf8"));
    check("re-run does not double-wire done-gate", countWired(settings2.hooks.Stop, "done-gate") === 1);
    check("re-run does not double-wire guard-bash", countWired(settings2.hooks.PreToolUse, "guard-bash") === 1);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }

  console.log(`test_install: ${failures.length ? "FAILED: " + failures.join("; ") : "all passed"}`);
  return failures.length ? 1 : 0;
}

process.exit(main());
