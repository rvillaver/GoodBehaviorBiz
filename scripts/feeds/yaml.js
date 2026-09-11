/*
 * Scoped YAML parser — re-derived clean, zero dependencies. Not the YAML spec: the block-style core that real
 * Sigma rules actually use (checked against 137 real linux/macos process_creation rules from a live SigmaHQ
 * release, not assumed): indentation-nested block mappings and block sequences (including sequences whose
 * items are themselves multi-key mappings, first key inline after "- "), plain/single/double-quoted scalars,
 * and comments. No anchors/aliases, no multi-document, no flow style ({}/[]), no block scalars (|/>), no
 * explicit type tags — none appear in any real rule this was built and tested against.
 *
 * The one YAML rule that matters most for correctness: a colon only starts "key: value" when followed by a
 * space or end-of-line. A bare URL like `https://example.com/path` contains ":" followed by "/", so it must
 * stay a plain scalar, never get misread as a nested mapping key — every split below respects that.
 */
"use strict";

const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\" };

function stripComment(line) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inS) { if (c === "'") inS = false; continue; }
    if (inD) { if (c === "\\") { i++; continue; } if (c === '"') inD = false; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) return line.slice(0, i);
  }
  return line;
}

// First unquoted ": " or a trailing ":" — the only thing that means "this line is a mapping key". Returns
// null if the line isn't a key: value line at all (e.g. a plain scalar sequence item, or a bare URL).
function splitKeyValue(content) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (inS) { if (c === "'") inS = false; continue; }
    if (inD) { if (c === "\\") { i++; continue; } if (c === '"') inD = false; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === ":" && (i === content.length - 1 || content[i + 1] === " ")) {
      return { key: parseScalarValue(content.slice(0, i).trim()), rest: content.slice(i + 1).trim() };
    }
  }
  return null;
}

function parseScalarValue(text) {
  if (text === "") return null;
  if (text[0] === '"') {
    let i = 1;
    let out = "";
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") { out += ESCAPES[text[i + 1]] ?? text[i + 1]; i += 2; continue; }
      out += text[i]; i++;
    }
    return out;
  }
  if (text[0] === "'") {
    let i = 1;
    let out = "";
    while (i < text.length) {
      if (text[i] === "'" && text[i + 1] === "'") { out += "'"; i += 2; continue; }
      if (text[i] === "'") break;
      out += text[i]; i++;
    }
    return out;
  }
  return text; // plain scalar — no escape processing
}

function isSeqItem(content) { return content === "-" || content.startsWith("- "); }

function parseYaml(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^---\s*$/.test(line) || /^\.\.\.\s*$/.test(line)) continue;
    const stripped = stripComment(line);
    if (!stripped.trim()) continue;
    rows.push({ indent: stripped.length - stripped.trimStart().length, content: stripped.trim() });
  }
  let pos = 0;

  function parseNode(minIndent) {
    if (pos >= rows.length || rows[pos].indent < minIndent) return null;
    const indent = rows[pos].indent;
    return isSeqItem(rows[pos].content) ? parseSeq(indent) : parseMap(indent);
  }

  // Block scalars (`key: |` literal, `key: >` folded, optional chomp +/- and explicit indent digit) — the
  // exact text isn't needed by anything downstream (only description fields use this in real Sigma rules), so
  // it's consumed structurally (skip every row indented deeper than the key) rather than reconstructed.
  const BLOCK_SCALAR = /^[|>][+-]?\d*$/;
  function setEntry(obj, kv, indent) {
    if (BLOCK_SCALAR.test(kv.rest)) {
      while (pos < rows.length && rows[pos].indent > indent) pos++;
      obj[kv.key] = null;
      return;
    }
    obj[kv.key] = kv.rest === "" ? parseNode(indent + 1) : parseScalarValue(kv.rest);
  }

  function parseMap(indent) {
    const obj = {};
    while (pos < rows.length && rows[pos].indent === indent && !isSeqItem(rows[pos].content)) {
      const kv = splitKeyValue(rows[pos].content);
      if (!kv) { pos++; continue; } // unrecognized line shape — best-effort skip, never throw
      pos++;
      setEntry(obj, kv, indent);
    }
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    while (pos < rows.length && rows[pos].indent === indent && isSeqItem(rows[pos].content)) {
      const content = rows[pos].content;
      const m = /^-(\s+)(.*)$/.exec(content);
      const rest = m ? m[2] : "";
      const itemCol = indent + 1 + (m ? m[1].length : 0);
      if (rest === "") {
        pos++;
        arr.push(parseNode(indent + 1));
        continue;
      }
      const kv = splitKeyValue(rest);
      if (kv) {
        pos++;
        const obj = {};
        setEntry(obj, kv, itemCol);
        while (pos < rows.length && rows[pos].indent === itemCol && !isSeqItem(rows[pos].content)) {
          const kv2 = splitKeyValue(rows[pos].content);
          if (!kv2) break;
          pos++;
          setEntry(obj, kv2, itemCol);
        }
        arr.push(obj);
      } else {
        pos++;
        arr.push(parseScalarValue(rest));
      }
    }
    return arr;
  }

  return parseNode(0) ?? {};
}

module.exports = { parseYaml };
