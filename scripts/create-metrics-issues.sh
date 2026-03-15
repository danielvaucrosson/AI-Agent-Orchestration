#!/usr/bin/env bash
# One-time script to create GitHub issues for the metrics fixes.
# Run locally where `gh` is authenticated: bash scripts/create-metrics-issues.sh
set -euo pipefail

gh issue create \
  --repo danielvaucrosson/Test \
  --title "Fix dashboard daily quota denominator to use scheduler config" \
  --body "$(cat <<'EOF'
## Problem

The agent dashboard (`scripts/agent-dashboard.mjs`) had `DAILY_LIMIT` hardcoded to `4`, but the agent scheduler uses the `AGENT_MAX_DAILY_RUNS` env var with a default of `2`. This caused the daily quota gauge to show `X/4` while the scheduler only allows 2 runs per day.

## Expected Behavior

The dashboard denominator should match the scheduler's configured max daily runs, updating dynamically when `AGENT_MAX_DAILY_RUNS` is changed.

## Fix

- Replace hardcoded `DAILY_LIMIT = 4` with `getDailyLimit()` that reads `AGENT_MAX_DAILY_RUNS` env var (default 2)
- Update `renderDashboard` to use data-driven value from gauges
- Update tests accordingly

Implemented on branch `claude/fix-metrics-agent-tasks-7PNtu`.
EOF
)"

gh issue create \
  --repo danielvaucrosson/Test \
  --title "Add historical succeeded/failed totals to dashboard" \
  --body "$(cat <<'EOF'
## Problem

The dashboard's Succeeded and Failed gauges only count runs from the last 24 hours. When all past runs are older than 24h, these gauges show `0` even though completed runs exist in the history table.

## Expected Behavior

The dashboard should show all-time totals for succeeded/failed runs, not just today's counts.

## Fix

- Add `totalSucceeded` and `totalFailed` gauge fields counting all fetched runs
- CLI: add a `TOTAL:` line showing all-time succeeded/failed counts
- Web: update gauge cards to show all-time totals with "X today" sub-labels
- Keep existing `succeeded`/`failed` (today-only) fields for backward compatibility

Implemented on branch `claude/fix-metrics-agent-tasks-7PNtu`.
EOF
)"

echo "Done — both issues created."
