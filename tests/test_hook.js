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

const EDIT_CODE = ["edit_file", { file_path: "src/app.py" }];
const EDIT_DOC = ["edit_file", { file_path: "README.md" }];
const BASH = ["shell_command", { command: "pytest -q" }];
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
