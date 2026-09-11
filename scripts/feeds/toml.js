/*
 * Scoped TOML parser — re-derived clean, zero dependencies. Not the TOML spec: just what gitleaks.toml actually
 * uses (checked against the real file, not assumed): comments; [table] and [[array-of-table]] headers, including
 * dotted paths for nesting (e.g. [[rules.allowlists]] — an array under the most recently opened `rules` entry);
 * key = value pairs where value is a double-quoted string (with \-escapes), a triple-quoted '''literal''' or
 * single-quoted 'literal' string (no escape processing), a bare number/bool, or an array of any of those
 * (single- or multi-line, trailing comma allowed). No inline tables, no dotted keys-as-values, no datetime,
 * no multi-document — none appear in the real file this was built and tested against.
 */
"use strict";

const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\" };

function parseToml(text) {
  const n = text.length;
  let i = 0;
  const root = {};
  let current = root;

  function skipWsAndComments(acrossNewlines) {
    for (;;) {
      while (i < n && (text[i] === " " || text[i] === "\t" || (acrossNewlines && (text[i] === "\n" || text[i] === "\r")))) i++;
      if (text[i] === "#") { while (i < n && text[i] !== "\n") i++; continue; }
      break;
    }
  }

  function parseString() {
    if (text.startsWith("'''", i)) {
      i += 3;
      if (text[i] === "\n") i++;
      const end = text.indexOf("'''", i);
      const val = end === -1 ? text.slice(i) : text.slice(i, end);
      i = end === -1 ? n : end + 3;
      return val;
    }
    if (text[i] === "'") {
      i++;
      const end = text.indexOf("'", i);
      const val = end === -1 ? text.slice(i) : text.slice(i, end);
      i = end === -1 ? n : end + 1;
      return val;
    }
    if (text.startsWith('"""', i)) {
      i += 3;
      if (text[i] === "\n") i++;
      let out = "";
      while (i < n && !text.startsWith('"""', i)) {
        if (text[i] === "\\") { out += ESCAPES[text[i + 1]] ?? text[i + 1]; i += 2; continue; }
        out += text[i]; i++;
      }
      i += 3;
      return out;
    }
    if (text[i] === '"') {
      i++;
      let out = "";
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\") { out += ESCAPES[text[i + 1]] ?? text[i + 1]; i += 2; continue; }
        out += text[i]; i++;
      }
      i++;
      return out;
    }
    return null;
  }

  function parseValue() {
    skipWsAndComments(false);
    if (text[i] === "'" || text[i] === '"') return parseString();
    if (text[i] === "[") {
      i++;
      const arr = [];
      for (;;) {
        skipWsAndComments(true);
        if (text[i] === "]") { i++; break; }
        if (i >= n) break;
        arr.push(parseValue());
        skipWsAndComments(true);
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; break; }
      }
      return arr;
    }
    const rest = text.slice(i);
    const num = /^-?\d+(\.\d+)?/.exec(rest);
    if (num) { i += num[0].length; return Number(num[0]); }
    if (rest.startsWith("true")) { i += 4; return true; }
    if (rest.startsWith("false")) { i += 5; return false; }
    while (i < n && text[i] !== "\n") i++; // unrecognized value shape — best-effort skip, never throw
    return null;
  }

  function openTablePath(pathParts, isArray) {
    let obj = root;
    for (let k = 0; k < pathParts.length; k++) {
      const key = pathParts[k];
      const last = k === pathParts.length - 1;
      if (last && isArray) {
        if (!Array.isArray(obj[key])) obj[key] = [];
        const entry = {};
        obj[key].push(entry);
        return entry;
      }
      if (last) {
        if (typeof obj[key] !== "object" || obj[key] === null) obj[key] = {};
        return obj[key];
      }
      if (Array.isArray(obj[key])) { obj = obj[key][obj[key].length - 1]; continue; }
      if (typeof obj[key] !== "object" || obj[key] === null) obj[key] = {};
      obj = obj[key];
    }
    return obj;
  }

  while (i < n) {
    skipWsAndComments(true);
    if (i >= n) break;
    if (text.startsWith("[[", i)) {
      i += 2;
      const start = i;
      while (i < n && text[i] !== "]") i++;
      const path = text.slice(start, i).trim().split(".");
      i += 2;
      current = openTablePath(path, true);
      continue;
    }
    if (text[i] === "[") {
      i++;
      const start = i;
      while (i < n && text[i] !== "]") i++;
      const path = text.slice(start, i).trim().split(".");
      i++;
      current = openTablePath(path, false);
      continue;
    }
    const keyStart = i;
    while (i < n && /[A-Za-z0-9_-]/.test(text[i])) i++;
    if (i === keyStart) { i++; continue; }
    const key = text.slice(keyStart, i);
    skipWsAndComments(false);
    if (text[i] !== "=") continue;
    i++;
    current[key] = parseValue();
  }
  return root;
}

module.exports = { parseToml };
