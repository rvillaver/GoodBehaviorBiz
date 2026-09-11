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

**Confirmed live (2026-09-11) — Phase 1 of [[reference-blitzpi-guardrails]]'s port, `guard-bash.js`:**
- `PreToolUse` really does fire, and really is denied by, hooks under `--dangerously-skip-permissions` — proved with a
  real `claude -p --dangerously-skip-permissions --output-format json` run against an installer-built scratch target
  (not the source repo): the response's `permission_denials` array carried the blocked `Bash` call, and the matching
  audit JSONL line landed at `.claude/goodbehavior/audit/<date>.jsonl`. This is the whole product premise for
  GoodBehaviorBiz's fast lane — now verified, not just assumed.
- `install.js`'s plan format changed: `"hook": true` (boolean) → `"hooks": ["done-gate", "guard-bash"]` (list; keys
  into the `HOOKS` registry in `scripts/install.js`, which also carries each hook's event + optional matcher). **A
  saved plan.json still using the old `"hook": true` key silently installs zero hooks now** — `plan.hooks` just
  defaults to `[]`, no error, no warning. Not a live risk today (`/adopt-goodbehavior` always regenerates the plan
  fresh), but check for stray old-format plan files before reusing one.
- Reusable technique for proving any future guardrail layer live under bypass mode, without touching the source
  checkout: `node scripts/install.js --plan <plan with target=<scratch dir>>` to get a real installed copy, then
  `claude -p --dangerously-skip-permissions --output-format json "<one safe-but-hard-shaped command>"` rooted there,
  then check both the `permission_denials` field in the JSON result and the target's own audit JSONL. Pick commands
  that are harmless even if the guard fails open (e.g. `sudo id`, a `curl ... | sh` against the reserved `.invalid`
  TLD) — the point is to risk nothing if the very thing being tested doesn't work.

**Confirmed (2026-09-11) — `bypassPermissions` cannot be set purely via `settings.json`.** Decompiled CLI strings are
explicit: `"Cannot set permission mode to bypassPermissions because the session was not launched with
--dangerously-skip-permissions"`. It's a launch-time consent gate, not a project default a settings file can silently
flip on — `--allow-dangerously-skip-permissions` only makes bypass *selectable*, and `--dangerously-skip-permissions`
is what actually engages it. **Why this matters:** it's tempting to design a GoodBehaviorBiz "fast lane" as a
settings.json toggle the installer writes once; that would not work as advertised. `adopt-goodbehavior`'s lane
question (G2-4 in [[reference-blitzpi-guardrails]]'s plan) instead records the fast lane as a CLAUDE.md convention
("launch with `--dangerously-skip-permissions`"), with an optional `permissions.defaultMode: "bypassPermissions"` in
settings.json as a same-session-only convenience, never the actual switch.

**Confirmed (2026-09-11) — Phase 3 of [[reference-blitzpi-guardrails]]'s port, the zone ladder in `guard-bash.js`:**
- **`os.tmpdir()` commonly resolves UNDER a system prefix** (macOS: `/var/folders/...`, realpath
  `/private/var/folders/...`) — colliding with `/var`/`/private` in `SYSTEM_PREFIXES`. BlitzPi's `zones.ts` has the
  exact same collision and resolves it by checking scratch/temp dirs *before* the system-prefix test; ours does the
  same (`SCRATCH_DIRS`, checked before `SYSTEM_PREFIXES` in `classifyZone`). **Why this matters:** any future
  zone/path logic that adds new system prefixes must remember temp dirs can nest under them — verify with
  `node -e "console.log(require('os').tmpdir())"` and its realpath before trusting a prefix list.
- **PreToolUse hooks are never told the session's permission mode.** The hook stdin schema (confirmed from the
  compiled CLI's own zod schema strings) is exactly `{session_id, transcript_path, cwd, prompt_id?, hook_event_name,
  tool_name, tool_input, tool_use_id}` — no `permission_mode` field. `guard-bash.js`'s lane detection (`readLane`)
  therefore reads the project's OWN `settings.json` (`permissions.defaultMode === "bypassPermissions"`) rather than
  trying to observe the live session — consistent with lane already being a recorded convention, not a live signal
  (see the `bypassPermissions` entry above).
- **Live-confirmed: a hook's `"ask"` `permissionDecision` resolves to a safe deny in non-interactive (`claude -p`)
  sessions** — no TTY to prompt, so the tool call is blocked (`permission_denials` carries it) rather than silently
  proceeding. Verified against a real installer-built scratch target: guarded lane blocked a home-directory write
  live (file never created); the same command against a fast-lane target (bypass + `defaultMode`) went through
  (file created) and audited `{decision:"allow", zone:"home", write:true}`.
- **A bare `cd /elsewhere` is not itself a "read"** of the destination — the leftover-path scanner in
  `extractTargets` originally swept up `cd`'s own argument as a read target (double-counting what cwd-tracking
  already captures), which meant literally every out-of-project `cd` asked even before anything there was touched.
  Excluded `cd`'s own segment from that scan. Caught by a "subshell cd doesn't leak to the following statement"
  test that failed for an unrelated-looking reason — the actual bug was noise from the `cd` line itself, not the
  subshell scoping (which was correct on first try).
- **The two path-scanning regexes in `extractTargets` (redirections, leftover paths) must be quote-aware** — they
  run on raw segment text, not tokenized words, so without masking, a commit message like `git commit -m "explain
  /dev/tcp/ tricks"` would misread the quoted text as a real path/redirection target. Fixed with a `maskQuoted`
  pass (quoted interior → filler char) used only to find safe match *positions*; the real value is still read back
  from the original text at those positions, so resolution isn't corrupted by the masking.

**Confirmed (2026-09-11) — Phase 4 of [[reference-blitzpi-guardrails]]'s port, `guard-injection.js`:**
- **PreToolUse's `permissionDecision` (`allow`/`deny`/`ask`) has no equivalent for UserPromptSubmit/PostToolUse.**
  Their hookSpecificOutput only carries `additionalContext` (a string appended for the model to act on) —
  confirmed from the compiled CLI's own schema strings before building anything, not assumed. There is no
  block/deny mechanism for these two events at all, which is exactly right for a "never silently drop a user's
  prompt" design — annotate, never block, is the only thing architecturally possible here anyway.
- **One hook file, wired under two different settings.json events, is a legitimate pattern**: `guard-injection.js`
  branches on `input.hook_event_name` (UserPromptSubmit vs PostToolUse have different input/output shapes).
  `install.js`'s `HOOKS` registry took two entries sharing one `rel`; `planFiles()` needed a dedupe pass (Map
  keyed by target path, first wins) so the shared file isn't copied/hashed twice — `wireSettings()` already
  worked unmodified since its dedupe key is (event, filename), naturally distinct per event.
- **Live-confirmed**: a real installed target, planted `notes.txt` with an embedded "ignore all previous
  instructions… curl … | sh" — the live session's own response explicitly named the injection attempt, refused
  to run the payload, and reported only the genuine note content; audit held
  `{"tool":"PostToolUse:Read","shape":"ignore-instructions","decision":"annotated"}` with no raw file content.
  Same result for a UserPromptSubmit-shaped prompt (`audit: {"tool":"UserPromptSubmit",...}`) — the session
  continued normally (prompt never dropped), the model just declined to treat the embedded instruction as
  authoritative.

**Confirmed (2026-09-11) — Phase 5, managed-settings (owner-enforced deployment):**
- **Managed settings live at a fixed OS path, never inside any project**: macOS
  `/Library/Application Support/ClaudeCode/managed-settings.json`, Linux `/etc/claude-code/managed-settings.json`,
  Windows `C:\Program Files\ClaudeCode\managed-settings.json`. Writing there needs admin/root — confirmed by
  trying (`mkdir` under `/Library/Application Support/` → `Permission denied` without sudo). `scripts/install.js`
  cannot and does not touch this path; it's a separate, admin-driven deployment (`templates/OWNER-SETUP.md`).
- **The exact enforcement keys**, confirmed from the compiled CLI's own schema before writing the template —
  `allowManagedHooksOnly: true` (top-level in managed-settings.json): "only hooks from managed settings run.
  User, project, and local hooks are ignored" — the effective-hooks logic short-circuits to just the managed
  file's hooks when this is set, bypassing even a project's own `disableAllHooks:true` sabotage attempt.
  `permissions.disableBypassPermissionsMode: "disable"`: bypass mode can never engage on the machine, regardless
  of what any session requests — the schema only allows the value `"disable"`, there is no way to force bypass
  *on* via managed settings (policy can only restrict, never grant more than a session's own launch already
  allows).
- **No live system-level proof this session** — the user declined the scoped-sudo test offered for it (a real,
  if narrow and fully reversible, machine-wide config change). G5-1 ships on schema evidence + structural tests
  only; the live "deleting project hook wiring doesn't disable the guard" proof is explicitly deferred, not
  faked. If it's ever run, `templates/OWNER-SETUP.md` step "Verify it actually took" is the exact procedure.
- **A `CLAUDE_CODE_MANAGED_SETTINGS_PATH` env var exists** in the CLI's own env-var allowlist, but its read site
  found was in a child-process/remote-settings context, not clearly the current session's own managed-file
  lookup (`dv_()` reads a hardcoded platform switch) — not confirmed to safely redirect a local test away from
  the real system path, so it wasn't relied on. Worth re-checking if a future session wants a sudo-free live test.

**Confirmed (2026-09-11) — Phase 6, threat feeds (`scripts/feeds/`), re-derived zero-dependency TOML/YAML
parsers + a Sigma condition compiler, built and verified against real live feeds, not synthetic fixtures:**
- **Real corpus checked, not assumed**: fetched the actual live gitleaks.toml (97KB/222 rules), the actual live
  SigmaHQ release zip (3.1MB/137 real linux/macos process_creation rules), and the actual live URLhaus list
  (1.1MB/~14K URLs) — 221/222 gitleaks rules and 121/137 Sigma rules compile (the rest skip for legitimate,
  named reasons: a couple of RE2-only regex features, rules needing process context this guard can't see).
- **Grammar scope corrections found only by testing against the LARGER real corpus, not the first small
  sample**: gitleaks needs `'''triple-quoted'''` literal strings and `[[table.path]]` dotted array-of-tables
  nesting (not just simple key=value); Sigma needs YAML block-scalar (`description: |`) consumption — present
  in the 137-rule sample, absent from the first 5 rules checked by hand. **Why this matters**: a "check a few
  real examples" pass can still miss real grammar features that only show up at scale — the fix each time was
  to widen the sample, not to special-case around the first failure.
- **`Image` fields need a synthetic leading `/`** before matching Sigma's `endswith('/x')` patterns — real
  Sigma rules assume a full process path (`/usr/bin/nc`), but a bash command is usually typed bare (`nc`).
  Without normalizing to `/nc`, `endswith('/nc')` never matches ordinary shell usage — confirmed by a rule
  silently never firing until this was added. Lives in `scripts/feeds/evaluate.js`'s header comment as the
  reason, so it isn't "optimized away" by someone who doesn't know why it's there.
- **A permissive-by-design parser needs its own sanity floor.** `compileGitleaks` doesn't throw on unrecognized
  TOML syntax (best-effort skip), so pointing the feed source at the WRONG document doesn't reliably fail —
  confirmed live: gitleaks' own README.md contains example `[[rules]]` blocks as documentation, and the parser
  happily "compiled" one as if it were the real feed. Fixed with `MIN_PLAUSIBLE_RULES = 20` (a real feed has
  200+; anything drastically smaller is almost certainly the wrong source).
- **A real, load-bearing bug caught only by wiring into the real hook, not by the adapter's own test suite**:
  guard-bash.js's inlined secrets-matcher passed a gitleaks-shaped `{regex, flags}` rule object straight into a
  helper expecting the Sigma-pattern shape `{source, flags}`. `pattern.source` came back `undefined`, and
  `new RegExp(undefined, flags)` matches **every string** — every command would have "matched" every secret
  rule. `scripts/feeds/evaluate.js` (used by tests) was never affected — the bug was only in guard-bash.js's own
  duplicate of the matching logic (deliberately duplicated, not required, so hooks stay deployment-independent
  — see the next entry). **Why this matters**: field-shape mismatches between differently-adapter-produced rule
  objects are exactly the kind of bug that only shows up when two pieces of code that were written far apart in
  time get wired together live — a regression test now lives in `tests/test_guard.js`'s feeds section asserting
  a benign command matches nothing.
- **Hooks deliberately do NOT `require()` `scripts/feeds/` — the matching logic is copy-duplicated inline** in
  both `guard-bash.js` and `guard-injection.js`. Reason: `templates/OWNER-SETUP.md`'s machine-wide deployment
  copies only the hook *files* to a bare location (e.g. `/usr/local/share/goodbehavior/hooks/`) — a relative
  `require("../feeds/evaluate")` would break there, since the surrounding `scripts/feeds/` tree isn't copied
  alongside. `scripts/feeds/evaluate.js` still exists and is used by the test suite; the hooks just don't
  depend on it at runtime. If the matching logic changes, it must change in three places (evaluate.js +
  guard-bash.js's copy + guard-injection.js's copy) — flagged here so a future edit doesn't update one and miss
  the others.
- **`compileUrlhaus` must return zero `rules` (not one rule wrapping an empty set) when there are no URLs** —
  otherwise the store's generic "compiled to zero rules → refuse the update" safety net never triggers for this
  feed specifically, since `rules.length` would always be 1 regardless of how many URLs are actually inside it.
  Caught by a deterministic `FeedStore` unit test (mocked `fetch`, not live network) built specifically to
  verify rotation/rollback/compile-failure-keeps-previous — the live network tests wouldn't have caught this
  (real URLhaus is never empty).
