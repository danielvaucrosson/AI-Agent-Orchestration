# DVA-51: Pulse Check — Automated Agent Health Monitoring & Recovery

## Overview

A scheduled health monitoring system that detects stuck agent workflow runs, diagnoses the root cause, and escalates through three recovery levels. Runs as a GitHub Actions cron workflow on GitHub-hosted runners, independent of the self-hosted runner being monitored.

## Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Runtime | GitHub Actions cron (`ubuntu-latest`) | Must detect self-hosted runner offline — can't run on the thing being monitored |
| Architecture | Script + thin workflow | Matches repo patterns (`rollback.mjs`, `agent-scheduler.mjs`). Testable, CLI-reusable |
| Investigation | Hybrid: script triage + Claude escalation | Script handles 90% (runner offline, timeout). Claude for ambiguous failures |
| State | JSON file (`.claude/pulse-check-state.json`) | Tracks retry counts and first-seen timestamps across cron cycles |
| Notifications | Linear comments + GitHub issues (Level 3) | Tools already in use; GitHub issues trigger email notifications |
| Retry budget | Separate from daily quota | Recovery retries don't consume the 4-task daily limit |

## Thresholds & Configuration

| Parameter | Default | Source |
|-----------|---------|--------|
| Queue timeout | 2 minutes | `QUEUE_TIMEOUT_MS` constant |
| Running timeout | 60 minutes | `RUNNING_TIMEOUT_MS` constant |
| Pulse interval | 10 minutes | Cron schedule `*/10 * * * *` |
| Max retries per task/day | 2 | `MAX_PULSE_RETRIES` constant |
| Daily task quota | 4 | `vars.AGENT_MAX_DAILY_RUNS` |
| Kill switch | `vars.AGENT_AUTOPILOT` | Same as scheduler — pulse check only runs when agents are operating |

## Architecture

```
pulse-check.yml (cron: */10 * * * *, runs-on: ubuntu-latest)
  └─> scripts/pulse-check.mjs check
        ├─ fetchActiveRuns()        ← GitHub Actions API
        ├─ classifyRuns()           ← apply thresholds
        ├─ diagnose(stuckRuns)      ← check runner status, logs, Linear
        ├─ recover(diagnosis)       ← cancel, requeue, or escalate
        └─ report(actions)          ← Linear comments, audit log, GitHub issues
```

### Workflow (`pulse-check.yml`)

- **Triggers:** `schedule: "*/10 * * * *"` + `workflow_dispatch`
- **Condition:** `if: vars.AGENT_AUTOPILOT == 'true'`
- **Runs on:** `ubuntu-latest` (GitHub-hosted)
- **Steps:** Checkout → `npm ci` → `node scripts/pulse-check.mjs check`
- **Environment:** `GITHUB_TOKEN` (automatic), `LINEAR_API_KEY` (secret)
- **Permissions:** `contents: read`, `actions: write` (to cancel runs + dispatch workflows), `issues: write` (for incident reports)

### Script (`scripts/pulse-check.mjs`)

Single entry point: `check` command. Dependency-injected `orchestrate()` function for testability.

## Detection & Classification

### `fetchActiveRuns()`

Uses `gh api` (same pattern as `agent-dashboard.mjs`) to get `agent-worker.yml` runs with status `queued` or `in_progress`.

### `classifyRun(run, now)` — Pure function

| Classification | Condition |
|----------------|-----------|
| `healthy` | Queued <2min, or running <60min |
| `stuck-queued` | Queued >=2min |
| `stuck-running` | In progress >=60min |

### `fetchRunnerStatus()`

Calls `gh api repos/{owner}/{repo}/actions/runners` to check if any self-hosted runner is online. Primary diagnostic signal — queued run + offline runner is the most common failure mode.

### `fetchRunLogs(runId)`

For `stuck-running` cases, fetches job logs to look for error patterns (repeated failures, permission errors, rate limits). Returns a summary, not the full log.

## Recovery Levels

### Level 1 — Automated Fix + Retry (retry count: 0)

| Diagnosis | Action |
|-----------|--------|
| `stuck-queued` + runner offline | Cancel run, post Linear comment, re-queue task |
| `stuck-queued` + runner online | Wait one more cycle (transient) |
| `stuck-running` + error in logs | Cancel run, post Linear comment with error summary, re-queue |
| `stuck-running` + no errors | Wait one more cycle (legitimately long) |

### Level 2 — Kill + Retry (retry count: 1)

Same stuck run seen again after Level 1. More aggressive:
- Cancel the run immediately regardless of diagnosis
- Post Linear comment: "Pulse check: second recovery attempt"
- Re-queue the task
- Uses separate retry budget (max 2/task/day), not the daily quota of 4

### Level 3 — Halt + Incident Report (retry count: 2+)

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
- Dispatch `agent-worker.yml` with `issue_id=PULSE-CHECK` and investigation context
- At most once per stuck run
- Counts against the daily quota of 4
- If the investigator itself gets stuck, Level 3 fires immediately

## State Management

### State file: `.claude/pulse-check-state.json` (gitignored)

```json
{
  "runs": {
    "<runId>": {
      "issueId": "DVA-47",
      "classification": "stuck-queued",
      "firstSeenAt": "2026-03-16T00:15:00Z",
      "retryCount": 0,
      "lastActionAt": null,
      "diagnosis": "runner-offline"
    }
  },
  "retryBudget": {
    "DVA-47": { "today": "2026-03-16", "count": 0, "max": 2 }
  }
}
```

- Pruned each cycle: entries for completed/cancelled runs are removed
- `retryBudget` resets daily (new date string)
- `canRetry(runState, maxRetries = 2)` checks budget before recovery

## Reporting & Notifications

### Healthy cycle

Single audit log entry:
```
[pulse-check] All clear: 1 active run (DVA-47, 4m 23s), runner online
```

### Recovery action taken

1. **Audit log** — via `scripts/audit.mjs log pulse-check "..."`
2. **Linear comment** on affected issue — describes what was detected and what action was taken
3. **State file** — updated with action timestamp and incremented retry count

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
  //          logAudit, now }
}
```

### Test cases

- Healthy run → no action taken
- Queued >2min + runner offline → cancel + requeue (Level 1)
- Queued >2min + runner online → wait (no action)
- Running >60min → cancel + requeue (Level 1)
- Same run stuck twice → Level 2 recovery
- Same run stuck 3x → Level 3 (cancel all, create incident)
- Retry budget exhausted → escalate to Level 3
- Claude investigation dispatched on unknown diagnosis
- Claude investigator stuck → immediate Level 3
- State file pruning of completed runs
- Daily retry budget reset on new day
- Multiple stuck runs in same cycle → handled independently

## Files

| File | Purpose |
|------|---------|
| `.github/workflows/pulse-check.yml` | Cron workflow (thin) |
| `scripts/pulse-check.mjs` | All detection, diagnosis, recovery, reporting logic |
| `tests/pulse-check.test.mjs` | Unit tests for all pure functions + orchestration |
| `.claude/pulse-check-state.json` | Runtime state (gitignored) |

## Config Changes

- Update `AGENT_MAX_DAILY_RUNS` repo variable from 2 to 4
- Add `.claude/pulse-check-state.json` to `.gitignore`
