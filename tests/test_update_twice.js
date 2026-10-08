#!/usr/bin/env node
/*
 * Two consecutive updates over the same adapted file. The merge path rewrites the manifest sha to the
 * MERGED content, so "local sha == manifest sha" stops meaning "untouched since install" after the first
 * run — and the second run fast-forwarded the adaptation away, reporting zero conflicts both times.
 *
 *   a.md pristine, changed in both commits -> "updated" twice
 *   b.md adapted once, changed in both commits -> "merged" twice, adaptation intact after BOTH
 *
 * test_update.js drives one update per fixture, which is why this survived.
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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gb-update2-"));
  try {
    const source = path.join(tmp, "source");
    const target = path.join(tmp, "target");
    fs.mkdirSync(source); fs.mkdirSync(target);

    git(source, ["init", "-q"]);
    for (const n of "ab") write(source, `templates/${n}.md`, BASE_BODY);
    git(source, ["add", "-A"]);
    git(source, ["commit", "-qm", "A"]);

    const templates = { "docs/a.md": "templates/a.md", "docs/b.md": "templates/b.md" };
    const plan = { source, target, skills: [], profiles: [], hooks: [], templates };
    const planPath = path.join(tmp, "plan.json");
    fs.writeFileSync(planPath, JSON.stringify(plan));
    const ri = spawnSync("node", [INSTALL, "--plan", planPath], { encoding: "utf8" });
    check("install into target succeeded", ri.status === 0, ri.stderr);

    // the only local adaptation, made once and never touched again
    write(target, "docs/b.md", BASE_BODY.replace("line5", "line5-LOCAL"));

    // commit B — upstream edits line1 in both files; compatible with the local line5 edit
    write(source, "templates/a.md", BASE_BODY.replace("line1", "line1-UP-B"));
    write(source, "templates/b.md", BASE_BODY.replace("line1", "line1-UP-B"));
    git(source, ["add", "-A"]);
    git(source, ["commit", "-qm", "B"]);

    const r1 = spawnSync("node", [UPDATE, "--target", target], { encoding: "utf8" });
    const rep1 = JSON.parse(r1.stdout);
    check("run 1: pristine file fast-forwarded", rep1.updated.includes("docs/a.md"), JSON.stringify(rep1));
    check("run 1: adapted file merged", rep1.merged.includes("docs/b.md"), JSON.stringify(rep1));
    const b1 = fs.readFileSync(path.join(target, "docs/b.md"), "utf8");
    check("run 1: adaptation survives", b1.includes("line5-LOCAL") && b1.includes("line1-UP-B"), b1);

    // commit C — upstream edits line3 in both files; still compatible with the local line5 edit
    write(source, "templates/a.md", BASE_BODY.replace("line1", "line1-UP-B").replace("line3", "line3-UP-C"));
    write(source, "templates/b.md", BASE_BODY.replace("line1", "line1-UP-B").replace("line3", "line3-UP-C"));
    git(source, ["add", "-A"]);
    git(source, ["commit", "-qm", "C"]);

    const r2 = spawnSync("node", [UPDATE, "--target", target], { encoding: "utf8" });
    const rep2 = JSON.parse(r2.stdout);

    check("run 2: pristine file still fast-forwards", rep2.updated.includes("docs/a.md"), JSON.stringify(rep2));
    check("run 2: adapted file merges again, NOT fast-forwarded",
      rep2.merged.includes("docs/b.md") && !rep2.updated.includes("docs/b.md"), JSON.stringify(rep2));

    const b2 = fs.readFileSync(path.join(target, "docs/b.md"), "utf8");
    check("run 2: adaptation STILL intact after a second update", b2.includes("line5-LOCAL"), b2);
    check("run 2: picked up the new upstream change", b2.includes("line3-UP-C"), b2);
    check("run 2: kept the earlier upstream change", b2.includes("line1-UP-B"), b2);

    const a2 = fs.readFileSync(path.join(target, "docs/a.md"), "utf8");
    check("run 2: pristine file tracks upstream exactly", a2.includes("line3-UP-C") && a2.includes("line1-UP-B"), a2);

    // A manifest written before upstreamSha256 existed, in the exact state that lost data: the adaptation is
    // baked into sha256, so the old "local sha == manifest sha" test read it as pristine. The fallback must
    // reach for the base blob and merge instead.
    {
      const mPath = path.join(target, ".claude/goodbehavior/manifest.json");
      const m = JSON.parse(fs.readFileSync(mPath, "utf8"));
      for (const e of Object.values(m.files)) delete e.upstreamSha256;
      const crypto = require("crypto");
      m.files["docs/b.md"].sha256 = crypto.createHash("sha256")
        .update(fs.readFileSync(path.join(target, "docs/b.md"))).digest("hex");
      fs.writeFileSync(mPath, JSON.stringify(m, null, 2) + "\n");

      write(source, "templates/b.md", BASE_BODY.replace("line1", "line1-UP-B").replace("line3", "line3-UP-C").replace("line2", "line2-UP-D"));
      git(source, ["add", "-A"]);
      git(source, ["commit", "-qm", "D"]);

      const r3 = spawnSync("node", [UPDATE, "--target", target], { encoding: "utf8" });
      const rep3 = JSON.parse(r3.stdout);
      check("legacy manifest: adapted file merges, not fast-forwarded",
        rep3.merged.includes("docs/b.md") && !rep3.updated.includes("docs/b.md"), JSON.stringify(rep3));
      const b3 = fs.readFileSync(path.join(target, "docs/b.md"), "utf8");
      check("legacy manifest: adaptation survives the migration run", b3.includes("line5-LOCAL"), b3);
      check("legacy manifest: new upstream change applied", b3.includes("line2-UP-D"), b3);
      const m3 = JSON.parse(fs.readFileSync(mPath, "utf8"));
      check("legacy manifest: upstreamSha256 backfilled for next time",
        Boolean(m3.files["docs/b.md"].upstreamSha256), JSON.stringify(m3.files["docs/b.md"]));
      check("legacy manifest: the two shas now differ on an adapted file",
        m3.files["docs/b.md"].sha256 !== m3.files["docs/b.md"].upstreamSha256, JSON.stringify(m3.files["docs/b.md"]));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`test_update_twice: ${failures.length ? "FAILED: " + failures.join("; ") : "all passed"}`);
  return failures.length ? 1 : 0;
}

process.exit(main());
