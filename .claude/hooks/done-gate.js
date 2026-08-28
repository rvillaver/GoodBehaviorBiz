#!/usr/bin/env node
/*
 * GoodBehavior done-gate — a Stop hook that pushes back on self-declared "done".
 *
 * When the last assistant message makes an explicit completion claim without support, it blocks the
 * stop once and feeds back a short self-check. Heuristic nudge, not a lie detector: conservative
 * claim-matching, single fire per turn (the stop_hook_active guard prevents loops).
 *
 * Two layers:
 *   LEXICAL    — what the message says. An honest hedge ("not done yet") always lets the stop through.
 *                Verification vocabulary ("verified", "I ran") is only a *claim* of proof.
 *   BEHAVIORAL — what the turn did. Proof vocabulary is honored only if something was actually
 *                run/observed AFTER the last file change this turn. "Edited, ran nothing, said
 *                'verified'" blocks: the final state was never observed.
 *
 * Wire as a Stop hook in .claude/settings.json. Requires only node (no dependencies).
 */
"use strict";

// Tools whose use means the turn did real build work (lowercased) — arms the gate.
const BUILD_TOOLS = new Set(["edit_file", "write_file", "shell_command"]);
// Tools that MUTATE files (for the behavioral check: what was the last change?).
const MUTATION_TOOLS = new Set(["edit_file", "write_file"]);
// Tools whose use counts as OBSERVING real behavior. Sub-agent results are relayed, not firsthand — excluded.
const OBSERVE_TOOLS = new Set(["shell_command", "web_fetch"]);
const OBSERVE_NAME_HINTS = ["browser", "puppeteer", "playwright", "chrome"];
// Extensions where "run it" usually doesn't apply — prose/docs skip the behavioral check.
const DOC_EXTENSIONS = [".md", ".markdown", ".txt", ".rst", ".adoc"];

// Patterns are tested against lowercased text (parity with the Python which lowercases first).
const CLAIM = /(✅|\bit'?s (now )?(done|complete|working)\b|\b(all )?(done|complete|completed|finished|shipped)\b|\bworks now\b|\bfully (working|functional)\b|\bgood to go\b|\ball set\b)/;
const HEDGE = /(not (yet|done)|isn't done|unverified|partial|in progress|pending|blocked|deferred|backlog|to verify|still to|left to do|remaining|please (check|review|confirm)|you (can )?(check|confirm))/;
const PROOF = /(verif|screenshot|i ran|ran the|test(s)? pass|passing|confirm|evidence|rendered|observed)/;
const META = /(done-gate|good ?behavior|the (gate|hook)|this hook|stop hook|the regex|false (positive|trigger))/;

const MSG_NO_EVIDENCE =
  "GoodBehavior done-gate — you claimed completion. Before ending, self-check:\n" +
  "  1) Did you exercise the REAL thing the way its consumer would (per the project's profile) — not just a test/your description?\n" +
  "  2) Can you SHOW the evidence (result vs. reference; the flow firing / validation output / source-backed claim)?\n" +
  "  3) Is it user-confirmed? If not, say \"not done yet\" / state what's left — don't self-declare done.\n" +
  "Then either present the evidence, soften the claim, or record a learning and continue.\n";

const MSG_HOLLOW_PROOF =
  "GoodBehavior done-gate — you claim verification, but this turn ran/observed NOTHING after its last\n" +
  "file change: the final state of the work was never exercised. Either actually run/observe the real\n" +
  "thing now (per the project's profile) and show the result, or downgrade the claim to \"unverified /\n" +
  "not done yet\" and say what's left. A proof-word without an observation is the exact failure this\n" +
  "method exists to stop.\n";

const fs = require("fs");

function main(data) {
  // Don't re-fire on our own continuation (avoids an infinite stop loop).
  if (data.stop_hook_active) process.exit(0);

  const entries = loadEntries(data.transcript_path || "");
  const text = lastAssistantText(entries);
  if (!text) process.exit(0);
  const t = text.toLowerCase();

  const tools = turnToolUses(entries);

  // (3) Activity gate: a turn that didn't build anything can't have "finished" anything.
  if (!tools.some(([name]) => BUILD_TOOLS.has(name))) process.exit(0);
  // (1) Meta escape: discussing the gate/framework uses words like "done" incidentally.
  if (META.test(t)) process.exit(0);
  // (2) Assertive only: the claim must head a short clause, not lurk in a long sentence.
  if (!assertiveClaim(text)) process.exit(0);
  // (0a) An honest hedge always passes — never punish the downgrade.
  if (HEDGE.test(t)) process.exit(0);
  // (0b) Verification vocabulary passes only when the behavior backs it.
  if (PROOF.test(t)) {
    if (docOnlyMutations(tools) || observedAfterLastMutation(tools)) process.exit(0);
    process.stderr.write(MSG_HOLLOW_PROOF);
    process.exit(2);
  }
  process.stderr.write(MSG_NO_EVIDENCE);
  process.exit(2); // blocks the stop; stderr is returned to the model
}

function assertiveClaim(text) {
  // A completion word counts only inside a short, declarative clause — not buried in prose.
  for (const raw of text.split(/[.!?\n]+/)) {
    const s = raw.trim();
    if (!s) continue;
    if (s.split(/\s+/).length > 12) continue; // incidental mention inside a longer sentence
    if (CLAIM.test(s.toLowerCase())) return true;
  }
  return false;
}

function isObserveTool(name) {
  return OBSERVE_TOOLS.has(name) || OBSERVE_NAME_HINTS.some((h) => name.includes(h));
}

function observedAfterLastMutation(tools) {
  // Was anything run/fetched/driven AFTER the last file mutation this turn? A turn with no mutations
  // armed the gate via bash alone — it executed something, which is itself an observation, so it passes.
  let lastMutation = -1;
  tools.forEach(([name], i) => { if (MUTATION_TOOLS.has(name)) lastMutation = i; });
  if (lastMutation === -1) return true;
  return tools.slice(lastMutation + 1).some(([name]) => isObserveTool(name));
}

function docOnlyMutations(tools) {
  // True if every file mutation this turn touched only prose/doc files (and at least one did).
  const paths = [];
  for (const [name, input] of tools) {
    if (!MUTATION_TOOLS.has(name)) continue;
    let p = "";
    if (input && typeof input === "object") {
      p = input.file_path || input.path || input.notebook_path || "";
    }
    paths.push(String(p).toLowerCase());
  }
  if (!paths.length) return false;
  return paths.every((p) => DOC_EXTENSIONS.some((ext) => p.endsWith(ext)));
}

function entryRole(e) {
  const msg = e.message || e;
  return e.role || msg.role || e.type;
}

function isHumanTurn(e) {
  // A real human message — not a tool_result (which the transcript also stores as role 'user').
  if (entryRole(e) !== "user") return false;
  const content = (e.message || e).content || "";
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some((b) => b && b.type === "text" && (b.text || "").trim());
  }
  return false;
}

function turnToolUses(entries) {
  // All [tool_name, tool_input] the assistant used since the last human message, in order.
  let lastHuman = -1;
  entries.forEach((e, i) => { if (isHumanTurn(e)) lastHuman = i; });
  const out = [];
  for (const e of entries.slice(lastHuman + 1)) {
    if (entryRole(e) !== "assistant") continue;
    const content = (e.message || e).content || "";
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && b.type === "tool_use") out.push([(b.name || "").toLowerCase(), b.input || {}]);
      }
    }
  }
  return out;
}

function lastAssistantText(entries) {
  let last = "";
  for (const e of entries) {
    if (entryRole(e) !== "assistant") continue;
    const content = (e.message || e).content || "";
    let txt = "";
    if (typeof content === "string") txt = content;
    else if (Array.isArray(content)) {
      txt = content.filter((b) => b && b.type === "text").map((b) => b.text || "").join(" ");
    }
    if (txt.trim()) last = txt;
  }
  return last;
}

function loadEntries(path) {
  if (!path) return [];
  let raw;
  try { raw = fs.readFileSync(path, "utf8"); } catch (e) { return []; }
  const out = [];
  for (let line of raw.split("\n")) {
    line = line.trim();
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* skip */ }
  }
  return out;
}

// Read stdin fully, then run. Never break the session on a parse error.
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { buf += c; });
process.stdin.on("end", () => {
  let data;
  try { data = JSON.parse(buf); } catch (e) { process.exit(0); }
  main(data);
});
