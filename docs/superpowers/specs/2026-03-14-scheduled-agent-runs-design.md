# DVA-19: Scheduled Agent Runs — Design Spec

## Summary

A GitHub Action runs on a cron schedule (every 6 hours), checks Linear for the highest-priority unblocked "Todo" issue, and dispatches a separate worker workflow that invokes Claude Code to autonomously pick up and complete the task.

## Decisions Made During Design

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent invocation architecture | Two workflows: scheduler + worker via `workflow_dispatch` (option B) | Clean separation of scheduling vs. execution; independent logs, cancel, retry per run |
| Schedule frequency | Every 6 hours (`0 */6 * * *`) | Balances throughput with cost control; rate limiter caps actual runs |
| Rate limiting | Configurable via `AGENT_MAX_DAILY_RUNS` repo variable, default 2 | Start conservative, adjust without code changes |
| Agent invocation method | Direct `claude -p` with inline prompt | Agent reads CLAUDE.md and follows established protocol; no extra indirection needed |
| Notifications | Linear comments + GitHub Actions job summary | Linear comments happen naturally from agent workflow; job summary gives Actions UI dashboard |
| Failure handling | Handoff + revert to Todo + `agent-failed` label + max 2 retries | Allows automatic retry, gives visibility into failures, prevents infinite loops |

## Architecture

### Approach

Two GitHub Actions workflows. The **scheduler** (`agent-scheduler.yml`) runs on cron, performs gate checks (kill switch, rate limit), selects the next task, and dispatches the **worker** (`agent-worker.yml`) via `workflow_dispatch`. The worker installs Claude Code and runs it with a prompt referencing the issue. This follows the project's pattern of thin workflows delegating to scripts where possible.

### File Structure

| File | Purpose |
|------|---------|
| `.github/workflows/agent-scheduler.yml` | Cron-triggered scheduler — gate checks, task selection, worker dispatch |
| `.github/workflows/agent-worker.yml` | `workflow_dispatch`-triggered worker — runs Claude Code on a specific issue |
| `scripts/agent-scheduler.mjs` | Scheduler logic — rate limit check, task selection, failed-task filtering |
| `tests/agent-scheduler.test.mjs` | Unit tests for scheduler logic |

### Flow Diagram

```
Every 6 hours (or manual trigger)
  -> agent-scheduler.yml runs
    -> Check kill switch (AGENT_AUTOPILOT repo var)
    -> If disabled -> log "Autopilot disabled", exit
    -> Check rate limit (count agent-worker runs in last 24h)
    -> If >= AGENT_MAX_DAILY_RUNS -> log "Rate limit reached", exit
    -> Checkout repo, install deps
    -> Run task selection (scripts/agent-scheduler.mjs next)
    -> If no task -> log "No tasks available", exit
    -> Dispatch agent-worker.yml with issue_id and issue_title
    -> Post Linear comment: "Automated agent run dispatched"

agent-worker.yml receives workflow_dispatch
  -> Checkout repo
  -> Install Claude Code
  -> Run: claude -p "Pick up {issue_id}: {issue_title}. Follow the workflow in CLAUDE.md."
  -> On success:
      -> Write GitHub Actions job summary (issue link, duration, outcome)
  -> On failure:
      -> Agent should have written handoff to .claude/handoffs/DVA-X.md
      -> Move issue back to "Todo" via Linear API
      -> Apply/increment "agent-failed" label
      -> Write failure job summary
```

## Workflow Configuration

### `agent-scheduler.yml`

**Triggers:**
- `schedule: cron: '0 */6 * * *'`
- `workflow_dispatch` (manual trigger, no inputs needed)

**Permissions:**
| Permission | Reason |
|-----------|--------|
| `actions: read` | Query recent `agent-worker` workflow runs for rate limiting |
| `actions: write` | Dispatch `agent-worker.yml` via `workflow_dispatch` |
| `contents: read` | Checkout repo for `task-ordering.mjs` |

**Concurrency:** Group `agent-scheduler` with `cancel-in-progress: true`. If a manual trigger overlaps with a cron run, only the latest proceeds.

**Steps:**

1. **Kill switch gate** — Check repo variable `AGENT_AUTOPILOT`. If `false` or unset, exit. Default behavior: enabled when the variable is `true`.
2. **Checkout** — Standard checkout with `fetch-depth: 1` (no history needed).
3. **Setup Node.js** — Install Node.js 20, run `npm ci`.
4. **Rate limit check + task selection** — Run `node scripts/agent-scheduler.mjs next --max-daily ${{ vars.AGENT_MAX_DAILY_RUNS || '2' }}`. This script:
   - Queries GitHub API for `agent-worker` runs in the last 24 hours
   - If at or over the limit, exits with code 0 and outputs `task=none`
   - Otherwise, calls `task-ordering.mjs next --team DVA --json` internally
   - Filters out issues that have `agent-failed` label with retry count >= 2
   - Outputs the selected issue ID and title (or `task=none` if nothing available)
5. **Dispatch worker** — If a task was selected, run `gh workflow run agent-worker.yml -f issue_id=DVA-X -f issue_title="..."`.
6. **Post Linear notification** — Comment on the issue: "Automated agent run dispatched via scheduled pickup."

### `agent-worker.yml`

**Triggers:**
- `workflow_dispatch` with inputs:
  - `issue_id` (required, string) — e.g., `DVA-19`
  - `issue_title` (required, string) — human-readable title for logs

**Permissions:**
| Permission | Reason |
|-----------|--------|
| `contents: write` | Create branches, push commits |
| `pull-requests: write` | Create PRs |
| `issues: write` | For any GitHub issue interactions |

**Concurrency:** Group `agent-worker-${{ inputs.issue_id }}` with `cancel-in-progress: false`. Prevents duplicate runs for the same issue but allows parallel runs for different issues.

**Steps:**

1. **Checkout** — `fetch-depth: 0` (agent needs full history for branch creation and diffs).
2. **Setup Node.js** — Install Node.js 20, run `npm ci`.
3. **Install Claude Code** — `npm install -g @anthropic-ai/claude-code`.
4. **Run agent** — Execute Claude Code with the issue prompt:
   ```bash
   claude -p "Pick up ${{ inputs.issue_id }}: ${{ inputs.issue_title }}. Follow the workflow protocol in CLAUDE.md. This is an automated scheduled run."
   ```
   Environment variables: `ANTHROPIC_API_KEY`, `LINEAR_API_KEY`, `GITHUB_TOKEN`.
5. **Post-run: success** — Write a GitHub Actions job summary with: issue ID/title, link to Linear issue, run duration, "completed successfully."
6. **Post-run: failure** — In an `if: failure()` step:
   - Check if a handoff file exists at `.claude/handoffs/${{ inputs.issue_id }}.md`
   - Move issue back to "Todo" via `node scripts/linear.mjs status ${{ inputs.issue_id }} "Todo"`
   - Apply `agent-failed` label via Linear API (or increment retry count in a comment)
   - Write a failure job summary with: issue ID, error context, handoff file link if present

## Component Design

### 1. Kill Switch

The repo variable `AGENT_AUTOPILOT` controls whether scheduled runs proceed.

| Value | Behavior |
|-------|----------|
| `true` | Scheduled runs proceed normally |
| `false` | Scheduler exits immediately after logging |
| Unset | Treated as `false` (opt-in safety) |

This is checked as the very first step, before any API calls or checkouts. Toggled via GitHub Settings → Variables → Repository variables — no commit required.

### 2. Rate Limiting

Rate limiting counts completed `agent-worker.yml` workflow runs (any conclusion) in the last 24 hours using the GitHub Actions API:

```
GET /repos/{owner}/{repo}/actions/workflows/agent-worker.yml/runs?created=>={24h_ago}
```

The count is compared against `AGENT_MAX_DAILY_RUNS` (repo variable, default `2`). This approach:
- Uses GitHub as the source of truth (no marker files to get out of sync)
- Counts all runs (success, failure, cancelled) to prevent cost overruns from failures
- Is configurable without code changes

### 3. Task Selection

Task selection reuses `task-ordering.mjs next` which already implements:
- Dependency-aware ordering (blocks/blockedBy relations)
- Priority ordering (Urgent > High > Medium > Low > None)
- Filtering to actionable statuses (Backlog, Todo)
- Circular dependency detection

The scheduler script (`agent-scheduler.mjs`) wraps this with additional filtering:
- **Status filter:** Only "Todo" issues (not "Backlog" — those aren't ready for work)
- **Failed task filter:** Skip issues where the `agent-failed` label exists AND retry count >= 2 (tracked via label description or a structured comment)

### 4. Retry Tracking

When the agent fails on a task:

1. The worker moves the issue back to "Todo"
2. The worker posts a structured comment: `[agent-retry: 1]` (or increments the existing count)
3. The worker applies the `agent-failed` label

On the next scheduler run:
- The scheduler sees the issue is "Todo" and considers it
- The scheduler checks for `agent-failed` label and reads the retry count from comments
- If retries < 2: dispatches the worker again (the agent may succeed with a different approach)
- If retries >= 2: skips the issue, logs "Skipping DVA-X: max retries exceeded"

When a human intervenes (removes the label, or the issue is manually completed), the retry state is effectively reset.

### 5. Notifications

**Linear comments** (via agent's natural workflow):
- On dispatch: Scheduler posts "Automated agent run dispatched via scheduled pickup"
- On start: Agent posts its plan (standard CLAUDE.md step 2)
- On completion: Agent posts summary (standard CLAUDE.md step 7)
- On failure: Worker posts failure details with handoff reference

**GitHub Actions job summary** (via `$GITHUB_STEP_SUMMARY`):
- Written by the worker workflow on both success and failure
- Includes: issue ID, title, Linear link, duration, outcome, and handoff link (if failed)
- Visible in the Actions UI run page

### 6. Failure Handling

| Scenario | Behavior |
|----------|----------|
| Agent completes successfully | Job summary written. Issue follows normal workflow (PR created, moves to "In Review" via `linear-sync.yml`) |
| Agent fails (non-zero exit) | Handoff preserved, issue moved to "Todo", `agent-failed` label applied, retry count incremented |
| Agent times out (6-hour GitHub limit) | Same as failure — the `if: failure()` step runs |
| Agent fails on retry (count >= 2) | Issue stays in "Todo" with `agent-failed` label, skipped by future scheduler runs until human intervenes |
| No tasks available | Scheduler exits cleanly, no worker dispatched |
| Rate limit reached | Scheduler exits cleanly, logs the limit |
| Kill switch disabled | Scheduler exits immediately |

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Scheduler and worker run concurrently for same issue | Worker concurrency group prevents duplicates per issue |
| Manual `workflow_dispatch` of worker | Works fine — bypasses scheduler gates, useful for testing or re-running a specific issue |
| Manual `workflow_dispatch` of scheduler | Respects kill switch and rate limits, but allows on-demand task pickup |
| `task-ordering.mjs` returns a "Backlog" issue | Scheduler filters to "Todo" only — Backlog issues are not ready for autonomous pickup |
| Linear API unavailable | Scheduler fails at task selection step, no worker dispatched |
| Agent creates PR but worker step still fails | The `if: failure()` step checks for partial work; the PR and Linear sync still function normally |
| Multiple issues ready, only one dispatched | By design — one task per scheduler run, rate limited to N per day |

## Environment Variables and Secrets

**Repository variables** (Settings → Variables):
| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENT_AUTOPILOT` | `false` | Kill switch — must be explicitly set to `true` |
| `AGENT_MAX_DAILY_RUNS` | `2` | Maximum agent-worker dispatches per 24 hours |

**Repository secrets:**
| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Claude Code API access (worker only) |
| `LINEAR_API_KEY` | Linear API for status updates and comments |
| `GITHUB_TOKEN` | Auto-provided, used for `gh` CLI and API calls |

## Interaction with Existing Workflows

### `linear-sync.yml`

When the agent pushes a branch or opens a PR, `linear-sync.yml` will fire and move the issue through its normal transitions (In Progress → In Review → Done). This is the expected behavior — the agent's work flows through the same pipeline as human work.

### `pr-feedback.yml`

If a human reviews the agent's PR and adds the `agent-actionable` label or posts `/agent fix`, `pr-feedback.yml` handles that separately. The scheduled pickup system does not interfere with the feedback loop.

## Testing Approach

- **`scripts/agent-scheduler.mjs`** is the only new script with testable logic (rate limit checking, task filtering, retry count parsing).
- Pure logic functions (retry count parsing, task filtering) tested with unit tests.
- GitHub API calls (rate limit check, workflow dispatch) tested by mocking `fetch` or `gh` CLI.
- Follows existing pattern: Node.js built-in test runner (`node --test`), test file at `tests/agent-scheduler.test.mjs`.
- Workflow YAML files are validated by running `actionlint` if available, or by manual review.

## Acceptance Criteria Mapping

| Criterion | How it's met |
|-----------|-------------|
| Scheduled GitHub Action runs on cron | `agent-scheduler.yml` with `schedule: '0 */6 * * *'` |
| Picks highest-priority "Todo" issue from Linear | `task-ordering.mjs next` with "Todo" status filter |
| Agent completes full workflow autonomously | Worker runs `claude -p` with CLAUDE.md protocol reference |
| Rate limiting prevents excessive runs | GitHub API run count vs. `AGENT_MAX_DAILY_RUNS` variable |
| Kill switch immediately disables autopilot | `AGENT_AUTOPILOT` repo variable checked before any work |
| Notifications sent on agent start/finish | Linear comments (natural workflow) + GitHub Actions job summary |
