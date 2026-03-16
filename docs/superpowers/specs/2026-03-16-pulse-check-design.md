# DVA-51: Pulse Check — Automated Agent Health Monitoring & Recovery

## Overview

A scheduled health monitoring system that detects stuck agent workflow runs, diagnoses the root cause, and escalates through three recovery levels. Runs as a GitHub Actions cron workflow on GitHub-hosted runners, independent of the self-hosted runner being monitored.

## Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Runtime | GitHub Actions cron (`ubuntu-latest`) | Must detect self-hosted runner offline — can't run on the thing being monitored |
| Architecture | Script + thin workflow | Matches repo patterns (`rollback.mjs`, `agent-scheduler.mjs`). Testable, CLI-reusable |
| Investigation | Hybrid: script triage + Claude escalation | Script handles 90% (runner offline, timeout). Claude for ambiguous failures |
| State persistence | GitHub repo variable (`PULSE_CHECK_STATE`) | Ephemeral runners lose local files. Repo variables persist across runs, writable via `gh api`, no extra dependencies |
| Notifications | Linear comments + GitHub issues (Level 3) | Tools already in use; GitHub issues trigger email notifications |
| Retry budget | Separate from daily quota | Recovery retries don't consume the daily task limit. Prevents a stuck-then-retried task from eating multiple quota slots |

## Thresholds & Configuration

| Parameter | Default | Source |
|-----------|---------|--------|
| Queue timeout | 2 minutes | `QUEUE_TIMEOUT_MS` constant |
| Running timeout | 60 minutes | `RUNNING_TIMEOUT_MS` constant |
| Running hard cap | 3 consecutive stuck observations | `MAX_STUCK_OBSERVATIONS` constant — forces action even without log errors |
| Pulse interval | 10 minutes | Cron schedule `*/10 * * * *` |
| Max retries per task/day | 2 | `MAX_PULSE_RETRIES` constant |
| Kill switch | `vars.AGENT_AUTOPILOT` | Same as scheduler — pulse check only runs when agents are operating |

## Architecture

```
pulse-check.yml (cron: */10 * * * *, runs-on: ubuntu-latest)
  ├─ concurrency: { group: pulse-check, cancel-in-progress: true }
  └─> scripts/pulse-check.mjs check
        ├─ loadState()              ← read vars.PULSE_CHECK_STATE via gh api
        ├─ fetchActiveRuns()        ← GitHub Actions API
        ├─ classifyRuns()           ← apply thresholds
        ├─ diagnose(stuckRuns)      ← check runner status, logs, Linear
        ├─ recover(diagnosis)       ← cancel, requeue, or escalate
        ├─ report(actions)          ← Linear comments, audit log, GitHub issues
        └─ saveState()              ← write vars.PULSE_CHECK_STATE via gh api
```

### Workflow (`pulse-check.yml`)

- **Triggers:** `schedule: "*/10 * * * *"` + `workflow_dispatch` (manual, also gated by AGENT_AUTOPILOT)
- **Condition:** `if: vars.AGENT_AUTOPILOT == 'true'` (applied at the **job level**, not the trigger level — same pattern as `agent-scheduler.yml`. `workflow_dispatch` is always accepted; the gate prevents the job from running.)
- **Concurrency:** `group: pulse-check`, `cancel-in-progress: true` — prevents overlapping checks from creating duplicate incidents
- **Runs on:** `ubuntu-latest` (GitHub-hosted)
- **Steps:** Checkout → Setup Node.js (v22, matching other workflows) → `npm ci` → `node scripts/pulse-check.mjs check`
- **Environment:** `GITHUB_TOKEN: ${{ secrets.PAT_WITH_WORKFLOW }}` (required for writing repo variables — the automatic `GITHUB_TOKEN` cannot write to `actions/variables`), `LINEAR_API_KEY` (secret)
- **Permissions:** `contents: read`, `actions: write` (cancel runs, dispatch workflows), `issues: write` (incident reports)

### Script (`scripts/pulse-check.mjs`)

Single entry point: `check` command. Dependency-injected `orchestrate()` function for testability.

## Detection & Classification

### `fetchActiveRuns(deps)`

Uses `gh api` (same pattern as `agent-dashboard.mjs`) to get `agent-worker.yml` runs with status `queued` or `in_progress`.

### `classifyRun(run, now)` — Pure function

| Classification | Condition |
|----------------|-----------|
| `healthy` | Queued <2min, or running <60min |
| `stuck-queued` | Queued >=2min |
| `stuck-running` | In progress >=60min |

### `fetchRunnerStatus(deps)`

Calls `gh api repos/{owner}/{repo}/actions/runners` to check if any self-hosted runner is online. Primary diagnostic signal — queued run + offline runner is the most common failure mode.

### `fetchRunLogs(runId, deps)`

For `stuck-running` cases, uses `gh run view <runId> --log` (streams text directly, no ZIP handling needed) and searches for error patterns (repeated failures, permission errors, rate limits). Returns a summary string, not the full log.

## Recovery Levels

Escalation is driven exclusively by `retryBudget[issueId].count` — not per-run state. When a run is cancelled and re-queued, a new `runId` is created, but the `issueId` budget carries the escalation history.

### Level 1 — Automated Fix + Retry (budget count: 0)

| Diagnosis | Action |
|-----------|--------|
| `stuck-queued` + runner offline | Cancel run, post Linear comment, re-queue task |
| `stuck-queued` + runner online | Increment `seenCount` on the run entry, wait one cycle |
| `stuck-running` + error in logs | Cancel run, post Linear comment with error summary, re-queue |
| `stuck-running` + no errors | Increment `seenCount` on the run entry, wait one cycle |

**Stuck observation escalation:** If a run's `seenCount` reaches `MAX_STUCK_OBSERVATIONS` (3) without errors, it is cancelled and re-queued anyway. This prevents indefinite waiting on a run that appears healthy but is actually hung.

### Level 2 — Kill + Retry (budget count: 1)

Same issue stuck again after a Level 1 recovery. More aggressive:
- Cancel the run immediately regardless of diagnosis
- Post Linear comment: "Pulse check: second recovery attempt"
- Re-queue the task
- Uses separate retry budget (max 2/task/day), not the daily task quota

### Level 3 — Halt + Incident Report (budget count: 2+)

Same task stuck and recovered twice. Something is fundamentally wrong:
- Cancel all active agent-worker runs
- Create GitHub issue labeled `incident` with:
  - Which task kept failing
  - Timeline of detections and recovery attempts
  - Runner status at each check
  - Log excerpts if available
- Post summary to Linear on all affected issues
- Log everything to audit trail

### Claude Escalation (Hybrid Path)

When Level 1 recovery fails and diagnosis is `unknown` (not runner-offline, not a recognizable log error):

- Dispatch `agent-worker.yml` with:
  - `issue_id`: `PULSE-CHECK`
  - `issue_title`: `"Investigate stuck agent <issueId> (run <runId>)"`
- At most once per stuck run (tracked in state as `investigationDispatched: true`)
- Pulse-check dispatches directly via `gh workflow run` (bypassing the scheduler). It checks the current daily run count before dispatching and aborts if the quota is already full.
- **Detection of stuck investigator:** The pulse-check script detects runs with `PULSE-CHECK` in their name/inputs. If such a run exceeds the running timeout, it skips Level 1/2 and immediately triggers Level 3 (halt + incident).

## State Management

### Persistence: GitHub repo variable `PULSE_CHECK_STATE`

State is stored as a JSON-encoded string in a GitHub repository variable, read and written via `gh api`:

```bash
# Read
gh api repos/{owner}/{repo}/actions/variables/PULSE_CHECK_STATE --jq '.value'

# Write
gh api --method PATCH repos/{owner}/{repo}/actions/variables/PULSE_CHECK_STATE \
  -f name=PULSE_CHECK_STATE -f value='<json>'
```

This survives ephemeral runner cycles — every `ubuntu-latest` VM reads the latest state on start and writes it back after processing.

**First-run bootstrap:** If `PULSE_CHECK_STATE` does not exist, `loadState()` returns a valid empty structure (`{ runs: {}, retryBudget: {} }`). The workflow's setup step creates the variable if missing.

### State schema

```json
{
  "runs": {
    "<runId>": {
      "issueId": "DVA-47",
      "classification": "stuck-queued",
      "firstSeenAt": "2026-03-16T00:15:00Z",
      "seenCount": 1,
      "lastActionAt": null,
      "diagnosis": "runner-offline",
      "investigationDispatched": false
    }
  },
  "retryBudget": {
    "DVA-47": { "today": "2026-03-16", "count": 0 }
  }
}
```

- **Pruned each cycle:** entries for completed/cancelled runs are removed
- **`retryBudget` resets daily:** if `today` doesn't match current date, `count` resets to 0
- **`seenCount`:** incremented each cycle a stuck run is observed without taking action — drives the "3 observations then force-cancel" rule
- **Escalation level** is determined solely by `retryBudget[issueId].count`

### `canRetry(issueId, state, maxRetries = 2)` — Pure function

Checks `retryBudget[issueId].count < maxRetries`. The `maxRetries` parameter always comes from the `MAX_PULSE_RETRIES` constant — the state schema does not store a `max` value to avoid dual sources of truth. Returns false if budget exhausted (triggers Level 3).

## Reporting & Notifications

### Healthy cycle

Single audit log entry:
```
[pulse-check] All clear: 1 active run (DVA-47, 4m 23s), runner online
```

### Recovery action taken

1. **Audit log** — via `scripts/audit.mjs log pulse-check "..."`
2. **Linear comment** on affected issue — describes what was detected and what action was taken
3. **State** — updated with action timestamp and incremented budget count

### Level 3 incident

1. **GitHub issue** with label `incident`: title, timeline, runner status, log excerpts
2. **Linear comments** on all affected issues
3. **Audit trail** export attached to the GitHub issue

## Testing Strategy

All decision logic uses dependency injection via `orchestrate(deps)`:

```js
export async function orchestrate(deps) {
  // deps = { fetchRuns, fetchRunners, cancelRun, dispatchRun,
  //          loadState, saveState, postLinearComment, createGitHubIssue,
  //          logAudit, fetchRunLogs, now }
}
```

### Test cases

- Healthy run → no action taken
- Queued >2min + runner offline → cancel + requeue (Level 1)
- Queued >2min + runner online → increment seenCount, no action
- Queued >2min + runner online + seenCount hits 3 → force cancel + requeue
- Running >60min + errors in logs → cancel + requeue (Level 1)
- Running >60min + no errors → increment seenCount, wait
- Running >60min + no errors + seenCount hits 3 → force cancel + requeue
- Same issue stuck after requeue → Level 2 (budget count: 1)
- Same issue stuck after Level 2 → Level 3 (cancel all, create incident)
- Retry budget exhausted → escalate to Level 3
- Claude investigation dispatched on unknown diagnosis
- Claude investigation dispatched only once per run
- Claude investigation dispatch skipped when daily quota full
- PULSE-CHECK run detected as stuck → immediate Level 3
- State cold start (variable missing) → empty valid state, no crash
- State pruning of completed/cancelled runs
- Daily retry budget reset on new day
- Multiple stuck runs in same cycle → handled independently
- Concurrent cycle prevention (test concurrency group behavior)

## Files

| File | Purpose |
|------|---------|
| `.github/workflows/pulse-check.yml` | Cron workflow (thin, `ubuntu-latest`) |
| `scripts/pulse-check.mjs` | All detection, diagnosis, recovery, reporting logic |
| `tests/pulse-check.test.mjs` | Unit tests for all pure functions + orchestration |

## Config Changes

- Create repo variable `PULSE_CHECK_STATE` (initially empty JSON `{}`)
- Ensure `PAT_WITH_WORKFLOW` has `variables: write` permission (needed for state persistence). If using a fine-grained token, add the "Variables" repository permission.
- Add `concurrency: { group: pulse-check, cancel-in-progress: true }` to workflow

## Out of Scope (tracked separately)

- Daily quota increase to 4 — independent operational change, not a pulse-check requirement
- Dashboard integration (DVA-52, DVA-53, DVA-55) — builds on pulse-check data but is separate work
