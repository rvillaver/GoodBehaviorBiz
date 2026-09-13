---
name: gate-build-goodbehavior
description: Execute one roadmap phase under the gated loop — build, verify live, record learnings, prove it before the next item. Use to work through a roadmap without drifting or self-declaring done.
---

**Loop position:** step 4 — after `/roadmap-goodbehavior`; per item it calls `/verify-goodbehavior` and
`/learn-goodbehavior`. Done and standing-proceed are defined in the active profile (in your instructions).

Work the **current (NOW) phase** of the initiative's plan (`docs/plans/<INITIATIVE>.md`, listed in `ROADMAP.md`), one
item at a time, to the real definition of done.

## Per item
1. **Build** the smallest change that actually closes the gap (reuse before hand-rolling).
2. **Produce/run** it the project's real way (note the build/deploy traps recorded in project memory,
   `.claude/goodbehavior/memory/MEMORY.md`).
3. **Verify live** — run `/verify-goodbehavior`: exercise the real thing the way its consumer would, per the project's
   **profile** (software driven like a user through UI + backend; a dataset validated on real input; claims re-checked
   against sources; a delivered artifact walked + fact-checked), and capture that profile's evidence. **A passing test
   alone is not verify.**
4. **Record learnings** — any non-obvious trap, correction, or build/deploy fact → `/learn-goodbehavior`.
5. **Status** — mark the item done **only with evidence**; otherwise "partial/blocked" + log the blocker to the backlog.

## Gate before the next phase
Loop-review the phase until **every item has concrete evidence** (or is explicitly deferred to the backlog). Record
phase-level learnings. Only then advance. **Don't carry an unverified item forward silently.** Tag each item `✔`
(firsthand live evidence) or `⚠` (relayed/assumed, **not** done); **a phase never advances on a `⚠` item.**

**Then close the phase out of the plan**, per `/roadmap-goodbehavior`'s "Close a phase": the phase's items and
evidence move to `docs/plans/archive/`, one digest line stays behind. **Closing a phase is part of finishing it, in
the same change.** Otherwise the plan grows a full copy of every phase you ever completed, and the document the next
session opens first becomes the least current thing in the project.

## Standing-proceed (when granted)
If the user has granted **standing-proceed** for this plan, run the phases end to end **without per-item check-ins.**
The per-item loop above is unchanged (build → verify live → record → gate); you have been trusted to run it unattended
against the agreed plan. Keep going. **"Should I continue?" is not a checkpoint, and length is not a reason to stop.**

**Pause to ask only for:** a genuine design decision the plan doesn't settle, a real failure you can't resolve, or a
destructive/irreversible step (a push that deploys, a migration, anything you can't take back). When you pause, say
which of the three it is. Standing-proceed removes the pause between items, never a guardrail. **A faked or skipped
verify is the one thing it must never buy.**

## Discipline
- **Don't sidetrack.** Hit something off-track? Log it to `PRODUCTION-BACKLOG.md` and keep the throughline.
- **Don't fake or over-claim.** If you can't show it working, it isn't done. Say so, and surface real failure output.
- **Don't over-build.** If an item is large and invisible (a pure refactor with no behavior change), flag it and
  consider the backlog rather than grinding. Recommend, and let the user decide.
- **Right-size verification to the change, but never skip the live check on anything user-facing.**
