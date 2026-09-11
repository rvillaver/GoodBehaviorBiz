#!/usr/bin/env node
/*
 * FeedStore mechanics: opt-in state, fetch/hash/compile, rotate-to-previous, rollback, and "a compile failure
 * leaves the previous good feed in place." Uses a mocked global.fetch (restored after) so rotation/rollback
 * are tested deterministically — the adapters' correctness against real feed content is covered separately in
 * test_feeds.js and recorded live in the phase archive; this file is purely the store's own bookkeeping.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FeedStore } = require("../scripts/feeds/store");

function fakeResponse({ status = 200, body = "", etag } = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === "etag" ? etag : undefined) },
    async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); },
  };
}

// One URLhaus-shaped list per "version" — the adapter just needs one URL per line, easy to vary deterministically.
const V1 = "http://v1-bad.example.com/a\nhttp://v1-bad.example.com/b\n";
const V2 = "http://v2-bad.example.com/c\n";

async function main() {
  const failures = [];
  const check = (label, cond, detail = "") => {
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
    if (!cond) failures.push(`${label} ${detail}`);
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-feedstore-"));
  const originalFetch = global.fetch;
  try {
    const store = new FeedStore(dir);

    check("opt-in state starts undecided", store.decision() === undefined);
    store.optIn();
    check("opt-in recorded", store.optedIn() === true && store.decision() === "in");

    // ---- v1 fetch ----
    global.fetch = async () => fakeResponse({ body: V1, etag: '"v1"' });
    const r1 = await store.update("urls");
    check("v1 update: changed", r1.type === "feed_update" && r1.changed === true, JSON.stringify(r1));
    check("v1 installed", store.installed("urls"));
    check("v1 rules reflect the fetched content", store.rules("urls")[0].set.urls.includes("http://v1-bad.example.com/a"));
    check("no previous version yet (first install)", store.previousManifest("urls") === undefined);

    // ---- re-fetch identical content: not a change, no rotation ----
    global.fetch = async () => fakeResponse({ body: V1, etag: '"v1"' });
    const rSame = await store.update("urls");
    check("re-fetching identical content reports unchanged", rSame.changed === false);
    check("still no previous version (nothing rotated)", store.previousManifest("urls") === undefined);

    // ---- v2 fetch: genuinely different content -> rotates v1 into previous/ ----
    global.fetch = async () => fakeResponse({ body: V2, etag: '"v2"' });
    const r2 = await store.update("urls");
    check("v2 update: changed", r2.changed === true);
    check("v2 rules reflect the new content", store.rules("urls")[0].set.urls.includes("http://v2-bad.example.com/c"));
    check("v1 preserved as the previous version", Boolean(store.previousManifest("urls")) && store.previousManifest("urls").sha256 !== store.manifest("urls").sha256);

    // ---- rollback restores v1 ----
    const rollback = store.rollback("urls");
    check("rollback reports success", rollback.type === "feed_rollback");
    check("rollback restored v1 content", store.rules("urls")[0].set.urls.includes("http://v1-bad.example.com/a"));
    // rollback SWAPS current<->previous (not a one-way undo) — v2 is now in `previous`, so a second rollback
    // succeeds and toggles back to v2, matching BlitzPi's documented semantics for the same operation.
    const rollback2 = store.rollback("urls");
    check("second rollback succeeds, toggling back to v2", rollback2.type === "feed_rollback" && store.rules("urls")[0].set.urls.includes("http://v2-bad.example.com/c"));
    check("a third rollback toggles back to v1 again", store.rollback("urls").type === "feed_rollback" && store.rules("urls")[0].set.urls.includes("http://v1-bad.example.com/a"));

    // ---- HTTP 304 (not modified): reports unchanged without re-parsing ----
    global.fetch = async (url, opts) => {
      check("304 path sends if-none-match with the stored etag", Boolean(opts && opts.headers && opts.headers["if-none-match"]));
      return fakeResponse({ status: 304 });
    };
    const r304 = await store.update("urls");
    check("304 response reports unchanged", r304.changed === false);

    // ---- an empty/garbage source that compiles to zero rules is refused, previous good feed stays in place ----
    const beforeBreak = store.manifest("urls");
    global.fetch = async () => fakeResponse({ body: "", etag: '"empty"' });
    const rBroken = await store.update("urls", { force: true });
    check("empty/garbage source is refused (compiled to zero rules)", rBroken.type === "feed_update_failed");
    check("previous good feed is untouched after a refused update", JSON.stringify(store.manifest("urls")) === JSON.stringify(beforeBreak));
    check("rules.json is untouched too", store.rules("urls")[0].set.urls.includes("http://v1-bad.example.com/a"));

    // ---- unknown feed name ----
    const rUnknown = await store.update("not-a-real-feed");
    check("unknown feed name fails cleanly", rUnknown.type === "feed_update_failed" && /unknown feed/.test(rUnknown.error));

    // ---- opt-out ----
    store.optOut(true);
    check("opt-out recorded and flips opted-in off", store.decision() === "out" && store.optedIn() === false);
    check("opt-out with removeFeeds removes fetched data", !fs.existsSync(store.feedDir("urls")));
    check("liveRules returns undefined once opted out (hook must not use stale opted-out data)", store.liveRules("urls") === undefined);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`test_feeds_store: ${failures.length ? "FAILED: " + failures.join("; ") : "all passed"}`);
  return failures.length ? 1 : 0;
}

main().then((code) => process.exit(code));
