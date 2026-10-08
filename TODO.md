# GoodBehavior — TODO

Open work on the bundle itself. Keep everything here **generic** — GoodBehavior is a portable method, not a record of any
one project. Project-specific instances are where these lessons are *learned*; this file is where the **generic** form
gets baked back into the loop.

## The mechanism this file serves: local learnings → baked into the loop

GoodBehavior should improve by **promoting locally-learned good practices into its generic principles.** A project hits a
trap, `/learn-goodbehavior` records it as a project memory, and when that lesson is really a *general* discipline (not a
project fact), its generic form is distilled into `CLAUDE.md` / the relevant skill — so every future adoption inherits it.
The self-update model (`/update-goodbehavior`, 3-way merge) is the carrier: a principle improved in one project's copy can
flow upstream and back out to others.

## Open

**Add new items here**; move them down with a date when they land. Settled work lives in the log below — it is
not deleted, it just stops competing with live work for the top of the file.

- [ ] **Skip the un-evaluable Sigma rules at compile time, with a named reason each.** The 2026-10-02 entry
      below made the `commands` feed quiet by lane and by mute, which is the right fix for the *interruption*.
      It does not fix the *corpus*: ten rules whose signal lives in fields a `PreToolUse` hook never sees are
      still compiled in and still matched. `scripts/feeds/` already has the honest mechanism — rules needing
      unavailable fields are skipped and counted, never guessed — so these belong in `skipped` with a reason,
      not in `rules`. Needs a decision on the criterion (per-rule list vs. "any rule whose selections reduce
      to a bare CommandLine substring") plus tests; **the criterion is the whole question, so don't start by
      hardcoding ten UUIDs.**
- [ ] **Audit the remaining `never`/`only` claims in the hook comments against their code.** Twice now a false
      invariant has sat in a header comment reading as reassurance: the fail-open guard (2026-09-14) and the
      feed section's "monitor-mode only" (2026-10-02). Two is a pattern. Grep the three hooks for absolute
      claims and check each one has a test.

## Settled — promoted into the loop (log)

Newest first. Each entry is kept whole: the reasoning that produced a rule is the durable part, and a
summary of it would not survive contact with the next person asking "why is this rule here?"

- **2026-10-07 — a merged file was reverted by the NEXT update** (data loss, found live 2026-10-02). `update.js`
  classifies a file as "untouched since install" by comparing the local file's sha256 to the manifest's.
  After a 3-way **merge**, it refreshes the manifest sha to the *merged* (locally-adapted) content — so on
  the next run that adapted file matches its manifest sha, is read as untouched, and gets **fast-forwarded
  to upstream, discarding the adaptation.** Two updates in a row is all it takes.
  Observed: BlitzWork was updated twice (`bc41f9c → 54723bc`, then `→ 54bd698`). The first run reported
  `merged: 8` and preserved everything. The second reported `updated: 9` and reverted six adapted bundle
  files plus `docs/plans/ROADMAP.md` and `docs/plans/PRODUCTION-BACKLOG.md` — the latter two being that
  project's real plans, replaced by the generic templates, 328 lines deleted. Recovered from the project's
  own git HEAD; **a project not under git would have lost them outright.** Zero conflicts were reported
  both times, so nothing in the output hinted at it.
  The fix has to distinguish "untouched since install" from "equal to what we last wrote", which are not
  the same claim once a merge has happened. Options: record the UPSTREAM sha the file derived from
  alongside the local sha (then untouched = local matches upstream-at-install), or record a `merged: true`
  flag per file so a merged file never takes the fast-forward path. **Prefer the first** — the second
  remembers a verdict where the first remembers a fact. Needs a regression test driving two consecutive
  updates over an adapted file; `test_update.js` currently covers one update per fixture, which is exactly
  why this survived.
  Fixed: manifest entries carry `upstreamSha256`, the upstream content the local file derived from, and
  that is what the fast-forward test compares against. A merge advances it to theirs while `sha256`
  follows the merged file, so the two differ exactly when a file is adapted. Manifests predating the
  field fall back to the base blob. `tests/test_update_twice.js` drives two consecutive updates plus
  the legacy-manifest path, and fails on the pre-fix script.

- **2026-10-02 — a detection corpus borrowed from another context is not evidence in yours** (surfaced by
  the user, not by a test: "it has been hitting non-destructive non-invasive calls and has been preventing
  continuous loops for a few weeks, and it's a yes-or-no only, no always"). The guard's own audit trail
  settled it in one pass — 6,441 events across two real projects, 259 asks, **all 259 from the `commands`
  feed and not one from the zone ladder.** Ten Sigma rules produced 250 of them: `nohup`, `grep` near
  `password`, `curl --data`, `bash -c` with `/tmp/`, `sysctl hw.`, `chmod /tmp/`. The ladder meanwhile
  allowed-and-logged 1,407 out-of-project touches without interrupting anyone, which is exactly its job.
  The framing that produced the bug was a plausible one: Sigma is a curated, respected, regularly-updated
  ruleset, so a match felt like strong evidence, and `feedDisposition`'s comment ranked it as the *most*
  precise feed — above gitleaks regexes — on the reasoning that "human judgment is exactly what's wanted."
  But Sigma `process_creation` rules are written for **EDR telemetry on a server**, where the signal lives in
  parent process, user, and session type. A `PreToolUse` hook can't see those fields, so they're dropped at
  compile time, and what's left is a bare command-shape match. `nohup` is anomalous in server telemetry and
  is how you background a dev server. **The corpus was never wrong; it was being asked a question its fields
  can't answer.** The rule: *judge a borrowed ruleset by the fields that survive YOUR context, not by the
  reputation of the corpus it came from.* A rule stripped of the context that gave it meaning is a
  coincidence detector.
  Three things landed. (1) `commands` asks in the guarded lane and monitors in the fast one — the fast lane's
  bargain is that gray is allowed-and-logged, and a heuristic feed that asks anyway breaks precisely that
  promise. (2) **Per-project mutes** (`feeds.js mute`), because the host gives a hook `ask` no "always allow"
  and so the same rule re-asks forever; one rule asked 115 times and was answered "yes" 115 times, which is
  not consent, it's attrition. A mute floors at `monitor`: still matched, still audited, tagged `muted:true`,
  and surfaced by `/report-goodbehavior` with what it absorbed — **a deliberate silence has to stay visible
  or the list gets set once and never revisited.** The menu is built from the project's own audit trail rather
  than the 121-rule corpus, loudest first, pre-ticking only what has actually interrupted that project; it
  can't show the commands, because the audit stores rule ids only, so the human judges the rule. (3) The feed
  section's header comment claimed "monitor-mode only — never affects the deny/ask/allow decision" while the
  code below asked on every hit. **Same trap as the fail-open bug below: a stated invariant is not a tested
  one.** Twice now the false claim was in a comment that read as reassurance — worth checking the remaining
  "never"/"only" comments in the hooks against their code rather than waiting for the third.

- **2026-09-14 — the guard failed OPEN on a load error; a blocklist must fail closed even when it is the
  broken thing** (surfaced twice while building the Windows lane, both times a `const` read before its own
  declaration). Only `main()` was wrapped in try/catch, so a throw at module scope crashed the process before
  the stdin handler was registered: no stdout, no audit, and the command ran. I watched 68 of 75 deny cases
  silently pass while the hook was crashing, and confirmed it by injecting the bug into the shipped file —
  the pre-fix hook emitted nothing and exited 1 on `rm -rf /`. The file's own header had promised the
  opposite ("any error anywhere in the decision path denies the command"), which is how it went unnoticed:
  **a stated invariant is not a tested one.**
  Two layers landed. (1) A `process.on("uncaughtException")` handler registered as the first statement after
  the requires, self-contained so it stays correct when the code below it never finished loading — verified
  that Node routes a module-scope throw, TDZ included, to such a handler. (2) Every derived constant
  (`homeCanon()`, `protectedRoots()`, `scratchDirs()`) is now a memoized accessor rather than module-scope
  work, so the realistic faults happen inside `main()`'s try/catch and deny with a properly attributed audit
  line instead of the backstop's anonymous one. The regression test runs a command that would otherwise be
  ALLOWED, so the deny can only come from the load failure.

- **2026-09-14 — Windows: the guard was subscribed to the wrong surface** (found by probing after the
  protected-path fix below). The first framing was wrong in an instructive way: "the guard doesn't know
  `del`/`rmdir`/`Remove-Item`" treated this as missing verbs in the Bash lane. Checking the Claude Code docs
  instead of reasoning from the code showed the real shape — **on native Windows `PowerShell` is a separate
  tool with its own `tool_name`, and it is the PRIMARY shell there.** `guard-bash.js` exits on
  `tool_name !== "Bash"`, so the main command surface on Windows never reached the hook at all. No amount of
  verb-list work in the Bash lane would have touched it. The rule: **when a guard looks blind to a class of
  input, check what it is subscribed to before enriching what it parses.**
  What landed: (1) the hook subscribes to `Bash|PowerShell` (`settings.json`, `scripts/install.js`,
  `templates/managed-settings.json`) and audits the tool that actually ran instead of a hardcoded `"Bash"`;
  (2) a PowerShell dialect — `Remove-Item`/`rd`/`del` with `-Recurse -Force` or cmd's `/s`, `Start-Process
  -Verb RunAs` as the sudo counterpart, `irm|iex` as the curl-pipe counterpart, `Net.Sockets.TCPClient` as
  the reverse shell, volume format — sharing the POSIX lane's protected roots, zone ladder, audit and feeds;
  (3) `toCanonicalPath()`, so a drive-letter path, its forward-slash variant and the Git Bash `/c/...` form
  are one string, and `%USERPROFILE%`/`$env:USERPROFILE` join `~`/`$HOME` as spellings of one directory;
  (4) cmd switches (`/f`, `/s`, `/q`) are no longer read as absolute POSIX paths — that bug made the guard
  ask about `/f` while the command's real target went unexamined, which reads as coverage and is worse than
  silence. 28 regression tests; all fail against the pre-Windows hook.

- **2026-09-14 — protected paths are resolved, not pattern-matched** (found by an adopter probing the guard:
  `rm -rf ~` denied, the same directory spelled out did not). `isDangerousPath()` compared the raw token
  against a literal set (`/`, `~`, `$HOME`, `${HOME}`, `/*`) plus `SYSTEM_PREFIXES`. Every spelling the list
  didn't anticipate fell through to the zone ladder: guarded asked, the fast lane allowed-and-audited. The
  rule this produced: **a guard that compares spellings is bypassed by respelling. Resolve to the thing, then
  compare.** `isDangerousPath()` now runs the token through the existing `resolveTarget()` (tilde, `$HOME`,
  statement cwd, trailing `/*` glob) and tests the result against `PROTECTED_ROOTS`, a set DERIVED from
  `os.homedir()` — so the home directory and the directory homes live in are protected on every platform
  without naming either. Four gaps closed with it: the expanded home path on macOS and Linux; the home's
  parent; `~/*` and its expanded twin; and `cd <protected> && rm -rf .`, which needed `detectShape()` to
  become cwd-aware. Making it cwd-aware meant moving it off `splitStatements` onto `segmentsWithCwd`, which
  also splits `( … )` — so `(sudo …)` and `(curl url) | sh`, both previously invisible behind the paren, are
  now seen. `SYSTEM_PREFIXES` was a macOS-shaped list; it is now the union across macOS and Linux, which
  required exempting the `/dev` character devices so `2>/dev/null` doesn't report a system-zone write.

### Promotions distilled from real adoptions

- **2026-07-08 — generalize beyond dev + shrink the trust surface** (from three non-dev adoption attempts — a
  presentation, a research project, data processing — where adopt balked with "not meant for this"). (1) **Profiles**:
  the discipline is invariant; only *the-real-thing / verify / evidence* change by project type (truth source). Four
  composable cores (development · analysis · research · creative) + custom fallback; adopt now **elicits intent before
  surveying files** and must never decline a project. (2) **Behavioral done-gate**: verification vocabulary is honored
  only if something was actually run/observed after the last file change that turn — proof-words alone no longer pass.
  (3) **Deterministic mechanics**: install/update mechanics moved to `scripts/`; skills keep the judgment. (4)
  **Self-test**: `tests/run_all.js` — the bundle held to its own standard (hook behavior, install round-trip, update
  merge paths, drift lint).
- **2026-06-28 — four promotions distilled from an adopter survey** (a real project running the bundle; identity stripped,
  generic form only). (1) **Standing-proceed** — an earned escalation of trust: once the user has seen the gates hold,
  the loop may run a plan unattended, pausing only for a genuine design decision / real failure / irreversible step; it
  removes the pause *between* items, never a guardrail. Baked into `CLAUDE.md` (new "Standing-proceed" section + "Don't
  sidetrack") and `gate-build-`. (2) **Verified-vs-unverified labeling** — tag claims/findings `✔` firsthand vs `⚠`
  relayed; never let a `⚠` drive a build; re-read load-bearing state. Baked into `CLAUDE.md` "Honesty under pressure" +
  `audit-`/`gate-build-`. (3) **Adversarial, multi-lens audit** — run independent lenses (security / coverage-vs-journeys
  / completeness-wiring / flow-UX / coherence) and surface contradictions; into `audit-`. (4) **UAT plan** — a living
  manual user-test map (feature set → how to test → pass/fail close-out); new `/uatplan-goodbehavior` skill +
  `templates/UAT-PLAN.md`, wired into `verify-`/`gate-build-`/`audit-`.
- **2026-06-23 — adopt: separate run-locally from deploy-trigger and verify-target.** Surfaced while adopting a real
  push-to-deploy project (a managed host watching a branch + a managed backend): adopt had recorded the *local* run
  commands as "the dev approach" and missed that deploy was push-to-branch (host + CI auto-deploy) and that **verify runs
  against the deployed URL, not localhost** — and that a build-only pipeline catches no logic bugs. Baked generically into
  `/adopt-goodbehavior` Phase 1 (probe deploy/hosting config; analyze three facets) + Phase 2 (confirm the three facets
  separately; flag push=deploy; capture the verify URL).

### Promotion path built (settled)
- [x] **Build the promotion path.** Extend `/learn-goodbehavior` (or add a step) to distinguish a *project fact* (stays
      in project memory) from a *general discipline* (gets a generic rewrite proposed into `CLAUDE.md`/a skill). Ask
      before editing principles; never auto-rewrite the persona.
- [x] Decide how a project-local principle improvement travels back to the source repo (PR? a "contribute-up" note in
      `/update`?), so good practice isn't trapped in one copy.

### Coverage gap: "report verified state, not intentions" (generic)

The bundle covers *basic* honesty (claim only what you can show; observe real behavior, not a green test; confirm you're
on the current build; don't carry an unverified item forward). The sharper sub-points below were **promoted 2026-06-28**
into `CLAUDE.md` "Honesty under pressure" + "Standing-proceed" and reinforced in `audit-`/`gate-build-`/`verify-` (see the
promotion log above):

- [x] **Relayed findings are claims, not facts.** A result from a sub-agent, an audit, a search, or a prior summary is
      *to-verify*, not established truth — don't act on it as fact until observed firsthand. *(→ Honesty under pressure +
      `audit-` ✔/⚠ tags.)*
- [x] **Re-read load-bearing facts; don't trust recollection.** State that drives a decision — file contents (especially
      after edits), versions, identifiers, environment/build state — must be re-read from source, not recalled. *Why:*
      long sessions and context compaction summarize away the raw observations; durable docs preserve **decisions, not
      current state**, so current state is recovered by re-reading, not remembering. *(→ Honesty under pressure.)*
- [x] **Name the cost, so the discipline lands.** The expensive waste isn't a long session — it's the span between a
      hollow "done/verified" and the moment the gap surfaces, plus the rework to unwind everything built on it. *(→
      Honesty under pressure, stated as the rationale.)*
- [x] **Verified-vs-unverified labeling as the core move.** Explicitly mark unverified work as unverified; "wrote/changed
      it" is a different claim from "ran it and observed the result." *(→ Honesty under pressure + the `✔`/`⚠` convention
      across `audit-`/`gate-build-`.)*
- [x] **Length is not itself a reason to hesitate or checkpoint.** With recovery docs + re-verify discipline in place, a
      long run is fine — keep executing; don't stop-the-world or ask "should I continue?" as a reflex. *(→ "Standing-
      proceed" in `CLAUDE.md` + `gate-build-`.)*

### Install/update thread (settled 2026-06-23; the round-trip items closed later, dates inline)

- [x] **Initial commit of the source repo.** Done — the repo has been committed since 2026-06 (this item had gone
      stale; superseding it explicitly per the method's own rule).
- [x] **Exercise the round-trip.** Proven hermetically by `tests/test_update.js` (fast-forward / clean merge /
      conflict-with-markers / upstream-removal, against a real second commit, via `scripts/update.js`). A live
      cross-project round-trip on a real adoptee is still worth one run — folded into the trial item below.
- [x] **Live update round-trip on a real adoptee** — done 2026-07-08 against a real June install (base `f87ca80` →
      `bf9e9d3`, across the profile-layer + scripts rewrite): all 8 tracked files reconciled (7 fast-forwards, 1
      unchanged, zero conflicts — the adoptee had no local adaptations, so the merge/conflict paths remain covered by
      `tests/test_update.js`), manifest advanced, upstream additions (uatplan skill + development profile) added via
      `install.js` with judgment (their existing QA catalog kept — no template imposed), `project-profile` memory
      written in the adoptee's own memory format.
- [x] **Adopt trial on a real NON-DEV project** — done 2026-07-08 on a real workshop/presentation project (identity
      stripped). The flow held: intent elicited BEFORE any file survey; the user's three answers resolved cleanly to
      the **creative** profile (no composition, no fallback needed); the survey corroborated (deck toolchain + a video
      render pipeline + an unrelated parked payload correctly excluded); install ran through `scripts/install.js`
      (7 skills, ONLY the creative profile, hook wired, zero warnings); judgment steps tailored the principles, seeded
      a real render/export gotcha from the project's own docs, and adapted the memory index — a live example of a
      locally-adapted tracked file for a future update to 3-way-merge. Mid-adoption, an upward-infection audit was
      requested and run: identity grep clean; two de-prescription fixes promoted (generic deploy example;
      defaults-not-prescriptions notes) + a machine-local-path lint guard.
