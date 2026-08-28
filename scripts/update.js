#!/usr/bin/env node
/*
 * GoodBehavior deterministic updater — the mechanical half of /update-goodbehavior (Node port).
 *
 * Reads the target's manifest, resolves the source repo, and reconciles every tracked file with a
 * git 3-way merge: base = the commit in the manifest, ours = local, theirs = new upstream. Untouched
 * files fast-forward; adapted files merge; genuine conflicts get markers for the human.
 *
 * Usage: node scripts/update.js --target /path/to/project [--source /override/path] [--dry-run]
 *
 * Guarantees: never touches settings.json; a file whose sha256 matches the manifest is fast-forwarded;
 * adapted files are 3-way merged (conflicts written WITH markers + reported, sha256 left stale so a
 * re-run after resolution reconciles cleanly); files removed upstream are kept locally + reported;
 * manifest sourceCommit/updatedAt/sha256s refreshed for everything cleanly updated or merged.
 * Exit code: 0 clean (even if already up to date), 1 fatal, 2 completed WITH conflicts.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

function sha256Bytes(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function git(source, args, binary) {
  const r = spawnSync("git", ["-C", source, ...args], { encoding: binary ? "buffer" : "utf8" });
  if (r.status !== 0) return null;
  return r.stdout;
}

function gitShow(source, commit, rel) {
  return git(source, ["show", `${commit}:${rel}`], true); // Buffer or null
}

function mergeFile(ours, base, theirs) {
  // git merge-file on byte content. Returns [mergedBuffer, clean].
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "gb-merge-"));
  try {
    const po = path.join(d, "ours"), pb = path.join(d, "base"), pt = path.join(d, "theirs");
    fs.writeFileSync(po, ours); fs.writeFileSync(pb, base); fs.writeFileSync(pt, theirs);
    const r = spawnSync("git", ["merge-file", "-p", "-L", "local", "-L", "base", "-L", "upstream", po, pb, pt],
                        { encoding: "buffer" });
    return [r.stdout, r.status === 0];
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

function out(obj) { process.stdout.write(JSON.stringify(obj)); process.stdout.write("\n"); }
function outPretty(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); }
function isoSeconds() { return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"); }

function main() {
  const argv = process.argv.slice(2);
  let target = null, sourceOverride = null, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") target = argv[++i];
    else if (argv[i] === "--source") sourceOverride = argv[++i];
    else if (argv[i] === "--dry-run") dryRun = true;
  }
  if (!target) { process.stderr.write("error: --target is required\n"); return 1; }
  target = path.resolve(target);

  const manifestPath = path.join(target, ".claude", "goodbehavior", "manifest.json");
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    out({ status: "no manifest — run /adopt-goodbehavior first" }); return 1;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const source = path.resolve(sourceOverride || manifest.source);
  if (!fs.existsSync(path.join(source, ".git"))) { out({ status: `source is not a git repo: ${source}` }); return 1; }
  const baseCommit = manifest.sourceCommit;
  if (!baseCommit) {
    out({ status: "manifest sourceCommit is null — no merge base; re-adopt or overwrite manually (never silently)" });
    return 1;
  }
  const newCommit = ((git(source, ["rev-parse", "HEAD"], false) || "")).trim();
  if (!newCommit) { out({ status: "could not resolve source HEAD" }); return 1; }
  if (newCommit === baseCommit) { out({ status: "already up to date", commit: newCommit }); return 0; }

  const report = { status: `${baseCommit.slice(0, 8)} -> ${newCommit.slice(0, 8)}`, unchanged: [], updated: [],
                   merged: [], conflict: [], restored: [], removed_upstream: [], warnings: [] };

  const keys = Object.keys(manifest.files || {}).sort();
  for (const key of keys) {
    const entry = manifest.files[key];
    const srcRel = entry.from;
    const theirs = gitShow(source, newCommit, srcRel);
    if (theirs === null) { report.removed_upstream.push(key); continue; }
    const localPath = path.join(target, key);
    if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
      if (!dryRun) {
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        fs.writeFileSync(localPath, theirs);
        entry.sha256 = sha256Bytes(theirs);
      }
      report.restored.push(key); continue;
    }
    const ours = fs.readFileSync(localPath);
    if (ours.equals(theirs)) { entry.sha256 = sha256Bytes(ours); report.unchanged.push(key); continue; }
    if (sha256Bytes(ours) === entry.sha256) {
      // untouched since install → fast-forward to upstream
      if (!dryRun) { fs.writeFileSync(localPath, theirs); entry.sha256 = sha256Bytes(theirs); }
      report.updated.push(key); continue;
    }
    const base = gitShow(source, baseCommit, srcRel);
    if (base === null) {
      report.warnings.push(`${key}: no base at ${baseCommit.slice(0, 8)} — left as-is; merge by hand`);
      continue;
    }
    const [merged, clean] = mergeFile(ours, base, theirs);
    if (!dryRun) {
      fs.writeFileSync(localPath, merged);
      if (clean) entry.sha256 = sha256Bytes(merged);
      // on conflict: leave the stale sha256 so a post-resolution re-run reconciles cleanly
    }
    (clean ? report.merged : report.conflict).push(key);
  }

  if (!dryRun) {
    manifest.sourceCommit = newCommit;
    manifest.updatedAt = isoSeconds();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }

  outPretty(report);
  return report.conflict.length ? 2 : 0;
}

process.exit(main());
