---
name: project-gbbiz
description: What GoodBehaviorBiz is, its stack, and the confirmed build/verify approach
metadata: { type: project }
---
**What:** GoodBehaviorBiz is a new bundle at `/Users/rv/work/GoodBehaviorBiz`, created (2026-08-28) as a full-copy
evolution of the **Claude-native** GoodBehavior (`/Users/rv/work/GoodBehavior`, `.claude/` + `CLAUDE.md`). It is the
Claude twin of GoodBehavior-CMDBiz (which evolved the `.commandcode/` variant). Goal: route **every command surface**
through BlitzPi-style guardrails so no surface executes unguarded, each block written to an audit trail.
See [[reference-blitzpi-guardrails]].

**Command surfaces to guard:** skill invocations (`.claude/skills/*`), the Stop/done-gate hook
(`.claude/hooks/done-gate.js`), the bundle scripts (`scripts/install.js`, `scripts/update.js`), and chat-agents.

**Stack (user-confirmed 2026-08-28):** **Python-free / single-runtime = plain JavaScript on Node** (no TS build step).
The whole toolchain was ported off Python at creation (done-gate/install/update/tests → `.js`), matching CMDBiz and
BlitzPi's Node runtime. Upstream = `/Users/rv/work/GoodBehavior` @ `a152e81` (manifest-tracked; `/update` 3-way-merges
the 6 language-agnostic template/profile files, so the node divergence won't fight upstream).

**Confirmed approach:**
- verify target = **localhost** (run the real agent/hook/skills; no deployed URL; no push=deploy risk).
- verify method = disallowed action on each surface → block + audit entry ([[project-profile]]).
- Prefer **adapting to the existing `.claude/` mechanisms** over porting BlitzPi wholesale.
