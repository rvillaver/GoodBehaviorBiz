#!/usr/bin/env node
/*
 * GoodBehavior self-test — the bundle held to its own standard: verified, not self-declared.
 * Runs every tests/test_*.js as a subprocess and aggregates. One command, exit 0 = green:
 *   node tests/run_all.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const HERE = __dirname;

function main() {
  const suites = fs.readdirSync(HERE)
    .filter((f) => f.startsWith("test_") && f.endsWith(".js")).sort();
  const failed = [];
  for (const suite of suites) {
    console.log(`\n== ${suite} ==`);
    const r = spawnSync("node", [path.join(HERE, suite)], { stdio: "inherit" });
    if (r.status !== 0) failed.push(suite);
  }
  console.log(`\n${"=".repeat(40)}`);
  if (failed.length) { console.log(`FAILED: ${failed.join(", ")}`); return 1; }
  console.log(`all ${suites.length} suites passed`);
  return 0;
}

process.exit(main());
