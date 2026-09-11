/*
 * The feed store: opt-in state, and per-feed fetch -> hash -> compile -> atomic swap -> rollback. Design
 * reference: BlitzPi's src/feeds/store.ts — re-derived here, calling our own zero-dependency adapters.
 *
 * Machine-wide by design (~/.goodbehavior/feeds/, not per-project): fetching and compiling once per machine,
 * shared across every adopted project, is the whole point — a hook invocation only ever reads the already-
 * compiled rules.json, never re-fetches or re-parses. A compile failure (bad network response, a feed that
 * broke its own format) always leaves the previous good feed in place — never a half-written or empty one.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { compileGitleaks } = require("./adapters/gitleaks");
const { compileSigma } = require("./adapters/sigma");
const { compileUrlhaus } = require("./adapters/urlhaus");

const FEEDS = [
  {
    name: "secrets",
    category: "secret",
    description: "gitleaks rules — credentials and tokens in commands",
    source: process.env.GOODBEHAVIOR_FEED_SECRETS_URL || "https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml",
    binary: false,
    compile: compileGitleaks,
  },
  {
    name: "commands",
    category: "command",
    description: "Sigma rules — process-creation command shapes (linux/macos)",
    source: process.env.GOODBEHAVIOR_FEED_COMMANDS_URL || "https://github.com/SigmaHQ/sigma/releases/latest/download/sigma_all_rules.zip",
    binary: true,
    compile: compileSigma,
  },
  {
    name: "urls",
    category: "url",
    description: "URLhaus (abuse.ch) — URLs currently distributing malware",
    source: process.env.GOODBEHAVIOR_FEED_URLS_URL || "https://urlhaus.abuse.ch/downloads/text_online/",
    binary: false,
    compile: compileUrlhaus,
  },
];

function feedDef(name) { return FEEDS.find((f) => f.name === name); }
function feedsDir() { return process.env.GOODBEHAVIOR_FEEDS_DIR || path.join(os.homedir(), ".goodbehavior", "feeds"); }

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return undefined; } }
function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
}

class FeedStore {
  constructor(dir = feedsDir()) { this.dir = dir; }
  feedDir(name) { return path.join(this.dir, name); }

  optedIn() { return fs.existsSync(path.join(this.dir, "opt-in")); }
  decision() { return this.optedIn() ? "in" : fs.existsSync(path.join(this.dir, "opt-out")) ? "out" : undefined; }
  optIn() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, "opt-in"), new Date().toISOString() + "\n");
    try { fs.unlinkSync(path.join(this.dir, "opt-out")); } catch (e) { /* wasn't opted out */ }
  }
  optOut(removeFeeds) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, "opt-out"), new Date().toISOString() + "\n");
    try { fs.unlinkSync(path.join(this.dir, "opt-in")); } catch (e) { /* wasn't opted in */ }
    const removed = [];
    if (removeFeeds) {
      for (const f of FEEDS) {
        const d = this.feedDir(f.name);
        if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true, force: true }); removed.push(f.name); }
      }
    }
    return removed;
  }

  manifest(name) { return readJson(path.join(this.feedDir(name), "manifest.json")); }
  previousManifest(name) { return readJson(path.join(this.feedDir(name), "previous", "manifest.json")); }
  rules(name) { const r = readJson(path.join(this.feedDir(name), "rules.json")); return r && r.rules; }
  installed(name) { return Boolean(this.manifest(name)) && fs.existsSync(path.join(this.feedDir(name), "rules.json")); }

  /** Rules for the runtime, only if opted in — re-read fresh each call so `feeds update`/`rollback` take
   *  effect immediately without needing a session restart. */
  liveRules(name) {
    if (!this.optedIn()) return undefined;
    return this.rules(name);
  }

  list() {
    return FEEDS.map((f) => ({
      name: f.name, category: f.category, description: f.description,
      installed: this.installed(f.name), manifest: this.manifest(f.name),
    }));
  }

  async update(name, opts = {}) {
    const def = feedDef(name);
    if (!def) return { type: "feed_update_failed", feed: name, error: `unknown feed "${name}" (known: ${FEEDS.map((f) => f.name).join(", ")})` };
    const current = this.manifest(name);
    try {
      const headers = {};
      if (current && current.etag && !opts.force) headers["if-none-match"] = current.etag;
      const res = await fetch(def.source, { headers });
      if (res.status === 304 && current) return { type: "feed_update", feed: name, changed: false, rules: current.rules, skipped: current.skipped };
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${def.source}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      if (current && current.sha256 === sha256 && !opts.force) return { type: "feed_update", feed: name, changed: false, rules: current.rules, skipped: current.skipped };

      const raw = def.binary ? bytes : bytes.toString("utf8");
      const compiled = def.compile(raw); // throws on a broken source -> caught below, previous feed kept
      if (!compiled.rules.length) throw new Error("compiled to zero rules — refusing to install an empty feed");

      const manifest = {
        name, source: def.source, fetched_at: new Date().toISOString(), sha256,
        etag: res.headers.get("etag") || undefined, bytes: bytes.length,
        rules: compiled.rules.length, skipped: compiled.skipped.length, sourceVersion: compiled.sourceVersion,
      };
      const dir = this.feedDir(name);
      const staged = path.join(dir, "staged");
      fs.rmSync(staged, { recursive: true, force: true });
      writeJson(path.join(staged, "rules.json"), { rules: compiled.rules, skipped: compiled.skipped });
      writeJson(path.join(staged, "manifest.json"), manifest);

      if (this.installed(name) && !(current && current.sha256 === sha256)) {
        fs.rmSync(path.join(dir, "previous"), { recursive: true, force: true });
        fs.mkdirSync(path.join(dir, "previous"), { recursive: true });
        for (const f of ["manifest.json", "rules.json"]) {
          if (fs.existsSync(path.join(dir, f))) fs.renameSync(path.join(dir, f), path.join(dir, "previous", f));
        }
      }
      for (const f of ["manifest.json", "rules.json"]) fs.renameSync(path.join(staged, f), path.join(dir, f));
      fs.rmSync(staged, { recursive: true, force: true });
      return { type: "feed_update", feed: name, changed: true, rules: manifest.rules, skipped: manifest.skipped };
    } catch (e) {
      return { type: "feed_update_failed", feed: name, error: e instanceof Error ? e.message : String(e), kept: current ? current.sha256 : undefined };
    }
  }

  rollback(name) {
    const dir = this.feedDir(name);
    const prev = this.previousManifest(name);
    const cur = this.manifest(name);
    if (!prev) return { type: "feed_update_failed", feed: name, error: "no previous version of this feed to roll back to" };
    if (cur && prev.sha256 === cur.sha256) return { type: "feed_update_failed", feed: name, error: "the previous copy is identical to the current one — nothing to roll back" };
    const tmp = path.join(dir, "swap");
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    for (const f of ["manifest.json", "rules.json"]) {
      if (fs.existsSync(path.join(dir, f))) fs.renameSync(path.join(dir, f), path.join(tmp, f));
    }
    for (const f of ["manifest.json", "rules.json"]) {
      if (fs.existsSync(path.join(dir, "previous", f))) fs.renameSync(path.join(dir, "previous", f), path.join(dir, f));
    }
    fs.rmSync(path.join(dir, "previous"), { recursive: true, force: true });
    fs.renameSync(tmp, path.join(dir, "previous"));
    return { type: "feed_rollback", feed: name, from: cur ? cur.sha256 : undefined, to: prev.sha256 };
  }
}

module.exports = { FEEDS, feedDef, feedsDir, FeedStore };
