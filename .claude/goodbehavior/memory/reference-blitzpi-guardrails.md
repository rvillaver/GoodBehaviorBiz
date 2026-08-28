---
name: reference-blitzpi-guardrails
description: Where BlitzPi's guardrail concepts live — the source to port/adapt for GoodBehaviorBiz
metadata: { type: reference }
---
BlitzPi (`/Users/rv/work/blitz/BlitzPi`) implements guardrails as interceptors on the Pi harness hook system: an LLM
request or tool call passes a checkpoint before execution, and denial is enforced by **throwing** inside the hook
(aborts the call). Each decision is audited. ⚠ Most claims here are relayed — re-read files before building on them.

Load-bearing files:
- `src/index.ts` — registers the checkpoints (init sequence).
- `src/threat-detection.ts` — prompt-injection / PII / command-injection / path-traversal patterns (tiered).
- `src/access-profiles.ts` — YAML allow/deny rules per tool + path globs; blocks tool_call.
- `src/governance.ts` (+ `src/governance-providers/`) — external LLM-approval gate on before_provider_request.
- `src/sandbox.ts` — confines file I/O to a run dir; blocks path-traversal escape.
- `src/audit.ts` — appends every decision to `.blitz/audit/*.jsonl`.
- `docs/architecture/SECURITY_CHECKPOINTS.md` — the definitive checkpoint spec.

**✔ Verified (governance.ts) — governance is enforcement-by-throw on `before_provider_request` only (LLM calls), so it
does NOT cover non-LLM command surfaces; and it has two fail-OPEN paths (`config.governance.enabled=false`, or provider
init throws → no hook registered → ungoverned).** GoodBehaviorBiz must instead build a mandatory chokepoint every
surface crosses, fail **closed**, with "governance off" itself an audited decision.

Checkpoint order (first block stops the rest): threat-detection → access-profile → governance (LLM) → sandbox (file) →
execute. Map this onto GoodBehaviorBiz's command surfaces ([[project-gbbiz]]).
