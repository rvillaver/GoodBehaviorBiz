#!/usr/bin/env node
/*
 * update.js 3-way-merge round-trip — hermetic mini-source repo, all four reconciliation paths:
 *   a.md untouched locally, changed upstream         -> fast-forwarded ("updated")
 *   b.md adapted locally, compatible upstream change  -> cleanly merged ("merged")
 *   c.md adapted locally, overlapping upstream change -> conflict markers ("conflict", exit 2)
 *   d.md removed upstream                             -> kept locally, reported ("removed_upstream")
 * Then: manifest advanced to the new commit, and a re-run reports "already up to date".
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const INSTALL = path.join(ROOT, "scripts", "install.js");
const UPDATE = path.join(ROOT, "scripts", "update.js");

const BASE_BODY = "line1\nline2\nline3\nline4\nline5\n";

function git(repo, args) {
  const r = spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function write(repo, rel, content) {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function main() {
  const failures = [];
  const check = (label, cond, detail = "") => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond) failures.push(`${label} ${detail}`);
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-update-"));
  try {
    const source = path.join(tmp, "source");
    const target = path.join(tmp, "target");
    fs.mkdirSync(source); fs.mkdirSync(target);

    // commit A — the install-time state
    git(source, ["init", "-q"]);
    for (const name of "abcd") write(source, `templates/${name}.md`, BASE_BODY);
    git(source, ["add", "-A"]);
    git(source, ["commit", "-qm", "A"]);

    const templates = {};
    for (const n of "abcd") templates[`docs/${n}.md`] = `templates/${n}.md`;
    const plan = { source, target, skills: [], profiles: [], hooks: [], templates };
    const planPath = path.join(tmp, "plan.json");
    fs.writeFileSync(planPath, JSON.stringify(plan));
    const ri = spawnSync("node", [INSTALL, "--plan", planPath], { encoding: "utf8" });
    check("install into target succeeded", ri.status === 0, ri.stderr);

    // local adaptations: b compatible (edit line5), c overlapping (edit line1 — upstream edits line1 too)
    write(target, "docs/b.md", BASE_BODY.replace("line5", "line5-LOCAL"));
    write(target, "docs/c.md", BASE_BODY.replace("line1", "line1-LOCAL"));

    // commit B — upstream evolves: a line3, b line1, c line1 (collides with local), d removed
    write(source, "templates/a.md", BASE_BODY.replace("line3", "line3-UPSTREAM"));
    write(source, "templates/b.md", BASE_BODY.replace("line1", "line1-UPSTREAM"));
    write(source, "templates/c.md", BASE_BODY.replace("line1", "line1-UPSTREAM"));
    git(source, ["rm", "-q", "templates/d.md"]);
    git(source, ["add", "-A"]);
    git(source, ["commit", "-qm", "B"]);

    const ru = spawnSync("node", [UPDATE, "--target", target], { encoding: "utf8" });
    check("update exits 2 (completed WITH conflicts)", ru.status === 2, ru.stderr);
    const report = JSON.parse(ru.stdout);

    check("untouched file fast-forwarded", report.updated.includes("docs/a.md"));
    check("fast-forward took upstream content", fs.readFileSync(path.join(target, "docs/a.md"), "utf8").includes("line3-UPSTREAM"));

    check("adapted file cleanly merged", report.merged.includes("docs/b.md"));
    const b = fs.readFileSync(path.join(target, "docs/b.md"), "utf8");
    check("merge kept BOTH local and upstream changes", b.includes("line5-LOCAL") && b.includes("line1-UPSTREAM"));

    check("overlapping edit conflicts", report.conflict.includes("docs/c.md"));
    const c = fs.readFileSync(path.join(target, "docs/c.md"), "utf8");
    check("conflict markers written for the human", c.includes("<<<<<<<") && c.includes(">>>>>>>"));

    check("upstream removal kept locally + reported",
      report.removed_upstream.includes("docs/d.md") && fs.existsSync(path.join(target, "docs/d.md")));

    const manifest = JSON.parse(fs.readFileSync(path.join(target, ".claude/goodbehavior/manifest.json"), "utf8"));
    const newCommit = git(source, ["rev-parse", "HEAD"]).trim();
    check("manifest advanced to new commit", manifest.sourceCommit === newCommit);
    check("manifest updatedAt stamped", Boolean(manifest.updatedAt));

    const ru2 = spawnSync("node", [UPDATE, "--target", target], { encoding: "utf8" });
    const report2 = JSON.parse(ru2.stdout);
    check("re-run reports already up to date", ru2.status === 0 && report2.status === "already up to date");

    // NEW must come from the source's tracked upstream, not its local HEAD. A source checkout sitting behind
    // its own origin previously reported "already up to date" while the remote carried unmerged work — a
    // confident wrong answer. Simulated with a local bare "origin" so the test needs no network.
    {
      const origin = path.join(tmp, "origin.git");
      git(source, ["init", "--bare", "-q", origin]);
      git(source, ["remote", "add", "origin", origin]);
      const branch = git(source, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      git(source, ["push", "-q", "-u", "origin", branch]);

      // upstream moves one commit ahead; the source checkout stays where it is.
      fs.appendFileSync(path.join(source, "templates/a.md"), "upstream-only line\n");
      git(source, ["add", "-A"]);
      git(source, ["commit", "-qm", "C"]);
      const ahead = git(source, ["rev-parse", "HEAD"]).trim();
      git(source, ["push", "-q", "origin", branch]);
      git(source, ["reset", "-q", "--hard", "HEAD~1"]);           // checkout now behind its own origin
      const behind = git(source, ["rev-parse", "HEAD"]).trim();

      const ru3 = spawnSync("node", [UPDATE, "--target", target, "--dry-run"], { encoding: "utf8" });
      const report3 = JSON.parse(ru3.stdout);
      check("source behind its origin is NOT reported as up to date",
        report3.status !== "already up to date", JSON.stringify(report3));
      // status is "<base> -> <new>"; assert the TARGET side. `behind` equals the base here, so a plain
      // "doesn't mention behind" check would fail for the right reason and hide the real assertion.
      const newSide = String(report3.status).split(" -> ")[1];
      check("NEW resolves to the tracked upstream, not local HEAD",
        newSide === ahead.slice(0, 8),
        `newSide=${newSide} ahead=${ahead.slice(0,8)} behind=${behind.slice(0,8)}`);
      check("report names the ref it compared against", report3.ref === `origin/${branch}`, report3.ref);
      check("warns that the source checkout is not at its upstream",
        (report3.warnings || []).some((w) => /not at origin\//.test(w)), JSON.stringify(report3.warnings));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`test_update: ${failures.length ? "FAILED: " + failures.join("; ") : "all passed"}`);
  return failures.length ? 1 : 0;
}

process.exit(main());
