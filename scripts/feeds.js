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
 *   node scripts/feeds.js mute [--project DIR] [--all] [--yes] [--reason "…"] [id...]
 *   node scripts/feeds.js unmute [--project DIR] <id...|--all>
 */
"use strict";
const path = require("path");
const readline = require("readline");
const { FEEDS, feedDef, feedsDir, FeedStore } = require("./feeds/store");
const mutes = require("./feeds/mutes");

// Must match FEED_MAX_AGE_DAYS in .claude/hooks/guard-bash.js — the guard decides disposition on it, this
// only reports it. `urls` is short on purpose: URLhaus lists URLs *currently* distributing malware.
const FEED_MAX_AGE_DAYS = { urls: 7, commands: 30, secrets: 30 };

function usage() {
  process.stdout.write(
    "Usage: node scripts/feeds.js <command>\n" +
    "  opt-in                 record that you want security feeds fetched\n" +
    "  opt-out [--remove]     decline (and optionally delete any already-fetched feeds)\n" +
    "  update [name...]       fetch + compile (all feeds if no name given); --force re-fetches unchanged\n" +
    "  rollback <name>        restore the previous version of one feed\n" +
    "  status                 opt-in state + what's installed\n" +
    "  list                   known feeds, categories, and sources\n" +
    "  mute [id...]           stop a noisy feed rule from asking (menu when no id given)\n" +
    "  unmute <id...|--all>   let muted rules decide again\n" +
    "\n" +
    "  mute/unmute flags: --project DIR (default: cwd) · --all · --yes · --reason \"why\"\n"
  );
}

// ---- mute menu ----------------------------------------------------------------------------------------
// A muted rule still matches and is still audited; it stops DECIDING. See scripts/feeds/mutes.js for why
// this mechanism has to exist at all (a hook `ask` has no "always allow", so the rule re-asks forever).

const SEV_WIDTH = 6;

function renderRows(rows, selected) {
  const lines = [];
  rows.forEach((r, i) => {
    const box = selected.has(r.id) ? "x" : " ";
    const n = String(i + 1).padStart(2);
    const hits = r.asks ? `${r.asks}x ask` : r.count ? `${r.count}x seen` : "never fired";
    lines.push(` [${box}] ${n}. ${hits.padEnd(11)} ${r.description}`);
    lines.push(`              ${String(r.severity).padEnd(SEV_WIDTH)} ${r.feed}${r.muted ? "  · already muted" : ""}`);
    lines.push(`              ${r.patterns}`);
  });
  return lines.join("\n");
}

function muteHeader(projectDir, rows, all) {
  const fired = rows.filter((r) => r.count > 0).length;
  return [
    `Feed rules — ${path.resolve(projectDir)}`,
    all
      ? `Every installed rule (${rows.length}), loudest first.`
      : `${fired} rule${fired === 1 ? "" : "s"} have fired here (from .claude/goodbehavior/audit/). ` +
        `Use --all to see every installed rule.`,
    `The audit records rule ids only, never command text — so these counts say which rule fired and how`,
    `often, never what you ran when it fired. Judge the rule, not the command.`,
    ``,
  ].join("\n");
}

function muteFooter(projectDir) {
  return `\n Writes ${mutes.MUTE_FILE} under the project. A muted rule is still matched and still audited.\n` +
    ` numbers toggle (e.g. "1 3 4") · a = all · n = none · w = write · q = quit without writing\n`;
}

/** The interactive loop. Thin by design: every decision it makes lives in `mutes.applyMenuInput`, which is
 *  pure and unit-tested, so verifying the menu's behavior doesn't require driving a pty.
 *  Returns the chosen ids, or null for "quit without writing" — which is also what EOF means. */
async function muteMenu(projectDir, rows) {
  let selected = new Set(rows.filter((r) => r.selected).map((r) => r.id));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // EOF (stdin closed, e.g. input piped in and exhausted) resolves the pending question as a quit rather
  // than leaving the promise dangling forever. Without this the process hangs on a closed stdin.
  let closed = false;
  rl.on("close", () => { closed = true; });
  const ask = (q) => new Promise((res) => {
    if (closed) return res(null);
    rl.once("close", () => res(null));
    rl.question(q, res);
  });
  try {
    for (;;) {
      process.stdout.write("\n" + muteHeader(projectDir, rows, false) + renderRows(rows, selected) + "\n" + muteFooter(projectDir));
      const answer = await ask(" > ");
      if (answer === null) { process.stdout.write("\nstdin closed — nothing written\n"); return null; }
      const step = mutes.applyMenuInput(rows, selected, answer);
      selected = step.selected;
      if (step.action === "quit") { process.stdout.write("nothing written\n"); return null; }
      if (step.action === "write") return [...selected];
      if (step.action === "error") process.stdout.write(`\n  not a row number: ${step.bad.join(", ") || answer}\n`);
    }
  } finally { rl.close(); }
}

async function cmdMute(argv) {
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1];
  };
  const projectDir = flag("project") || process.cwd();
  const all = argv.includes("--all");
  const reason = flag("reason");
  const explicit = argv.slice(1).filter((a, i, arr) =>
    !a.startsWith("--") && arr[i - 1] !== "--project" && arr[i - 1] !== "--reason");

  const rows = mutes.buildRows({ projectDir, feedsDir: feedsDir(), all });
  if (!rows.length) {
    process.stdout.write(
      "No feed rules to show: nothing has fired in this project's audit trail and no rules are muted.\n" +
      "(Feeds are opt-in — `feeds.js status` shows whether any are installed. `--all` lists every installed rule.)\n");
    return 0;
  }

  let chosen;
  if (explicit.length) {
    const known = new Set(rows.map((r) => r.id));
    const unknown = explicit.filter((id) => !known.has(id));
    if (unknown.length) {
      process.stderr.write(`error: not a rule in this project's history or the installed feeds: ${unknown.join(", ")}\n` +
        `       run \`feeds.js mute --all\` to list every installed rule id\n`);
      return 1;
    }
    chosen = explicit;
  } else if (argv.includes("--yes")) {
    chosen = rows.filter((r) => r.selected).map((r) => r.id);   // non-interactive: take the preselection
  } else if (!process.stdin.isTTY) {
    // No TTY and no explicit choice: print the menu and stop. Never guess what a human would have ticked.
    process.stdout.write("\n" + muteHeader(projectDir, rows, all) + renderRows(rows, new Set(rows.filter((r) => r.selected).map((r) => r.id))) + "\n");
    process.stdout.write(`\n[x] = what \`--yes\` would mute. No TTY to prompt on, so nothing was written.\n` +
      `Re-run interactively, or: feeds.js mute --yes   (or name ids: feeds.js mute <id> …)\n`);
    return 0;
  } else {
    chosen = await muteMenu(projectDir, rows);
    if (chosen === null) return 0;
  }

  const entries = mutes.applySelection(rows, chosen, { reason });
  const p = mutes.writeMutes(projectDir, entries);
  const urlMutes = entries.filter((e) => e.feed === "urls");
  process.stdout.write(JSON.stringify({ status: "muted", count: entries.length, file: p,
    muted: entries.map((e) => ({ id: e.id, description: e.description })) }, null, 2) + "\n");
  if (urlMutes.length) {
    process.stdout.write(`\nwarning: ${urlMutes.length} muted rule(s) are from the \`urls\` feed, which denies on a ` +
      `verbatim match against a live malware-distribution list — the one feed precise enough to be worth an ` +
      `interruption. Un-mute with \`feeds.js unmute <id>\` unless you are certain the listing is wrong.\n`);
  }
  return 0;
}

function cmdUnmute(argv) {
  const i = argv.indexOf("--project");
  const projectDir = i === -1 ? process.cwd() : argv[i + 1];
  const current = mutes.readMutes(projectDir);
  if (!current.length) { process.stdout.write(JSON.stringify({ status: "nothing muted" }) + "\n"); return 0; }
  const ids = argv.slice(1).filter((a, j, arr) => !a.startsWith("--") && arr[j - 1] !== "--project");
  if (!ids.length && !argv.includes("--all")) {
    process.stderr.write(`error: name the rule ids to un-mute, or pass --all\ncurrently muted:\n` +
      current.map((e) => `  ${e.id}  ${e.description}`).join("\n") + "\n");
    return 1;
  }
  const drop = argv.includes("--all") ? new Set(current.map((e) => e.id)) : new Set(ids);
  const kept = current.filter((e) => !drop.has(e.id));
  const p = mutes.writeMutes(projectDir, kept);
  process.stdout.write(JSON.stringify({ status: "unmuted", unmuted: [...drop], remaining: kept.length, file: p }, null, 2) + "\n");
  return 0;
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
    // Freshness is part of status, not a detail: guard-bash only DENIES on a urls hit while that list is
    // fresh, and downgrades to ask once it is stale. A status that hid the age would let an owner believe
    // they are protected by data that can no longer back the claim.
    const feeds = store.list().map((f) => {
      const m = store.manifest ? store.manifest(f.name) : null;
      const fetchedAt = m && m.fetched_at ? m.fetched_at : null;
      const ageDays = fetchedAt ? Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 86400000) : null;
      const maxAge = FEED_MAX_AGE_DAYS[f.name] || 30;
      return { ...f, fetched_at: fetchedAt, age_days: ageDays, max_age_days: maxAge,
        stale: f.installed ? !(ageDays !== null && ageDays <= maxAge) : null };
    });
    const staleNames = feeds.filter((f) => f.stale).map((f) => f.name);
    const out = { decision: store.decision() || "not asked", feeds };
    if (staleNames.length) {
      out.warnings = [`stale feed data: ${staleNames.join(", ")} — run \`feeds update\`. ` +
        `A stale urls list downgrades guard-bash from deny to ask on a malware-URL hit.`];
    }
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
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
  if (cmd === "mute") return await cmdMute(argv);
  if (cmd === "unmute") return cmdUnmute(argv);
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
