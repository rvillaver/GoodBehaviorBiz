#!/usr/bin/env node
/*
 * GoodBehavior deterministic installer — the mechanical half of /adopt-goodbehavior (Node port).
 *
 * The adopt skill does the JUDGMENT (elicit intent, resolve the profile, propose, confirm) and hands
 * this script a plan; this script does the MECHANICS the same way every time: copy files, hash them,
 * wire the hook, write the manifest.
 *
 * Usage:
 *   node scripts/install.js --plan plan.json          # execute
 *   node scripts/install.js --plan plan.json --dry-run
 *
 * Plan format (target-rel -> source-rel for templates):
 * { "source", "target", "skills":[...], "profiles":[...], "hooks":["done-gate","guard-bash"],
 *   "templates": { "docs/plans/ROADMAP.md": "templates/ROADMAP.md", ... } }
 *
 * Guarantees: never clobbers (existing files skipped + reported); installs only under <target>/;
 * settings.json merged not overwritten (existing event entries never duplicated, deduped per hook
 * file); manifest at <target>/.claude/goodbehavior/manifest.json records source, sourceCommit and a
 * sha256 per file AS INSTALLED. Reports JSON on stdout: {"created":[],"skipped":[],"warnings":[]}.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

// Every hook the bundle can carry. `event` is the settings.json hook event; `matcher`, when set,
// scopes the wiring to that event's per-entry matcher (e.g. PreToolUse needs one, Stop doesn't).
const HOOKS = {
  "done-gate": {
    rel: ".claude/hooks/done-gate.js",
    event: "Stop",
    matcher: null,
    command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/done-gate.js"',
  },
  "guard-bash": {
    rel: ".claude/hooks/guard-bash.js",
    event: "PreToolUse",
    matcher: "Bash|PowerShell",
    command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-bash.js"',
  },
  // guard-injection is ONE file wired under TWO events (different input/output shapes per event, so it
  // branches on hook_event_name) — two registry entries sharing the same `rel`. planFiles() dedupes by
  // target path so the shared file is only copied/hashed once.
  "guard-injection-prompt": {
    rel: ".claude/hooks/guard-injection.js",
    event: "UserPromptSubmit",
    matcher: null,
    command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-injection.js"',
  },
  "guard-injection-content": {
    rel: ".claude/hooks/guard-injection.js",
    event: "PostToolUse",
    matcher: "Read|WebFetch",
    command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-injection.js"',
  },
};

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sourceCommit(source) {
  const r = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim();
}

function die(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function walkFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function planFiles(plan) {
  // Yield [target_rel, source_rel] for every file the plan installs (hook/settings handled apart). A Map
  // (first wins, insertion order preserved) so two hook names sharing one `rel` (guard-injection's two
  // event wirings) copy that file exactly once instead of racing to "skip" each other.
  const src = plan.source;
  const files = new Map();
  const add = (tgtRel, srcRel) => { if (!files.has(tgtRel)) files.set(tgtRel, srcRel); };
  for (const skill of plan.skills || []) {
    const skillDir = path.join(src, ".claude", "skills", skill);
    if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) die(`error: skill not found in source: ${skill}`);
    for (const full of walkFiles(skillDir)) {
      const rel = path.relative(src, full);
      add(rel, rel);
    }
  }
  for (const profile of plan.profiles || []) {
    const srcRel = path.join("templates", "profiles", `${profile}.md`);
    if (!fs.existsSync(path.join(src, srcRel))) die(`error: profile not found in source: ${profile}`);
    add(path.join(".claude", "goodbehavior", "profiles", `${profile}.md`), srcRel);
  }
  for (const [tgtRel, srcRel] of Object.entries(plan.templates || {})) {
    if (!fs.existsSync(path.join(src, srcRel))) die(`error: template not found in source: ${srcRel}`);
    add(tgtRel, srcRel);
  }
  for (const name of plan.hooks || []) {
    const def = HOOKS[name];
    if (!def) die(`error: unknown hook in plan: ${name}`);
    add(def.rel, def.rel);
  }
  return [...files.entries()];
}

function wireSettings(target, dryRun, report, plan) {
  const p = path.join(target, ".claude", "settings.json");
  let settings = {};
  if (fs.existsSync(p) && fs.statSync(p).isFile()) {
    try { settings = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { report.warnings.push(`settings.json exists but is not valid JSON — left untouched: ${p}`); return; }
  }
  if (!settings.hooks) settings.hooks = {};
  let changed = false;
  for (const name of plan.hooks || []) {
    const def = HOOKS[name];
    if (!def) continue; // already died in planFiles if truly unknown
    const fileName = path.basename(def.rel);
    if (!settings.hooks[def.event]) settings.hooks[def.event] = [];
    const bucket = settings.hooks[def.event];
    const alreadyWired = bucket.some((entry) => (entry.hooks || []).some((h) => (h.command || "").includes(fileName)));
    if (alreadyWired) {
      report.skipped.push(`.claude/settings.json (${def.event} hook ${fileName} already wired)`);
      continue;
    }
    const entry = { hooks: [{ type: "command", command: def.command }] };
    if (def.matcher) entry.matcher = def.matcher;
    bucket.push(entry);
    changed = true;
    report.created.push(`.claude/settings.json (${def.event} hook ${fileName} wired)`);
  }
  if (changed && !dryRun) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(settings, null, 2) + "\n");
  }
}

function isoSeconds() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function main() {
  const argv = process.argv.slice(2);
  let planPath = null, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan") planPath = argv[++i];
    else if (argv[i] === "--dry-run") dryRun = true;
  }
  if (!planPath) die("error: --plan is required");

  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const source = path.resolve(plan.source);
  const target = path.resolve(plan.target);
  if (source === target) die("error: refusing to install the source into itself");
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) die(`error: source not found: ${source}`);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) die(`error: target not found: ${target}`);

  const report = { created: [], skipped: [], warnings: [] };
  const commit = sourceCommit(source);
  if (commit === null) {
    report.warnings.push(
      "source has no git commit — sourceCommit=null; /update-goodbehavior cannot 3-way-merge until the source is committed");
  }

  const manifestPath = path.join(target, ".claude", "goodbehavior", "manifest.json");
  const manifest = { source, sourceCommit: commit, installedAt: isoSeconds(), updatedAt: null, files: {} };
  if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
    try {
      const existing = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.files = existing.files || {};
      manifest.installedAt = existing.installedAt || manifest.installedAt;
    } catch (e) { report.warnings.push("existing manifest was unreadable — rebuilding it"); }
  }

  for (const [tgtRel, srcRel] of planFiles(plan)) {
    const dst = path.join(target, tgtRel);
    if (fs.existsSync(dst)) { report.skipped.push(tgtRel); continue; }
    if (!dryRun) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(source, srcRel), dst);
      if (Object.values(HOOKS).some((def) => def.rel === tgtRel)) fs.chmodSync(dst, 0o755);
      manifest.files[tgtRel] = { from: srcRel.split(path.sep).join("/"), sha256: sha256(dst) };
    }
    report.created.push(tgtRel);
  }

  if ((plan.hooks || []).length) wireSettings(target, dryRun, report, plan);

  if (!dryRun) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  return 0;
}

process.exit(main());
