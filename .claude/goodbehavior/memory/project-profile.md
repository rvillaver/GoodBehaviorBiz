---
name: project-profile
description: What "the real thing / verify / evidence" mean for GoodBehaviorBiz — read before verifying
metadata: { type: project }
---
Profile: **development** (pure). GoodBehaviorBiz evolves [[project-gbbiz]] (the Claude-native GoodBehavior) by routing
every command surface through BlitzPi-style guardrails ([[reference-blitzpi-guardrails]]).

- **the-real-thing:** the running GoodBehaviorBiz agent/harness with the guardrail layer active on every command surface
  (skill invocations, the Stop/done-gate hook, the install/update scripts, chat-agents) — on the current build, not a
  diff or a green test.
- **verify:** invoke each command surface with a *disallowed* action and drive it end to end; observe the guardrail
  block it before execution. A passing unit test is necessary, never sufficient.
- **evidence:** the captured block output **and** the matching audit-trail entry (JSONL) for that surface — per surface.
  "All surfaces managed" is only proven when every surface shows block + audit.

See `.claude/goodbehavior/profiles/development.md` for the full profile body. **Why:** "done" for this project is
"all command surfaces guarded," which is only concrete once these three slots are pinned.
