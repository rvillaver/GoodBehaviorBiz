---
name: build-deploy-gotchas
description: Project-specific traps (caching, drift, guardrail bypass, harness-convention mismatches…) — check BEFORE diagnosing
metadata: { type: reference }
---
Likely future candidates: unguarded command surfaces that bypass the interceptor, fail-open vs fail-closed on guardrail
errors, audit entries not written on the block path.

**Known (2026-08-28) — porting the toolchain from the CommandCode variant:** GoodBehaviorBiz's Node toolchain was seeded
from GoodBehavior-CMDBiz (the `.commandcode/` twin) and adapted. Two convention mismatches to watch when reusing that
code: (1) paths are `.claude/` here, not `.commandcode/` (and the hook wiring env var is `$CLAUDE_PROJECT_DIR`);
(2) the **principles home is `CLAUDE.md`**, not `AGENTS.md` — the drift-lint's INVARIANT_FILES must name `CLAUDE.md` or
`test_lint.js` throws ENOENT. **Why:** the two harnesses share logic but differ in these load-bearing names.

**Hybrid bundle+project self-test note:** GoodBehaviorBiz is both a distributable bundle and an adopted project, so its
`test_lint.js` infection guard excludes `.claude/goodbehavior/` (the in-tree manifest legitimately holds the absolute
source path `/update` needs), and `test_install.js` "manifest has sourceCommit" needs the repo to have ≥1 commit.
