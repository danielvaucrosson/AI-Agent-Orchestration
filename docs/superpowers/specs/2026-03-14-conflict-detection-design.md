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
git diff --name-only $(git merge-base origin/main <branch>)...<branch>
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

For `critical` detection: run `git diff --unified=0` on each shared file against the merge base to extract touched line ranges, then check for range overlap.

### Step 5 — Post warnings to Linear

- Extract Linear issue IDs from branch names (reuse `extractIssueId` from `linear-helpers.mjs`)
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

## Output format

Human-readable (default):

```
Conflict Detection Report
─────────────────────────
Pushed branch: feature/DVA-16-conflict-detection
Active branches: 3 (2 after staleness filter)

⚠ WARNING — feature/DVA-17-rollback-orchestration (DVA-17)
  Shared files:
    scripts/linear.mjs
    .github/workflows/linear-sync.yml

🔴 CRITICAL — feature/DVA-18-task-decomposition (DVA-18)
  Shared files (line overlap):
    scripts/task-ordering.mjs (lines 42-67 vs 50-80)

Summary: 1 warning, 1 critical
```

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
2. `git fetch --all` (all remote branches)
3. `npm ci`
4. `node scripts/conflict-detect.mjs scan --json` — capture for action summary
5. `node scripts/conflict-detect.mjs warn` — post to Linear
6. Write results to `$GITHUB_STEP_SUMMARY`

### Environment

- `LINEAR_API_KEY` from repository secrets
- `CONFLICT_DETECT_ENABLED` repository variable (default: `true`) — set to `false` to skip

### Non-blocking

Action always exits 0. Conflicts are informational warnings, not gates.

## Deduplication

Each warning gets a content hash based on `sorted(overlapping files) + both branch names`. Hash embedded in the Linear comment as `` `conflict-hash: abc123` ``.

Before posting, fetch recent comments on the issue and skip if a comment with the same hash already exists. If the overlap changes (files added or removed), the hash changes and a new warning is posted.

## Edge cases

| Scenario | Behavior |
|----------|----------|
| Branch deleted between detection and posting | Skip gracefully, log to action summary |
| No Linear issue ID in branch name | Skip Linear posting for that branch, still include in scan output |
| Pushed branch is `claude/*` | Not triggered (action only fires on `feature/**` and `fix/**`) |
| Same file, unrelated lines | `warning` severity — file still needs coordination |
| Merge base can't be determined | Fall back to `origin/main` HEAD |

## Dependencies

- `@linear/sdk` (already in `package.json`)
- `linear-helpers.mjs` for `extractIssueId`
- Git CLI (available in GitHub Actions runners)

## Testing strategy

Unit tests mock git commands and Linear API calls, following the patterns in `tests/scan.test.mjs` and `tests/auto-triage.test.mjs`:

- Branch discovery with staleness filtering
- File overlap detection and severity classification
- Line range overlap calculation
- Deduplication hash generation and comment skipping
- Edge cases: no active branches, no overlaps, missing issue IDs, stale branches
