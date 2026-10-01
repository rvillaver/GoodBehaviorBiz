---
name: feeds-goodbehavior
description: Opt in/out of, update, and check the status of GoodBehaviorBiz's threat feeds — external, regularly-updated detection rules (Sigma command shapes, gitleaks secrets, URLhaus malicious URLs) that augment the guard's hardcoded shapes. Use when the user wants to enable/disable feeds, refresh them, or asks what they cover.
---

Three opt-in, machine-wide detection feeds that `guard-bash.js`/`guard-injection.js` check on every guarded
command. They augment the guard's hardcoded hard-shape/zone logic, which stays exactly as it is regardless of
feed state.

## What a hit does — disposition tracks match precision

| feed | a hit means | guarded | fast | muted |
|---|---|---|---|---|
| `urls` | the exact URL is on a live malware-distribution list | **deny** | **deny** | monitor |
| `commands` | the command's shape matches a Sigma process-creation rule | **ask** | monitor | monitor |
| `secrets` | a credential-shaped string is in the command text | **ask** | monitor | monitor |

**`urls` denies because a bad entry can only block commands containing that exact string** — bounded and
recoverable via `rollback`. It is the only feed precise enough to decide in both lanes.

**`commands` is the least precise feed, not the most.** Sigma `process_creation` rules are written for server
telemetry, and the fields carrying their real signal — parent process, user, session type — are not available
to a `PreToolUse` hook and get dropped at compile time. What survives is a bare command-shape match, and those
shapes (`nohup`, `grep password`, `curl --data`, `bash -c /tmp/x`) are the ordinary vocabulary of agent work.
So it asks only in the guarded lane. It asked in both until 2026-10-02, when the audit trail showed it was
259 asks across two real projects in three weeks — every one benign, and 100% of all interruptions.

**Blocking cannot un-leak a credential already in the command**, so for `secrets` the audit line is the real
product. Both heuristic feeds defer to the lane; the exact-match one doesn't.

**Stale data downgrades `urls` from deny to ask**, and the reason says so. A list of URLs *currently*
distributing malware cannot back a block once it is weeks old. Budgets: `urls` 7 days, others 30.
**Every deny and ask carries a plain-language reason naming the feed and rule id, never the matched text.**

## What each feed is, plainly (state this at ask time — **never let the user opt in blind**)

- **`commands`** — [SigmaHQ](https://github.com/SigmaHQ/sigma) process-creation rules (linux/macos), ~3MB zip,
  compiled to the ~120 rules this guard can actually evaluate. Rules needing fields we can't see (parent
  process, user, cwd) are skipped, **never silently mis-evaluated**.
- **`secrets`** — [gitleaks](https://github.com/gitleaks/gitleaks)'s rule set (credentials/token patterns),
  ~100KB, ~220 rules, checked against command text rather than file contents.
- **`urls`** — [URLhaus](https://urlhaus.abuse.ch) (abuse.ch), a list of URLs currently distributing malware,
  ~1MB, checked against URLs found in commands and WebFetch targets. Exact-URL match only, not by host.

**Fetched only when you ask** (`update`, not automatically), stored machine-wide at `~/.goodbehavior/feeds/`
(shared across every adopted project, not re-fetched per project), never bundled into this repo.

## Commands (mechanical — **run through `scripts/feeds.js`**; judgment is only in how you present the result)

```sh
node <source>/scripts/feeds.js opt-in
node <source>/scripts/feeds.js opt-out [--remove]   # --remove also deletes already-fetched feed data
node <source>/scripts/feeds.js update [name...]     # all three if no name given; --force re-fetches unchanged
node <source>/scripts/feeds.js rollback <name>       # swap back to the previous version of one feed
node <source>/scripts/feeds.js status
node <source>/scripts/feeds.js list
node <source>/scripts/feeds.js mute [--project DIR]    # menu of the rules that have fired in THAT project
node <source>/scripts/feeds.js unmute <id...|--all> [--project DIR]
```

- `update` never leaves a feed half-written. A fetch that fails, content that fails to compile, or content that
  compiles to zero rules leaves whatever was already installed untouched and reports `feed_update_failed`.
- A successful update that changes content rotates the previous version to `previous/`. `rollback` swaps
  current and previous, so calling it twice toggles back and forth; it is not a one-way undo.

## Muting a rule that keeps asking about ordinary work

**A hook `ask` has no host-side "always allow": the same rule re-asks on every match, forever.** One rule asked
a real user 115 times in three weeks and got "yes" 115 times. So the hook carries its own memory — a per-project
mute list at `.claude/goodbehavior/feeds-ignore.json`.

**A muted rule is still matched and still audited. It only stops deciding** (floored at `monitor`, tagged
`muted: true`), and `/report-goodbehavior` lists every mute with what it absorbed that period. **Never describe
a mute as disabling a rule** — nothing here can make a hit invisible, and that is the design.

`mute` with no rule ids opens a menu built from **that project's own audit trail**, loudest first, with each
rule's description, severity, and the patterns it matches. Rules that have actually interrupted the project
arrive **pre-ticked**; the user unticks what they want to keep. Flags: `--all` lists every installed rule
instead of only those that have fired, `--yes` takes the preselection non-interactively, `--reason "…"` records
why. Without a TTY it prints the menu, marks what `--yes` would do, and writes nothing.

- **The menu cannot show the command that triggered a rule.** The audit records rule ids only, never command
  text. So it reports which rule fired and how often, and the user judges **the rule, not the command**. Say
  this when presenting the menu; don't let them assume the counts are commands they can review.
- **`urls` rules are never pre-ticked**, and muting one prints a warning: it denies on a verbatim match against
  a live malware list. For a wrong listing, prefer `rollback` over a mute.
- Per-project by design: a mute is a claim about one codebase's normal work, so it stays readable in that
  codebase's tree. **Muting the same rule in several projects is the intended cost** of not silencing it
  machine-wide. Re-running `mute` preserves the original reason and date of existing entries.

## Opt-in ask (do this before running `opt-in` on the user's behalf)

State plainly, in one or two sentences: what gets fetched (the three feeds above, **in plain language, not just
names**), **what a hit actually does** (the table above: a listed malware URL is blocked, a Sigma or credential
match is held for their confirmation), and that updates only happen when asked (`update`), not silently in the
background. **Then run
`opt-in` only after they say yes. Never opt in without this ask**, even if the user seems to want it fast. It's
a one-line command either way; the ask costs nothing and the alternative is a machine-wide state change the
user didn't clearly agree to.

## Status / reporting

`status` and `list` are safe to run without asking (read-only, no network). When summarizing `status` for the
user, **translate it**: "3 feeds installed, last updated 2 days ago, 342 rules total" reads better than the raw JSON.
For what a feed actually *caught*, that's `/report-goodbehavior`'s job (it reads the audit trail, which
includes feed hits under the shape name `feed:<name>:<rule-id>`), not this skill's.

## Honesty

**Be exact about what blocks.** Only a fresh `urls` hit denies. `commands` and `secrets` hold for confirmation
in the guarded lane and audit only in the fast one, and a muted rule audits in both. **Never say "the feeds
block malware"** — they block one narrow, verbatim case. **Never call the fast lane's quiet "protection"**: in
that lane two of the three feeds are a record, not a gate, which is the lane's stated bargain and worth saying
out loud when someone picks it. The feeds are also **best-effort translations, not the original tools running unmodified**: gitleaks regexes go
through a Go-RE2-to-JS translation (a handful of rules using syntax JS can't represent are skipped, counted,
**never silently dropped**), and Sigma rules needing process context this guard can't see (parent process, user,
current directory) are skipped the same way. **`list`/`status` report real counts. Never round up or imply full
parity with the upstream tool.**
