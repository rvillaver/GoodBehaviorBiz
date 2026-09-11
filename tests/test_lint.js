#!/usr/bin/env node
/*
 * Structural + drift lint for the bundle itself.
 * Structure: profiles well-formed and indexed; skill frontmatter names match dirs; JSON artifacts
 * parse; JS artifacts parse (node --check).
 * Drift: the invariant layer (CLAUDE.md core, verify/audit/roadmap skills, the hook, generic
 * templates) must not re-acquire dev-only phrasing.
 * Infection guard: no machine-local absolute paths in the distributable bundle (project-instance
 * state under .claude/goodbehavior/ is excluded — it legitimately records the source path).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PROFILES = ["development", "analysis", "research", "creative"];
const SLOTS = ["**the-real-thing:**", "**verify:**", "**evidence:**"];

const INVARIANT_FILES = [
  "CLAUDE.md",
  ".claude/skills/verify-goodbehavior/SKILL.md",
  ".claude/skills/audit-goodbehavior/SKILL.md",
  ".claude/skills/roadmap-goodbehavior/SKILL.md",
  ".claude/hooks/done-gate.js",
  ".claude/hooks/guard-bash.js",
  ".claude/hooks/guard-injection.js",
  "templates/MEMORY.md",
  "templates/UAT-PLAN.md",
  "templates/ROADMAP.md",
  "templates/PRODUCTION-BACKLOG.md",
];
const JS_ARTIFACTS = [".claude/hooks/done-gate.js", ".claude/hooks/guard-bash.js", ".claude/hooks/guard-injection.js", "scripts/install.js", "scripts/update.js", "scripts/report.js"];

const DEV_CODED = /(UI \+ backend|the real UI|UI \*and\* (the real )?backend|run the app\b)/i;
const PROFILE_SCOPED = /(profile|for software|development|dev app|dev project)/i;
const LOCAL_PATH = /(\/Users\/|\/home\/\w|[A-Z]:\\Users)/;

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir, prune) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full);
    if (fs.statSync(full).isDirectory()) {
      if (prune(name, rel)) continue;
      out.push(...walk(full, prune));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function main() {
  const failures = [];
  const check = (label, cond, detail = "") => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}` + (!cond && detail ? ` — ${detail}` : ""));
    if (!cond) failures.push(label);
  };

  // profiles well-formed
  for (const p of PROFILES) {
    const body = read(`templates/profiles/${p}.md`);
    check(`profile ${p}: three slots + use-when + truth-source`,
      SLOTS.every((s) => body.includes(s)) && body.includes("use-when:") && body.includes("truth-source:"));
  }
  const index = read("templates/profiles/INDEX.md");
  for (const p of PROFILES) check(`INDEX links ${p}.md`, index.includes(`(${p}.md)`));

  // skill frontmatter name == dir name
  const skillsDir = path.join(ROOT, ".claude", "skills");
  for (const d of fs.readdirSync(skillsDir).sort()) {
    const skill = path.join(skillsDir, d, "SKILL.md");
    if (!fs.existsSync(skill)) continue;
    const m = read(`.claude/skills/${d}/SKILL.md`).match(/^name: (.+)$/m);
    check(`skill ${d}: frontmatter name matches dir`, Boolean(m) && m[1].trim() === d);
  }

  // JSON artifacts parse (strip // comment lines first)
  for (const rel of [".claude/settings.json", "templates/manifest.json", "templates/managed-settings.json"]) {
    try { JSON.parse(read(rel).replace(/^\s*\/\/.*$/gm, "")); check(`${rel} parses as JSON`, true); }
    catch (e) { check(`${rel} parses as JSON`, false, String(e)); }
  }

  // managed-settings.json carries the specific keys that make it actually enforced, not just a hook list
  {
    const m = JSON.parse(read("templates/managed-settings.json"));
    check("managed-settings.json: allowManagedHooksOnly is true", m.allowManagedHooksOnly === true);
    check("managed-settings.json: disableBypassPermissionsMode is set", m.permissions?.disableBypassPermissionsMode === "disable");
    check("managed-settings.json: wires guard-bash under PreToolUse/Bash",
      (m.hooks?.PreToolUse || []).some((e) => e.matcher === "Bash" && (e.hooks || []).some((h) => (h.command || "").includes("guard-bash"))));
    check("managed-settings.json: wires guard-injection under UserPromptSubmit and PostToolUse",
      (m.hooks?.UserPromptSubmit || []).some((e) => (e.hooks || []).some((h) => (h.command || "").includes("guard-injection"))) &&
      (m.hooks?.PostToolUse || []).some((e) => e.matcher === "Read|WebFetch" && (e.hooks || []).some((h) => (h.command || "").includes("guard-injection"))));
  }

  // JS artifacts parse
  for (const rel of JS_ARTIFACTS) {
    const r = spawnSync("node", ["--check", path.join(ROOT, rel)], { encoding: "utf8" });
    check(`${rel} parses`, r.status === 0, (r.stderr || "").trim().split("\n")[0]);
  }

  // drift: invariant layer must not re-acquire unscoped dev-only phrasing
  for (const rel of INVARIANT_FILES) {
    const offenders = read(rel).split("\n").map((l) => l.trim())
      .filter((ln) => DEV_CODED.test(ln) && !PROFILE_SCOPED.test(ln));
    check(`${rel}: no unscoped dev-coded phrasing`, offenders.length === 0,
      offenders.length ? `e.g. ${JSON.stringify(offenders[0].slice(0, 90))}` : "");
  }

  // upward-infection guard: nothing machine-local may flow into the DISTRIBUTABLE bundle. Project-
  // instance state (.claude/goodbehavior/) is excluded — its manifest legitimately records the
  // absolute source path that /update needs.
  const PRUNE = new Set([".git", "node_modules", "__pycache__", "tests", "docs"]);
  const prune = (name, rel) => PRUNE.has(name) || rel === path.join(".claude", "goodbehavior");
  const leaks = [];
  for (const rel of walk(ROOT, prune)) {
    if (!/\.(md|js|json)$/.test(rel)) continue;
    for (const ln of read(rel).split("\n")) {
      if (LOCAL_PATH.test(ln)) leaks.push(`${rel}: ${ln.trim().slice(0, 90)}`);
    }
  }
  check("bundle: no machine-local absolute paths (upward-infection guard)", leaks.length === 0, leaks[0] || "");

  console.log(`test_lint: ${failures.length ? "FAILED: " + failures.join("; ") : "all passed"}`);
  return failures.length ? 1 : 0;
}

process.exit(main());
