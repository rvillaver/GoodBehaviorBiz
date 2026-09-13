---
name: report-goodbehavior
description: Turn the guard's audit trail into an owner-readable digest — what ran, what got blocked or flagged and why, over a period. Use when the user wants a report/summary of guard activity, or asks "what has the guard actually caught."
---

The audit trail (`.claude/goodbehavior/audit/*.jsonl`) is the guard's headline feature: every guarded decision,
written as it happens. This skill is how an owner reads it without grepping JSONL by hand.

## Run the script (mechanical half)

The parsing/counting is deterministic. **Run it, don't re-derive it:**
```sh
node <source>/scripts/report.js --target <project>   # add --since YYYY-MM-DD --until YYYY-MM-DD to scope a period
```
It reads every `<target>/.claude/goodbehavior/audit/YYYY-MM-DD.jsonl` and returns one JSON summary: total event
count; counts by decision (`deny`/`ask`/`allow`/`annotated`/`monitor`), by tool, and by named shape; and the full
list of **notable** entries, meaning everything except a plain silent in-project allow (so: every deny, every ask,
every injection annotation, every fast-lane gray-zone allow, and every threat-feed hit). If there's no audit
directory at all, it says so in `warnings` rather than erroring. That's a legitimate state (the guard isn't
wired here, or nothing has happened yet), not a failure.

## Turn it into the digest (judgment half)

Write a short, plain-language summary a non-technical owner can read in under a minute:
- **Period covered** — the date range / files actually found. **Never claim more than what's on disk.**
- **Headline numbers** — total events, and the split between "ran normally" (silent in-project allows, not in
  `notable`) and "the guard did something" (the `notable` count).
- **What got blocked** (`deny`) — group by shape, with a plain-language name for each (`sudo-doas` → "a command
  tried to run with elevated privileges"; `download-piped-to-shell` → "a command tried to pipe a downloaded
  script straight into a shell"). **Don't just dump shape names. Translate them.**
- **What got asked** (`ask`, guarded lane) — group by zone (home/system/project-adjacent), plain-language: "N
  commands tried to touch files outside the project and were held for confirmation."
- **What got flagged, not blocked** (`annotated`, the injection layer, and fast-lane gray-zone `allow`s) — **make
  the distinction clear: these ran, the guard only left a note. Don't let a reader conflate this with `deny`.**
- **What the threat feeds caught** (`monitor`, shape named `feed:<feed>:<rule-id>`) — opt-in, monitor-only by
  design (see `/feeds-goodbehavior`): these ran too, same as `annotated`. **Translate the feed name**
  (`commands`→"a known-risky command shape", `secrets`→"a credential-shaped pattern", `urls`→"a URL listed as
  distributing malware") **rather than printing the raw rule id.**
- **If `notable` is empty** — say so plainly ("nothing notable this period — N events, all normal in-project
  activity"). An empty report is a legitimate, good result. **Don't pad it out or apologize for it.**

**Never invent detail beyond what the JSON gives you. If `warnings` is non-empty, surface it.**

## Where it lives
Present the digest in the response. If the user wants it saved, write it under the project's own reports
location (ask if unclear — default `docs/reports/goodbehavior-<since>-to-<until>.md` or, for an unscoped run,
`docs/reports/goodbehavior-<today>.md`) so it's a normal, project-owned artifact. An audit report is exactly the
kind of settled, shareable document that belongs in the repo, not narrative/plan-shaped scratch.

## Honesty
This is a report on what the *blocklist* caught. **A `notable` count of zero means "nothing matched what the
guard knows to look for," not "nothing happened." State that distinction** if the user's request implies otherwise
("show me everything risky that happened" is a bigger claim than this report can back).
