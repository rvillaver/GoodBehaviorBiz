# Changelog

Every entry here is a unit a downstream project will 3-way-merge via `/update-goodbehavior` — write entries so an
adopter skimming before an update knows what's coming and why.

## 2026-09-11 — Guard layer: hard shapes, zones, injection flagging, unified audit, owner lock

Claude-native, no BlitzPi dependency — BlitzPi's checkpoint architecture (threat-detection, zones, permissions) was
design reference only; every shape/zone here is re-derived clean in plain Node.

- **`guard-bash.js`** (`PreToolUse`/`Bash`) — hard shapes denied outright in every lane: sudo/doas,
  download-piped-to-shell, reverse shell, recursive delete of root, home, or system. Past that, a zone ladder
  (project / project-adjacent / home / system) decides per command target: silent in-project; guarded lane asks
  anything outside it, fast lane allows-and-audits. Fails closed (malformed input, internal error → deny).
- **`guard-injection.js`** (`UserPromptSubmit` + `PostToolUse` on `Read`/`WebFetch`) — ten named prompt-injection
  shapes flagged back to the model, never blocked: a user's prompt is never dropped, fetched/read content is
  flagged as data to distrust. Fails open (nothing to fail closed into on a warn-only hook). Self-exempt from its
  own source/test files.
- **Unified audit** — every guard decision (deny/ask/allow/annotated) lands in
  `.claude/goodbehavior/audit/YYYY-MM-DD.jsonl`, one line, named shape only — raw matched content is never
  logged. `/report-goodbehavior` + `scripts/report.js` turn it into an owner-readable digest.
- **`/adopt-goodbehavior`** now asks hooks (each independent) and, if `guard-bash` is taken, a guarded-vs-fast
  lane — stating the blocklist-not-sandbox tradeoff plainly and recording the choice as a project convention
  (bypass mode can't be enabled from settings.json alone; it's always a session launch choice).
- **`scripts/install.js`** — `plan.hook` boolean → `plan.hooks` list; a hook can now wire under multiple
  settings.json events from one file (`guard-injection`'s two wirings share one script).
- **`templates/managed-settings.json` + `templates/OWNER-SETUP.md`** — a machine-wide, owner-enforced deployment
  path (`allowManagedHooksOnly` + `disableBypassPermissionsMode`) an individual project or session can't shed.
  Separate from `/adopt-goodbehavior`; admin-driven, one-page setup.

## 2026-08-28 — GoodBehaviorBiz: Claude-native fork, toolchain ported to plain Node

Created as a full-copy evolution of the Claude-native GoodBehavior, set up to route every command surface through
BlitzPi-style guardrails (the tracked build — see `docs/plans/ROADMAP.md`). The gates and mechanics are now
**Python-free / single-runtime (Node)**: `done-gate.py`→`done-gate.js` (Stop hook wired as `node …/done-gate.js`);
`scripts/install.py`/`update.py`→`.js`; `tests/*.py`→Node (`node tests/run_all.js`). Behavior preserved — all four
self-test suites pass (hook 14/14, install round-trip, update 3-way-merge, drift lint). No build step (plain JS, not TS).

## 2026-07-13 — chat-agents: attach-file + inline-prompt deployment

Some assistants (Copilot observed) **ignore custom instructions**, so standing instructions alone aren't enough. The
`chat-agents/` folder now supports the robust belt-and-suspenders pattern and is single-sourced:
- `chat-agents/goodbehavior.md`: **the** method (attach it, or paste it as instructions) — one source of truth.
- `chat-agents/PROMPT-TEMPLATE.md`: a blank, domain-neutral per-task scaffold that re-states the gate + ✔/⚠ evidence
  rules *inside the task prompt*, where a forgetful agent can't drop them.
- `chat-agents/EXAMPLE.md`: the template filled for one task — domain nouns isolated here so the base stays neutral.
- `chat-agents/README.md`: documents both deployment modes; replaces `PERSONALIZATION.md` (removed — its block became
  `goodbehavior.md`, its usage notes became the README). Top-level README pointer updated.

## 2026-07-12 — chat-only companion

- `chat-agents/PERSONALIZATION.md`: a standalone copy-paste block that carries the operating principles into plain
  Claude.ai chat (no skills, no hook, no filesystem). Audited/enhanced from a user template — adds the gate-vs-drive
  throughline, ✔/⚠ evidence tagging, a done-is-not-self-declared gate, and the unknown-vs-brainstorm distinction; keeps
  the understanding gate and running ledger. All examples are domain-neutral (stated as schema, not instance) so the
  base doesn't prime a frame or infect future variants. Companion only — not installed, not part of the core method.
  README pointer added.

## 2026-07-08 — generalize beyond dev; shrink the trust surface

**Profiles — the method is no longer dev-only.**
- `templates/profiles/`: four composable core profiles (development · analysis · research · creative), each defining
  *the-real-thing / verify / evidence* for its truth source; an INDEX for cheap on-demand loading; a custom-elicit
  fallback. Only the matched profile(s) install into a target — never all four.
- `/adopt-goodbehavior`: new intent-elicitation phase **before** the file survey (what is this project / what does done
  mean / who consumes it / how do you check it's right); the survey is corroboration, not the decider. Adopt must never
  say "GoodBehavior isn't meant for this project."
- Invariant layer reworded artifact-agnostic (CLAUDE.md definition of done, verify/gate-build/audit/roadmap/uatplan
  skills, hook message, templates): "exercised the way its **consumer** would," with the dev phrasing moved into the
  development profile.

**Enforcement — the done-gate is now behavioral, not just lexical.**
- `done-gate.py`: honest hedges always pass; verification vocabulary ("verified", "tests pass") is honored **only if
  something was actually run/observed after the last file change that turn**. "Edited files, ran nothing, said
  'verified'" now blocks. Doc-only turns exempt; bash-only turns pass; sub-agent results don't count as firsthand.

**Determinism — mechanics moved out of prompts into scripts.**
- `scripts/install.py`: adopt's mechanical half (copy, hash, wire the Stop hook without clobbering settings.json, write
  the manifest). Idempotent; never clobbers.
- `scripts/update.py`: update's mechanical half (manifest-driven git 3-way merge; fast-forward / merge / conflict /
  keep-upstream-removed; exit 2 on conflicts).
- The skills keep the judgment (profile resolution, proposals, conflict walkthroughs) and call the scripts.

**Self-test — the bundle held to its own standard.**
- `tests/run_all.py`: hook behavior (14 cases incl. the hollow-proof cheat), install round-trip + idempotency, update's
  four merge paths against a real second commit, structural + drift lint (profiles well-formed; invariant files must not
  re-acquire unscoped dev-coded phrasing). One command; green before shipping.

**Housekeeping.**
- `/adopt-goodbehavior` is no longer copied into targets (run-once installer; targets carry the working skills +
  `/update-goodbehavior`). Seeded memories point at the canonical principles instead of restating them. Stale TODO
  items superseded explicitly.

## 2026-06-28 — promotions from a real adopter

Standing-proceed; ✔/⚠ verified-vs-relayed tagging; adversarial multi-lens audit; `/uatplan-goodbehavior` + UAT template.

## 2026-06-23 — adopt learns deploy ≠ run-locally ≠ verify-target

Adopt analyzes and confirms the three dev-workflow facets separately; flags push-to-branch = deploy; captures the
verify URL.
