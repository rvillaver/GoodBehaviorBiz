# GoodBehaviorBiz

> **GoodBehaviorBiz** evolves the Claude-native GoodBehavior: the same disciplined method, plus a **guard layer** so
> your Claude can build at full speed — including on `bypassPermissions` — while a small set of hard-dangerous
> command shapes still gets blocked outright, anything reaching outside the project gets asked about (or, in the
> fast lane, allowed and logged), and content carrying a named prompt-injection shape gets flagged rather than
> followed. Claude-native, zero dependencies, plain Node (Python-free) — see [The guard layer](#the-guard-layer)
> below for what it actually covers and the honest limits of a blocklist.

A portable Claude Code bundle that installs a **disciplined working method** into any project: audit before building,
a gated build loop, verify the real thing (not a proxy), record learnings so they don't decay, and report honestly —
with a hook that pushes back on self-declared "done."

It's not project knowledge. It's a *way of working*, distilled from a real build where the recurring failure was
**false claims and lazy output** — passing a test or showing a screenshot and calling a half-built feature "done."

**Not dev-only.** The discipline is invariant across development, analysis, research, and creative work — only what
"the real thing / verify / evidence" mean changes, and a lightweight **profile** captures that per project (composable
per-slot, with a custom fallback so it never declines a project). Adoption *asks what the project is* before sniffing
its files.

> **New here? Read the [TUTORIAL](TUTORIAL.md)** — install into a project (new or existing), turn intent into a plan +
> checklists, then build it down under the gated loop. It also shows exactly what does (and doesn't) land in your project.

## What's in it

| Piece | What it does | Type |
|---|---|---|
| `CLAUDE.md` | The operating principles (the persona). The definition of done, the loop, no-sidetrack, honesty. | guidance |
| `/adopt-goodbehavior` | **Entry point.** Elicits project intent, resolves a **profile** (dev/analysis/research/creative, composable), analyzes the workflow, proposes tailored amendments (CLAUDE.md + skills + hook + plan/memory) with options, asks, then applies — integrating with existing docs (e.g. HANDOFF.md), not overwriting. | skill |
| `templates/profiles/` | The **profile** layer: what "the real thing / verify / evidence" mean per project type. Index + four core bodies, loaded on demand; only the resolved one installs into a project. | guidance |
| `/audit-goodbehavior` | Reference-cross-checked, grouped, gated gap register. | skill |
| `/roadmap-goodbehavior` | Rolls gaps into a phased, gated plan + backlog. | skill |
| `/gate-build-goodbehavior` | Executes one phase: build → verify live → record learnings → gate. | skill |
| `/verify-goodbehavior` | Exercises the real thing the way its consumer would (per the profile) + captures evidence. Self-contained. | skill |
| `/uatplan-goodbehavior` | Builds/maintains a living manual UAT plan — feature map + how to test each + pass/fail checklist. Feeds verify. | skill |
| `/learn-goodbehavior` | Writes a durable learning to memory (so it's not relearned). | skill |
| `/update-goodbehavior` | Pulls the latest bundle from its source repo and 3-way-merges it into the local copy, preserving project-local adaptations. | skill |
| `/report-goodbehavior` | Turns the guard's audit trail into an owner-readable digest — what ran, what got blocked or flagged and why, over a period. | skill |
| `/feeds-goodbehavior` + `scripts/feeds.js` | Opt-in threat feeds (Sigma command shapes, gitleaks secrets, URLhaus malicious URLs) — fetched only when asked, monitor-mode only (audited, never blocking). | skill |
| `/write-goodbehavior` + `scripts/write/` | Edits a document so every word is load-bearing: rules keep their emphasis, rationale goes plain. Gated by a rule fingerprint that flags any obligation the rewrite may have dropped. | skill |
| `.claude/hooks/done-gate.js` + `.claude/settings.json` | Stop hook: pushes back on "done" without evidence — including *behaviorally*: verification vocabulary is honored only if something was actually run/observed after the last file change that turn. | enforcement |
| `.claude/hooks/guard-bash.js` | `PreToolUse`/`Bash` hook: denies a small set of hard-dangerous shapes outright (sudo/doas, download-piped-to-shell, reverse shell, recursive delete of root, home, or system); past that, a zone ladder decides per command target — silent in-project, asked (guarded lane) or allowed-and-audited (fast lane) everywhere else. | enforcement |
| `.claude/hooks/guard-injection.js` | `UserPromptSubmit` + `PostToolUse`(`Read`\|`WebFetch`) hook: flags content matching a named prompt-injection shape — never blocks, never drops a prompt. | enforcement |
| `scripts/install.js` · `scripts/update.js` · `scripts/report.js` | The mechanical halves of adopt/update/report, deterministic: copy+hash+wire+manifest, the git 3-way merge, and audit JSONL aggregation. The skills keep the judgment; the scripts keep the consistency. | tooling |
| `templates/managed-settings.json` + `templates/OWNER-SETUP.md` | Machine-wide, owner-enforced deployment: hooks a project can't shed, bypass mode locked off. Not installed by `/adopt-goodbehavior` — a separate, admin-driven setup. | enforcement |
| `tests/run_all.js` | The bundle held to its own standard: hook/guard/injection/report behavior, install round-trip, update merge paths, structural+drift lint — one command, all green before shipping. | self-test |

Guidance shapes intent; **only the hook enforces** when intent slips. That's the point — the method failed before
precisely because nothing stopped a lazy turn.

## Install into a project

The bundle is installed **as a project-local copy — never a symlink, never a global `~/.claude/` install.** Each project
owns its copy so it can adapt the principles/skills to its own stack without affecting other projects or your global
config. Updates come later from the source repo via a tracked 3-way merge (see below), not from a shared live source.

`/adopt-goodbehavior` is the **intelligent installer** — it lands the whole bundle itself; there's no blind copy step.
Open a session **in this GoodBehavior repo** (so the skills are loaded) and point adopt at the target:

```
/adopt-goodbehavior /path/to/your-project
```

It then **resolves** source (this bundle) and target (your project), **analyzes** the target's real workflow,
**proposes** tailored amendments (where principles live, the confirmed dev approach, planning/memory) **with options**,
**asks** before writing anything, and only then installs idempotently into the target's `.claude/` — copying the skills,
hook, and templates from the source, merging into existing docs/conventions rather than forking them, and recording
exactly what it installed in a manifest — the mechanical steps run through `scripts/install.js`, so every install is
identical. (`/adopt-goodbehavior` itself is **not** copied into targets — it's a run-once installer; targets carry the
working skills plus `/update-goodbehavior`.) After install, run the other `*-goodbehavior` commands from a session
opened **in the target project**.

## Stay current — `/update-goodbehavior`

Because the install is a copy (not a symlink), it won't drift as you improve the source. To pull improvements in without
losing the local adaptations a project has made, run **`/update-goodbehavior`**. It reads the manifest (which records the
source repo and the exact commit the copy derived from), fetches upstream, and for every tracked file does a **git
3-way merge** — base = the manifest commit, *ours* = the local file, *theirs* = the new upstream version:

- file untouched locally → fast-forwarded to upstream;
- file adapted locally → changes merged;
- genuine conflict → conflict markers written for you to resolve.

It then rewrites the manifest to the new commit. Self-updating, but human-in-the-loop on conflicts — the same principle
as the done-gate. (Requires the source to be a committed git repo so the merge base exists.)

## The guard layer

Three hooks, wired by `/adopt-goodbehavior` (independently — take any subset):

- **`guard-bash.js`** (`PreToolUse`/`Bash`) — a small set of hard shapes (sudo/doas, download-piped-to-shell,
  reverse shell, recursive delete of root, home, or system paths) are denied outright, in every lane, no exceptions.
  Past that, a **zone ladder** looks at what the command actually touches: silent inside the project; anything
  reaching outside it (home, a sibling project, a system path) is **gray** — the guarded lane asks, the fast
  lane allows it and writes an audit line either way.
- **`guard-injection.js`** (`UserPromptSubmit` + `PostToolUse` on `Read`/`WebFetch`) — content matching a named
  prompt-injection shape gets flagged back to the model as data to distrust, never blocked. Your prompt is never
  dropped; a fetched or read file's embedded instructions are never followed silently.
- **Every decision, one audit trail** — `.claude/goodbehavior/audit/YYYY-MM-DD.jsonl`, one line per event, named
  shape only (never the raw matched content). `/report-goodbehavior` turns it into a plain-language digest.

**Guarded vs fast lane.** `/adopt-goodbehavior` asks: *guarded* keeps Claude Code's own permission prompts on,
the guard as an extra net; *fast* runs on `bypassPermissions` — the guard is the *only* net. Say that plainly to
yourself before picking fast: **it's a blocklist, not a sandbox.** A command that matches no named shape and
touches no zone outside the project runs, in either lane — enforced means "the hooks can't be turned off,"
never "nothing risky can get through." For a machine-wide, owner-locked deployment an individual project or
session can't shed, see `templates/OWNER-SETUP.md`.

**Threat feeds (optional, `/feeds-goodbehavior`).** Beyond the hardcoded shapes, the guard can check commands
and fetched URLs against three external, regularly-updated feeds — SigmaHQ command-shape rules, gitleaks
credential patterns, URLhaus malicious URLs. **Opt-in and monitor-mode only**: nothing is fetched until you run
`node scripts/feeds.js opt-in`, and a match is always audited, never blocking — same honesty rule as the rest of
the guard, stated plainly at opt-in time, not buried in a flag.

## The honest caveat

A persona + skills can encode the rules, but the engine that made this work was a human catching slips and a habit of
writing down every lesson. The hook adds teeth, but it's a heuristic nudge, not a lie detector. Keep
**user-confirmation as the done-gate** — the method is human-in-the-loop by design, not an autopilot for honesty.

## Chat or a non-agentic assistant?

The bundle above is agentic — skills, a hook, a filesystem to verify against. To get the same posture in plain Claude.ai
chat (or another assistant like Copilot), [`chat-agents/`](chat-agents/) carries the discipline as prompt alone
(understanding gate, ✔/⚠ evidence tagging, no self-declared "done," a running ledger). Two ways to deploy it:
[`goodbehavior.md`](chat-agents/goodbehavior.md) as standing instructions (invoke with "follow the GoodBehavior
approach"); or — for assistants that **ignore** custom instructions — attach that file **and** drive each task with
[`PROMPT-TEMPLATE.md`](chat-agents/PROMPT-TEMPLATE.md), which re-states the rules inline where they can't be dropped.
Companion only — nothing installs it.

## License

[MIT](LICENSE) © 2026 Ronald Villaver.
