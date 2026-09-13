---
name: feeds-goodbehavior
description: Opt in/out of, update, and check the status of GoodBehaviorBiz's threat feeds — external, regularly-updated detection rules (Sigma command shapes, gitleaks secrets, URLhaus malicious URLs) that augment the guard's hardcoded shapes. Use when the user wants to enable/disable feeds, refresh them, or asks what they cover.
---

Three opt-in, machine-wide detection feeds that `guard-bash.js`/`guard-injection.js` check on every guarded
command. They augment the guard's hardcoded hard-shape/zone logic, which stays exactly as it is regardless of
feed state.

## What a hit does — disposition tracks match precision, not the lane

| feed | a hit means | guarded | fast |
|---|---|---|---|
| `urls` | the exact URL is on a live malware-distribution list | **deny** | **deny** |
| `commands` | the command shape matches a known-malicious Sigma rule | **ask** | **ask** |
| `secrets` | a credential-shaped string is in the command text | **ask** | **monitor** |

**`urls` denies because a bad entry can only block commands containing that exact string** — bounded and
recoverable via `rollback`. A bad regex can match everything, and once did, which is why `secrets` is the
cautious one. **Blocking cannot un-leak a credential already in the command**, so for `secrets` the audit line
is the real product. The lane is consulted only for `secrets`: the noisiest feed defers to it, the precise ones
don't.

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
```

- `update` never leaves a feed half-written. A fetch that fails, content that fails to compile, or content that
  compiles to zero rules leaves whatever was already installed untouched and reports `feed_update_failed`.
- A successful update that changes content rotates the previous version to `previous/`. `rollback` swaps
  current and previous, so calling it twice toggles back and forth; it is not a one-way undo.

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

**Be exact about what blocks.** Only a fresh `urls` hit denies; `commands` and `secrets` hold for confirmation,
and `secrets` only audits in the fast lane. **Never say "the feeds block malware"** — they block one narrow,
verbatim case. The feeds are also **best-effort translations, not the original tools running unmodified**: gitleaks regexes go
through a Go-RE2-to-JS translation (a handful of rules using syntax JS can't represent are skipped, counted,
**never silently dropped**), and Sigma rules needing process context this guard can't see (parent process, user,
current directory) are skipped the same way. **`list`/`status` report real counts. Never round up or imply full
parity with the upstream tool.**
