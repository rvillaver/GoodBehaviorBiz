#!/usr/bin/env node
/*
 * done-gate.js behavior tests — drive the hook as a real subprocess with synthetic transcripts.
 * Each case builds a JSONL transcript (human turn -> assistant tool uses -> final assistant text),
 * pipes the Stop-hook stdin JSON, and asserts the exit code (0 = allowed, 2 = blocked) and, when
 * blocked, which message fired (bare-claim vs hollow-proof).
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOOK = path.join(__dirname, "..", ".claude", "hooks", "done-gate.js");

const entryHuman = (text) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const entryTool = (name, input) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input: input || {} }] } });
const entryText = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

function runHook(tools, finalText, stopHookActive = false) {
  const entries = [entryHuman("please do the task")];
  for (const [n, i] of tools) entries.push(entryTool(n, i));
  entries.push(entryText(finalText));
  const p = path.join(os.tmpdir(), `dg-${process.pid}-${Math.floor(Math.random() * 1e9)}.jsonl`);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  try {
    const r = spawnSync("node", [HOOK], {
      input: JSON.stringify({ transcript_path: p, stop_hook_active: stopHookActive }),
      encoding: "utf8",
    });
    return [r.status, r.stderr || ""];
  } finally {
    fs.unlinkSync(p);
  }
}

// HOST TOOL NAMES, deliberately. These fixtures used the .commandcode snake_case names
// (edit_file / shell_command) while Claude Code emits Edit / Bash, so every set in done-gate missed,
// the activity gate exited 0 on every turn, and the hook never fired — with this suite green
// throughout. Fixtures must speak the names a real host emits. The snake_case forms are covered
// separately below so the sibling host keeps working.
const EDIT_CODE = ["Edit", { file_path: "src/app.py" }];
const EDIT_DOC = ["Edit", { file_path: "README.md" }];
const BASH = ["Bash", { command: "pytest -q" }];
const EDIT_CODE_SNAKE = ["edit_file", { file_path: "src/app.py" }];
const BASH_SNAKE = ["shell_command", { command: "pytest -q" }];
const BROWSER = ["browser_navigate", { url: "http://localhost:3000" }];

const CASES = [
  ["discussion turn, bare claim -> allowed (activity gate)", [], "Done. The feature is complete.", 0, null],
  ["edited code, bare 'Done.' -> blocked (no evidence)", [EDIT_CODE], "Done. The feature is complete.", 2, "claimed completion"],
  ["edited code, 'verified' but ran NOTHING -> blocked (hollow proof)", [EDIT_CODE], "Done — I verified it works.", 2, "ran/observed NOTHING"],
  ["'confirmed' cheat with zero observation -> blocked (hollow proof)", [EDIT_CODE], "Complete. I confirm everything is correct.", 2, "ran/observed NOTHING"],
  ["edit then bash, 'tests pass' -> allowed (proof backed by behavior)", [EDIT_CODE, BASH], "Done — I ran the tests and they pass.", 0, null],
  ["bash BEFORE last edit, 'verified' -> blocked (final state never observed)", [BASH, EDIT_CODE], "Done — verified earlier, all good to go.", 2, "ran/observed NOTHING"],
  ["edit then browser drive, 'verified' -> allowed (browser counts as observing)", [EDIT_CODE, BROWSER], "Done — verified in the browser.", 0, null],
  ["doc-only edit, 'verified' -> allowed (nothing to run for prose)", [EDIT_DOC], "Done — reworded the section, verified the links.", 0, null],
  ["doc-only edit, bare 'Done.' -> still blocked (lexical layer holds)", [EDIT_DOC], "Done. All finished.", 2, "claimed completion"],
  ["honest hedge -> always allowed", [EDIT_CODE], "The code is written but not yet verified live.", 0, null],
  ["hedge with completion word -> allowed (honesty never punished)", [EDIT_CODE], "Done with the edits, but this is unverified — needs a live run.", 0, null],
  ["bash-only turn, 'confirmed' -> allowed (execution is itself observation)", [BASH], "Done — migration ran, confirmed row counts.", 0, null],
  ["meta discussion about the gate -> allowed", [EDIT_CODE], "The done-gate is now stricter. Done.", 0, null],
  ["stop_hook_active guard -> allowed (no loop)", [EDIT_CODE], "Done. The feature is complete.", 0, null],

  // Hedge scoping: a hedge about ONE item must not exempt an unbacked proof-claim about another.
  // Observed live — "verified: X. Everything else is pending your answer." passed the whole-message
  // hedge test while nothing had run since the edit. Under standing-proceed, where one turn closes
  // several items, this is the ordinary shape of a final message, not an edge case.
  ["proof about A + hedge about B, nothing run -> blocked (hedge is scoped)", [EDIT_CODE],
    "Done. parseWindow() is verified: 90d === 90. Everything else is on hold pending your answer.", 2, "ran/observed NOTHING"],
  ["proof AND hedge in the same clause -> allowed (a real downgrade)", [EDIT_CODE],
    "I have not verified this yet.", 0, null],
  ["hedge with no proof word at all -> allowed (unchanged behaviour)", [EDIT_CODE],
    "Done with the edit, but the tests are still to run.", 0, null],

  // Sibling-host names must keep working: the alias map folds hosts onto one canonical set rather
  // than replacing one convention with another.
  ["snake_case host: edit + unbacked 'verified' -> blocked", [EDIT_CODE_SNAKE],
    "Done. Verified it works.", 2, "ran/observed NOTHING"],
  ["snake_case host: edit then run -> allowed", [EDIT_CODE_SNAKE, BASH_SNAKE],
    "Done. Verified — tests pass.", 0, null],
];

function main() {
  let failures = 0;
  for (const [label, tools, text, wantExit, wantFrag] of CASES) {
    const active = label.includes("stop_hook_active");
    const [code, err] = runHook(tools, text, active);
    const ok = code === wantExit && (wantFrag === null || err.includes(wantFrag));
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) {
      failures++;
      console.log(`        expected exit=${wantExit} frag=${JSON.stringify(wantFrag)}; got exit=${code} stderr=${JSON.stringify(err.slice(0, 200))}`);
    }
  }
  console.log(`test_hook: ${CASES.length - failures}/${CASES.length} passed`);
  return failures ? 1 : 0;
}

process.exit(main());
