# Owner setup — machine-wide, enforced guard

For an organization that wants the guard hooks to apply to **every project on a machine, always** — not
something an individual project or session can opt out of. This is a different deployment from
`/adopt-goodbehavior`: that installs a project-local copy an employee can adapt or remove; this installs a
machine-wide policy an employee cannot.

**Requires admin/root access on each machine** (or your MDM/fleet-config tooling to deploy the same two files at
scale). Five minutes per machine, or one policy push across a fleet.

## What "enforced" actually means here

Two settings, both only honorable from Claude Code's own admin-controlled managed settings — never from a
project or user settings.json, by design:

- **`allowManagedHooksOnly: true`** — once set, the *only* hooks that run are the ones in this managed file.
  A project's own `.claude/settings.json` — including one that tries `"disableAllHooks": true` to shed the
  guard — is ignored entirely for hook purposes.
- **`permissions.disableBypassPermissionsMode: "disable"`** — bypass mode (`--dangerously-skip-permissions`)
  can never be engaged on this machine, by anyone, regardless of what a session requests. This is the "lane
  lock": with this set, every session on the machine runs in the guarded lane, permanently.

## Steps

1. **Deploy the hook files to a fixed location** — one copy per machine, independent of any project:
   ```sh
   sudo mkdir -p /usr/local/share/goodbehavior/hooks
   sudo cp .claude/hooks/guard-bash.js .claude/hooks/guard-injection.js /usr/local/share/goodbehavior/hooks/
   ```
   (Adjust the path if your organization has a different convention — just keep it consistent with the
   `command` paths in the next step.) This is why a fixed location matters: the hooks then protect every
   project on the machine, including ones that never ran `/adopt-goodbehavior` at all.

2. **Install the managed settings file** — copy `templates/managed-settings.json` (strip the `_comment` and
   `_paths` keys, they're documentation only) to your platform's path:

   | Platform | Path |
   |---|---|
   | macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
   | Linux | `/etc/claude-code/managed-settings.json` |
   | Windows | `C:\Program Files\ClaudeCode\managed-settings.json` |

   ```sh
   sudo mkdir -p "/Library/Application Support/ClaudeCode"
   sudo cp templates/managed-settings.json "/Library/Application Support/ClaudeCode/managed-settings.json"
   ```

3. **Restart/reopen Claude Code sessions** on that machine — managed settings are read at session start.

## Verify it actually took

From any project on the machine (even one with no `.claude/` at all):

```sh
claude -p --dangerously-skip-permissions "Run exactly this using the Bash tool and then stop: sudo id"
```

Expect the `sudo id` call to be blocked (the hook denies it outright) even though `--dangerously-skip-permissions`
was passed — confirming both the hook can't be shed and bypass mode can't actually engage. Check the audit trail
at `.claude/goodbehavior/audit/<date>.jsonl` **inside whichever project you ran that in** — the guard still
resolves the project root from `$CLAUDE_PROJECT_DIR`/cwd exactly as it does under a normal project install, only
the hook *file* lives at the shared machine location.

## The honest caveat

This locks the guard *on* — it does not turn it into a sandbox. The guard is still a **blocklist**: a small set
of named hard shapes plus a zone ladder, not default-deny. `disableBypassPermissionsMode` guarantees Claude
Code's own permission prompts stay active (the first line of defense), and `allowManagedHooksOnly` guarantees
the guard hooks run on top of that — but a sufficiently unusual command that matches no named shape and touches
no zone outside the project will still run, same as it would anywhere else. Enforced means "cannot be turned
off," not "cannot be gotten around by something the guard doesn't know to look for."

## Uninstall

Remove the managed-settings.json file at the path above and restart sessions. The shared hook files at
`/usr/local/share/goodbehavior/hooks/` (or wherever you deployed them) can be removed too, or left in place —
inert with no managed-settings.json pointing at them.
