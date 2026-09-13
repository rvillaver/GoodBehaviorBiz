#!/usr/bin/env node
/*
 * Counts the six AI-register patterns, normalised per 1000 words, over any set of files or strings.
 * Patterns 2, 4 and 6 are regex PROXIES, not reliable detectors: they undercount paraphrased cases and
 * overcount legitimate ones. Treat them as a consistent yardstick applied identically to two versions of
 * one document, never as ground truth about one document on its own.
 *
 * `ruleOfThree` is the clearest case and worth stating so nobody "fixes" a document to satisfy it. It
 * counts three-item constructions; it cannot tell a padded triple from a real closed list. A rules-dense
 * doc scored 13 per 1000 words and every match was a genuine enumeration ("a genuine decision, a real
 * failure, or an irreversible step"). The rule is "don't find a third item to complete the rhythm", NOT
 * "never write three things" — editing real content to lower this number is the proxy-gaming the method
 * exists to stop. Same for `aphorism`: bolding rules raises it by design.
 */
"use strict";
const fs = require("fs");

const stripCode = (s) => s.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");

function count(text) {
  const t = stripCode(text);
  const words = t.split(/\s+/).filter(Boolean).length || 1;
  const n = (re) => (t.match(re) || []).length;

  return { words,
    emDash: n(/—/g),
    negParallel: n(/\bnot\s+[^.;\n]{2,45}[,;]\s*(?:but|it'?s|rather)\b/gi)
               + n(/\b(?:isn'?t|aren'?t|is not|are not)\b[^.\n]{0,70}\bit'?s\b/gi)
               + n(/\bnot\s+(?:just|only|merely)\b[^.\n]{0,45}\bbut\b/gi)
               + n(/^\s*\*{0,2}(?:Not|No)\s+[a-z]/gm),
    aphorism:    (t.match(/\*\*([^*\n]{8,70})\*\*/g) || [])
                   .map((s) => s.replace(/\*\*/g, ""))
                   .filter((s) => /^[A-Z@"'`]/.test(s) && /\.$/.test(s) && s.split(/\s+/).length <= 11).length,
    ruleOfThree: n(/\b[\w''-]+(?:\s+[\w''-]+){0,3},\s+[\w''-]+(?:\s+[\w''-]+){0,3},\s+(?:and|or)\s+/gi),
    inflatedAbs: n(/\b(discipline|invariant|throughline|doctrine|non-negotiable|cheatable|load-bearing|earned escalation|the real thing)\b/gi),
    reversal:    n(/(?:^|[.!?]\s+)\*{0,2}(?:But|Yet|In fact|Actually|Instead|Rather)\b/g)
               + n(/\b(?:is|are|was|were)\s+not\s+[^.\n]{2,45}\.\s*(?:It|They)\s+(?:is|are)\b/gi),
  };
}

function gather(paths) {
  let s = "";
  for (const p of paths) { try { s += fs.readFileSync(p, "utf8") + "\n"; } catch {} }
  return s;
}

const KEYS = ["emDash","negParallel","aphorism","ruleOfThree","inflatedAbs","reversal"];
const per1k = (c, k) => (c[k] / c.words) * 1000;

if (require.main === module) {
  const mode = process.argv[2];
  const sets = JSON.parse(process.argv[3]);  // {label: [paths]}
  const res = {};
  for (const [label, paths] of Object.entries(sets)) res[label] = count(gather(paths));
  const labels = Object.keys(res);
  console.log(mode);
  console.log("pattern".padEnd(14) + labels.map((l) => l.padEnd(13)).join("") + (labels.length > 1 ? "change" : ""));
  for (const k of KEYS) {
    const v = labels.map((l) => per1k(res[l], k));
    const raw = labels.map((l) => res[l][k]);
    const chg = labels.length < 2 ? null : v[0] > 0 ? ((v[1] - v[0]) / v[0]) * 100 : 0;
    console.log(k.padEnd(14) + labels.map((l, i) => (v[i].toFixed(1) + " (" + raw[i] + ")").padEnd(13)).join("")
      + (chg === null ? "" : (chg >= 0 ? "+" : "") + chg.toFixed(0) + "%"));
  }
  console.log("words".padEnd(14) + labels.map((l) => String(res[l].words).padEnd(13)).join(""));
}
module.exports = { count, KEYS, per1k };
