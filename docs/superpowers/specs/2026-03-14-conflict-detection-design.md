# DVA-16: Conflict Detection Between Concurrent Agents

## Summary

Detect when multiple agents working on concurrent branches modify the same files. Post warnings to Linear so agents and humans can coordinate before merge conflicts become costly.

## Trigger

GitHub Action on push to `feature/**` and `fix/**` branches. Non-blocking — warns but never prevents a push.

## Architecture

Two new files plus tests:

| File | Purpose |
|------|---------|
| `scripts/conflict-detect.mjs` | Core logic: branch discovery, diff comparison, severity classification, Linear posting |
| `.github/workflows/conflict-detect.yml` | GitHub Action that runs the script on push |
| `tests/conflict-detect.test.mjs` | Unit tests |

No changes to existing files. Follows patterns established by `scan.mjs`, `auto-triage.mjs`, and `linear-sync.yml`.

## Algorithm

### Step 1 — Discover active branches

- List all remote `feature/*` and `fix/*` branches via `git branch -r`
- Exclude the pushed branch itself
- Exclude stale branches: last commit older than 7 days (via `git log -1 --format=%ci`)

### Step 2 — Compute changed files

For each branch (including the pushed one):

```
git diff --name-only $(git merge-base origin/main <branch>)..<branch>
```

Result: `Map<branch, Set<files>>`

### Step 3 — Find overlaps

Set intersection between the pushed branch's files and each other active branch's files. Skip branches with no overlap.

### Step 4 — Classify severity

| Severity | Condition |
|----------|-----------|
| `info` | Same top-level directory only (different files) |
| `warning` | Same file modified by both branches |
| `critical` | Same file, overlapping line ranges |

For `critical` detection: run `git diff --unified=0 <merge-base-sha> <branch> -- <file>` on each shared file to extract touched line ranges from hunk headers (`@@ -a,b +c,d @@`). Parse start line and count from each side (note: Git omits the count when it's 1, e.g., `+42` means a single line at 42). Check whether the line ranges from both branches overlap. The hunk header parser must be unit-tested independently.

### Step 5 — Post warnings to Linear

- Extract Linear issue IDs from branch names using the regex `/\b([A-Z]{1,5}-\d+)\b/` (same pattern as `.claude/hooks/linear-helpers.mjs`; duplicated inline to avoid cross-layer imports from hooks into scripts)
- Post a comment to both issues with: severity, overlapping files, branch names, and a coordination suggestion
- Deduplication via content hash (see below)

## CLI Interface

```bash
# Detect conflicts for current branch
node scripts/conflict-detect.mjs scan

# JSON output
node scripts/conflict-detect.mjs scan --json

# Post warnings to Linear (preview)
node scripts/conflict-detect.mjs warn --dry-run

# Post warnings to Linear
node scripts/conflict-detect.mjs warn
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | No conflicts, or info-level only |
| 1 | Warnings exist |
| 2 | Critical conflicts found |

Exit codes apply to the `scan` command. The `warn` command always exits 0 (it posts to Linear and logs failures but does not fail the process). The GitHub Action uses `scan` with `continue-on-error: true` so the `warn` step always runs.

## Output format

Human-readable (default):

```
Conflict Detection Report
─────────────────────────
Pushed branch: feature/DVA-16-conflict-detection
Active branches: 3 (2 after staleness filter)

ℹ INFO — feature/DVA-19-scheduled-runs (DVA-19)
  Same directory:
    scripts/

⚠ WARNING — feature/DVA-17-rollback-orchestration (DVA-17)
  Shared files:
    scripts/linear.mjs
    .github/workflows/linear-sync.yml

🔴 CRITICAL — feature/DVA-18-task-decomposition (DVA-18)
  Shared files (line overlap):
    scripts/task-ordering.mjs (lines 42-67 vs 50-80)

Summary: 1 info, 1 warning, 1 critical
```

Info-level conflicts are shown in output but do not affect exit codes.

JSON mode returns an array of conflict objects with `branch`, `issueId`, `severity`, `files`, and `lineRanges` fields.

## GitHub Action

```yaml
name: Conflict Detection
on:
  push:
    branches:
      - 'feature/**'
      - 'fix/**'
```

### Steps

1. Checkout with `fetch-depth: 0` (full history for merge-base)
2. `git fetch --all` (all remote branches — must run before step 4)
3. `npm ci`
4. `node scripts/conflict-detect.mjs scan --json` — capture for action summary (`continue-on-error: true`)
5. `node scripts/conflict-detect.mjs warn` — post to Linear
6. Write results to `$GITHUB_STEP_SUMMARY`

### Environment

- `LINEAR_API_KEY` from repository secrets
- Guarded by `vars.LINEAR_ENABLED != 'false'` (same pattern as `linear-sync.yml` and `pr-feedback.yml`)

### Non-blocking

Action always exits 0. Conflicts are informational warnings, not gates.

## Deduplication

Each warning gets a content hash based on `sorted(overlapping files) + both branch names`. Hash embedded in the Linear comment as `` `conflict-hash: abc123` ``.

Before posting to each issue, fetch that issue's recent comments and skip if a comment with the same hash already exists. Each issue is checked independently — if issue A already has the warning but issue B does not, only issue B gets a new comment. If the overlap changes (files added or removed), the hash changes and a new warning is posted.

## Edge cases

| Scenario | Behavior |
|----------|----------|
| Branch deleted between detection and posting | Skip gracefully, log to action summary |
| No Linear issue ID in branch name | Skip Linear posting for that branch, still include in scan output |
| Pushed branch is `claude/*` | Not triggered (action only fires on `feature/**` and `fix/**`) |
| Same file, unrelated lines | `warning` severity — file still needs coordination |
| Merge base can't be determined | Skip the branch with a warning logged to action summary (falling back to `origin/main` HEAD would produce false positives from main's own changes) |

## Dependencies

- `@linear/sdk` (already in `package.json`)
- Git CLI (available in GitHub Actions runners)
- Issue ID regex duplicated inline from `.claude/hooks/linear-helpers.mjs` (no cross-layer import)

## Testing strategy

Core logic is structured as pure functions that accept inputs and return results, following the pattern in `tests/auto-triage.test.mjs` (pure function testing) and `tests/scan.test.mjs` (temp file fixtures). Git and Linear interactions are injected via a `deps` parameter (e.g., `{ runGit, postComment }`) so tests can substitute fake implementations without a mocking library. The project uses `node:test` which has no built-in module mocking.

Test cases:

- Branch discovery with staleness filtering
- File overlap detection and severity classification
- Line range overlap calculation (including non-overlapping ranges)
- Hunk header parsing (`@@ -a,b +c,d @@`) including single-line hunks where count is omitted
- Deduplication hash generation and comment skipping
- Edge cases: no active branches, no overlaps, missing issue IDs, stale branches, unreachable merge base
