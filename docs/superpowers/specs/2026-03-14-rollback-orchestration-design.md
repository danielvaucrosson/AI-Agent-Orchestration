# DVA-17: Rollback Orchestration — Design Spec

## Summary

When a merged PR causes test failures on `main`, automatically create a revert PR, move the original Linear issue back to "In Progress", and notify stakeholders via Linear and GitHub.

## Decisions Made During Design

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Trigger mechanism | Workflow runs tests on `main` (option B) | No existing issue covers CI on main; keeps rollback self-contained |
| Flaky test detection | Retry-based, 3 attempts (option A) | Good balance of reliability vs. complexity; no persistent state needed |
| Multiple merges | Bisect to isolate culprit (option B) | Avoids false-positive reverts; O(log n) test runs |
| Notification | Linear comment + GitHub PR comment (option B) | PR author gets notified where they work; no extra issue overhead |
| Architecture | Thin workflow + orchestration script (approach 2) | Matches project pattern; script is testable locally and in CI |

## Architecture

### Approach

A thin GitHub Actions workflow (`.github/workflows/rollback.yml`) triggers on pushes to `main`, sets up the environment, and delegates all logic to a standalone Node.js script (`scripts/rollback.mjs`). This follows the project's established pattern where every feature has a `scripts/*.mjs` file with corresponding `tests/*.test.mjs` tests.

### File Structure

| File | Purpose |
|------|---------|
| `.github/workflows/rollback.yml` | Thin workflow — triggers on `main` push, sets up Node.js, calls the script |
| `scripts/rollback.mjs` | Main orchestration script — all rollback logic |
| `tests/rollback.test.mjs` | Unit tests for rollback logic |

## Workflow Configuration

### Permissions

The workflow requires these explicit permissions:

| Permission | Reason |
|-----------|--------|
| `contents: write` | Push revert branches |
| `pull-requests: write` | Create revert PRs, comment on original PRs |
| `actions: read` | Query prior workflow runs for `findLastGreenSha()` |

### Concurrency

The workflow uses a concurrency group (`rollback-main`) with `cancel-in-progress: true`. If two pushes to `main` happen in quick succession, only the latest run proceeds. This prevents duplicate revert PRs and Linear comments.

### Checkout

The workflow checkout step uses `fetch-depth: 0` to ensure full git history is available for bisection (`git log`, `git checkout <sha>`).

### Interaction with `linear-sync.yml`

The `linear-sync.yml` workflow excludes `main` from its push trigger (`branches-ignore: main`), so it will not fire on the original push. However, when the rollback script pushes a `revert/*` branch, `linear-sync.yml` will fire on that push. The revert branch name uses `revert/DVA-X-...` format, so `extract-issue-id.mjs` will extract the issue ID and `linear-sync.yml` will move that issue to "In Progress" — which is the same action the rollback script performs. This is harmless (idempotent state transition) but the rollback script should perform its Linear update *before* pushing the revert branch, so its comment with full failure context lands first.

## Overall Flow

```
Push to main
  -> rollback.yml runs
    -> Run tests (npm test)
    -> If tests pass -> exit cleanly
    -> If tests fail ->
        Retry tests 2 more times (flaky detection)
        -> If any retry passes -> log as flaky, exit without reverting
        -> If all 3 fail -> real failure detected
          -> Find merge commits since last green CI run
          -> If single merge -> that's the culprit
          -> If multiple merges -> bisect to isolate culprit
          -> Update Linear: move original issue to "In Progress", post failure details
          -> Create revert PR (title: "Revert DVA-X: [original title]")
          -> Post follow-up Linear comment with revert PR link
          -> Comment on the original merged PR with failure details + revert PR link
```

## Component Design

### 1. Flaky Test Detection

1. Run `npm test` — if it passes, exit immediately (happy path).
2. If it fails, run `npm test` two more times (3 total attempts).
3. Decision logic:
   - If any of the 3 runs pass: classify as flaky, log which tests were inconsistent, exit with **process.exit(0)**. This means `findLastGreenSha()` in future runs will treat this as a green baseline — which is acceptable because at least one test run passed at this commit, confirming the code is not deterministically broken.
   - If all 3 fail: classify as real failure, proceed to culprit identification.
4. Test output from each run is captured for inclusion in the Linear comment if a revert is needed.
5. Retry count (3) is a constant at the top of the script.

### 2. Culprit Identification (Bisection)

**Finding the search space:**
- Use the GitHub Actions API to find the last rollback workflow run on `main` that completed with exit code 0 (i.e., `conclusion: "success"`). This covers both "tests passed on first try" and "flaky detected, exited cleanly" — both indicate the code was not deterministically broken at that SHA.
- List all merge commits between that green SHA and the current HEAD.
- If no previous green run exists (first time), skip bisection and blame the most recent merge.

**Single merge:** If only one merge commit landed since last green, that's the culprit. No bisection needed.

**Multiple merges — bisect:**
1. Get the ordered list of merge commits: `[M1, M2, M3, ..., Mn]` (oldest to newest).
2. Check out the midpoint commit, run `npm test`.
3. If tests pass at midpoint: culprit is in the newer half.
4. If tests fail at midpoint: culprit is in the older half.
5. Repeat until isolated to a single merge commit.
6. This is O(log n) test runs — for 8 merges, at most 3 bisection steps.

**Extracting the issue ID:** Once the culprit merge commit is identified, extract the Linear issue ID from the merge commit message or PR title (reusing the pattern from `scripts/extract-issue-id.mjs`).

**Safety cap:** If bisection would require more than 5 iterations (33+ merges since last green), skip bisection, blame the most recent merge, and note in the Linear comment that bisection was skipped due to too many candidates.

**Bisection and `node_modules`:** During bisection, the script runs `npm install` before each `npm test` invocation at a checked-out commit, since dependencies may differ across commits. After bisection completes, the script checks out the original HEAD and runs `npm install` again to restore the working state before creating the revert PR.

### 3. Revert PR Creation

- Create a revert branch: `revert/DVA-X-<short-description>`
- Use `git revert <merge-sha> -m 1` to revert the merge commit (`-m 1` specifies the mainline parent for merge commits).
- Push the branch and create a PR via `gh pr create`.
- PR title: `Revert DVA-X: [original PR title]`
- PR body includes:
  - Why it was reverted
  - Test failure output (truncated for readability)
  - Link to the original PR
  - Note that human approval is required to merge
- The revert PR does NOT auto-merge — requires human approval per acceptance criteria.

### 4. Linear Updates

- Move the original issue to "In Progress" using `scripts/linear.mjs`. The `updateStatus()` function sets the state unconditionally (does not check the current state), which is acceptable — if the issue was already manually moved to a different state, the rollback script should still move it to "In Progress" because tests are failing on main due to this issue's code.
- If no Linear issue ID was found in the culprit commit (see edge cases below), skip the Linear update but still create the revert PR.
- **First comment** (posted before revert PR creation, so it lands before the `linear-sync.yml` idempotent update):
  - What failed (test names/output, truncated)
  - Which commit was identified as the culprit
  - Whether bisection was used
- **Second comment** (posted after revert PR creation):
  - The revert PR link

### 5. GitHub PR Comment

- Find the original PR number from the culprit merge commit using `gh api /repos/{owner}/{repo}/commits/{sha}/pulls`.
- Post a comment on the original merged PR that caused the failure.
- Includes: failure summary, link to the revert PR, and the Linear issue link (if available).
- Ensures the PR author gets a GitHub notification.
- If the PR lookup fails (e.g., commit was pushed directly, not via PR), skip the comment and log a warning.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No Linear issue ID in culprit commit | Revert PR is still created. Linear update is skipped. Revert PR title uses commit subject instead of issue reference. |
| No associated PR for culprit commit | Revert PR is still created. GitHub PR comment is skipped. |
| Culprit is a direct push (not a merge commit) | `git revert` without `-m 1` flag. Otherwise same flow. |
| First-ever run (no prior green baseline) | Skip bisection, blame the most recent merge commit. |
| Bisection exceeds safety cap (33+ merges) | Skip bisection, blame the most recent merge, note in Linear comment. |
| Concurrent pushes to main | Concurrency group serializes runs; only the latest proceeds. |

## Script Internal Functions

All functions live within `scripts/rollback.mjs` (single-file pattern consistent with the rest of the project).

| Function | Responsibility |
|----------|---------------|
| `runTestsWithRetry(retries)` | Runs `npm test` up to N times, returns `{ passed, flaky, outputs[] }` |
| `findLastGreenSha()` | Queries GitHub API for last successful rollback workflow run on `main` |
| `getMergeCommitsSince(baseSha)` | Lists merge commits between base and HEAD |
| `bisectCulprit(merges)` | Binary search over merge commits, returns the guilty SHA |
| `extractIssueId(commitMsg)` | Extracts `DVA-X` from commit/PR text |
| `createRevertPR(mergeSha, issueId)` | Creates the revert branch, commit, and PR |
| `updateLinear(issueId, details)` | Moves issue to "In Progress", posts initial failure comment |
| `postRevertLink(issueId, prUrl)` | Posts follow-up Linear comment with the revert PR link |
| `commentOnOriginalPR(prNumber, details)` | Posts failure summary on the original merged PR |
| `main()` | Orchestrates the full flow |

## Environment Variables

Passed by the workflow to the script:

| Variable | Source | Purpose |
|----------|--------|---------|
| `GITHUB_TOKEN` | `secrets.GITHUB_TOKEN` | For `gh` CLI and GitHub API calls |
| `LINEAR_API_KEY` | `secrets.LINEAR_API_KEY` | For Linear status/comment updates |
| `GITHUB_REPOSITORY` | Built-in | Owner/repo string |
| `GITHUB_SHA` | Built-in | Current commit SHA |

## Testing Approach

- Functions that shell out (`git`, `gh`, `npm test`) are tested by mocking `child_process.execSync`/`execFileSync`.
- Pure logic (bisect algorithm, flaky detection decisions, issue ID extraction) tested with unit tests.
- Follows existing test patterns: Node.js built-in test runner (`node --test`).
- Test file: `tests/rollback.test.mjs`.

## Acceptance Criteria Mapping

| Criterion | How it's met |
|-----------|-------------|
| CI failure on main triggers rollback investigation | `rollback.yml` triggers on push to `main`, runs tests |
| Revert PR created automatically with proper title and context | `createRevertPR()` creates branch, reverts merge, opens PR via `gh` |
| Linear issue moved back to "In Progress" with failure details | `updateLinear()` calls `scripts/linear.mjs` for status + comment |
| Revert PR requires human approval to merge | PR is created but never auto-merged |
| Flaky test detection prevents unnecessary reverts | `runTestsWithRetry()` retries 3 times, exits without revert if any pass |
