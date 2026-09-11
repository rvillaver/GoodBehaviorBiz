#!/usr/bin/env node
/*
 * GoodBehavior feed CLI — the mechanical half of /feeds-goodbehavior.
 *
 * Usage:
 *   node scripts/feeds.js opt-in
 *   node scripts/feeds.js opt-out [--remove]
 *   node scripts/feeds.js update [name...] [--force]
 *   node scripts/feeds.js rollback <name>
 *   node scripts/feeds.js status
 *   node scripts/feeds.js list
 */
"use strict";
const { FEEDS, feedDef, FeedStore } = require("./feeds/store");

function usage() {
  process.stdout.write(
    "Usage: node scripts/feeds.js <command>\n" +
    "  opt-in                 record that you want security feeds fetched\n" +
    "  opt-out [--remove]     decline (and optionally delete any already-fetched feeds)\n" +
    "  update [name...]       fetch + compile (all feeds if no name given); --force re-fetches unchanged\n" +
    "  rollback <name>        restore the previous version of one feed\n" +
    "  status                 opt-in state + what's installed\n" +
    "  list                   known feeds, categories, and sources\n"
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const store = new FeedStore();

  if (cmd === "opt-in") {
    store.optIn();
    process.stdout.write(JSON.stringify({ status: "opted in" }) + "\n");
    return 0;
  }
  if (cmd === "opt-out") {
    const removed = store.optOut(argv.includes("--remove"));
    process.stdout.write(JSON.stringify({ status: "opted out", removed }) + "\n");
    return 0;
  }
  if (cmd === "status") {
    process.stdout.write(JSON.stringify({ decision: store.decision() || "not asked", feeds: store.list() }, null, 2) + "\n");
    return 0;
  }
  if (cmd === "list") {
    process.stdout.write(JSON.stringify(FEEDS.map((f) => ({ name: f.name, category: f.category, description: f.description, source: f.source })), null, 2) + "\n");
    return 0;
  }
  if (cmd === "rollback") {
    const name = argv[1];
    if (!name || !feedDef(name)) { process.stderr.write(`error: unknown or missing feed name\n`); return 1; }
    const result = store.rollback(name);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.type === "feed_update_failed" ? 1 : 0;
  }
  if (cmd === "update") {
    const names = argv.slice(1).filter((a) => !a.startsWith("--"));
    const targets = names.length ? names : FEEDS.map((f) => f.name);
    const results = [];
    for (const name of targets) {
      if (!feedDef(name)) { results.push({ type: "feed_update_failed", feed: name, error: "unknown feed" }); continue; }
      results.push(await store.update(name, { force: argv.includes("--force") }));
    }
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    return results.some((r) => r.type === "feed_update_failed") ? 1 : 0;
  }

  usage();
  return cmd ? 1 : 0;
}

main().then((code) => process.exit(code));
