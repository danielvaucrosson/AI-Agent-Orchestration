// scripts/pulse-check.mjs — Agent health monitoring (pulse check)
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WORKFLOW_FILE = "agent-worker.yml";
const QUEUE_TIMEOUT_MS = 2 * 60 * 1000;
const RUNNING_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_STUCK_OBSERVATIONS = 3;
const MAX_PULSE_RETRIES = 2;
const DEFAULT_DAILY_LIMIT = 4;
const ISSUE_RE = /\b([A-Z]{1,5}-\d+)\b/;

function getDailyLimit() {
  const envVal = process.env.AGENT_MAX_DAILY_RUNS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_DAILY_LIMIT;
}

/**
 * Classify a workflow run's health based on its status and elapsed time.
 * @param {object} run - GitHub Actions workflow run object
 * @param {Date} now - current timestamp
 * @returns {"healthy"|"stuck-queued"|"stuck-running"}
 */
export function classifyRun(run, now) {
  if (run.status === "queued") {
    const elapsed = now - new Date(run.created_at);
    return elapsed >= QUEUE_TIMEOUT_MS ? "stuck-queued" : "healthy";
  }
  if (run.status === "in_progress") {
    const startedAt = run.run_started_at || run.created_at;
    const elapsed = now - new Date(startedAt);
    return elapsed >= RUNNING_TIMEOUT_MS ? "stuck-running" : "healthy";
  }
  return "healthy";
}

/**
 * Return a fresh empty pulse-check state object.
 * @returns {{ runs: Record<string, object>, retryBudget: Record<string, {count: number, day: string}> }}
 */
export function emptyState() {
  return { runs: {}, retryBudget: {} };
}

/**
 * Check whether the given issue can be retried today.
 * Resets the budget when the day rolls over.
 * @param {string} issueId
 * @param {object} state - pulse-check state
 * @param {number} maxRetries - max retries per day (default MAX_PULSE_RETRIES)
 * @param {string|null} today - ISO date string (YYYY-MM-DD), defaults to today's date
 * @returns {boolean}
 */
export function canRetry(issueId, state, maxRetries = MAX_PULSE_RETRIES, today = null) {
  const day = today || new Date().toISOString().slice(0, 10);
  const entry = state.retryBudget[issueId];
  if (!entry) return true;
  if (entry.day !== day) return true;
  return entry.count < maxRetries;
}

/**
 * Increment (or create) the retry budget for an issue.
 * Resets the counter if the day has changed.
 * @param {string} issueId
 * @param {object} state - pulse-check state (mutated in place)
 * @param {string} today - ISO date string (YYYY-MM-DD)
 */
export function incrementBudget(issueId, state, today) {
  const entry = state.retryBudget[issueId];
  if (!entry || entry.day !== today) {
    state.retryBudget[issueId] = { count: 1, day: today };
  } else {
    entry.count += 1;
  }
}

/**
 * Remove tracked runs that are no longer in the active set.
 * @param {object} state - pulse-check state (mutated in place)
 * @param {Set<string>} activeRunIds - IDs of currently active runs
 */
export function pruneState(state, activeRunIds) {
  for (const id of Object.keys(state.runs)) {
    if (!activeRunIds.has(id)) {
      delete state.runs[id];
    }
  }
}

/**
 * Extract a Linear issue ID from a workflow run object.
 * Checks inputs.issue_id first (skipping "PULSE-CHECK"), then regex on name/display_title.
 * @param {object} run - GitHub Actions workflow run object
 * @returns {string} issue ID (e.g. "DVA-10") or "unknown"
 */
export function extractIssueFromRun(run) {
  const inputId = run.inputs?.issue_id;
  if (inputId && inputId !== "PULSE-CHECK") {
    return inputId;
  }
  const nameMatch = (run.name || "").match(ISSUE_RE);
  if (nameMatch) return nameMatch[1];
  const titleMatch = (run.display_title || "").match(ISSUE_RE);
  if (titleMatch) return titleMatch[1];
  return "unknown";
}

/**
 * Check whether a workflow run is a pulse-check run (not a real task).
 * @param {object} run - GitHub Actions workflow run object
 * @returns {boolean}
 */
export function isPulseCheckRun(run) {
  if (run.inputs?.issue_id === "PULSE-CHECK") return true;
  if ((run.name || "").includes("PULSE-CHECK")) return true;
  if ((run.display_title || "").includes("PULSE-CHECK")) return true;
  return false;
}

/**
 * Diagnose why a workflow run is stuck.
 * @param {"stuck-queued"|"stuck-running"} classification
 * @param {{ online: boolean }} runnerStatus
 * @param {string|null} logSummary - error summary from logs, or null if clean
 * @returns {"runner-offline"|"transient"|"log-errors"|"no-errors"}
 */
export function diagnose(classification, runnerStatus, logSummary) {
  if (!runnerStatus.online) return "runner-offline";
  if (classification === "stuck-queued") return "transient";
  if (logSummary) return "log-errors";
  return "no-errors";
}

/**
 * Main orchestration function. Accepts a `deps` object for testability.
 * All side effects are passed in via deps.
 * Returns { actionsCount, details }.
 */
export async function orchestrate(deps) {
  const {
    fetchRuns, fetchRunners, fetchRunLogs, cancelRun, dispatchRun,
    loadState, saveState, postLinearComment, createGitHubIssue,
    logAudit, logRecoveryEvent, countDailyRuns, now, today,
  } = deps;

  const state = await loadState();
  const runs = await fetchRuns();
  const runnerStatus = await fetchRunners();

  // Prune state entries for runs no longer active
  const activeRunIds = new Set(runs.map((r) => String(r.id)));
  pruneState(state, activeRunIds);

  if (runs.length === 0) {
    await logAudit("[pulse-check] All clear: no active runs");
    await saveState(state);
    return { actionsCount: 0, details: [] };
  }

  const details = [];
  let actionsCount = 0;

  for (const run of runs) {
    const runId = String(run.id);
    const classification = classifyRun(run, now);

    if (classification === "healthy") continue;

    const issueId = extractIssueFromRun(run);
    const issueTitle = run.inputs?.issue_title || run.display_title || run.name || "";
    const pulseCheck = isPulseCheckRun(run);

    // Ensure state entry exists
    if (!state.runs[runId]) {
      state.runs[runId] = {
        issueId,
        classification,
        firstSeenAt: new Date(now).toISOString(),
        seenCount: 0,
        lastActionAt: null,
        diagnosis: null,
        investigationDispatched: false,
        logSummary: null,
      };
    }

    const runState = state.runs[runId];
    runState.seenCount += 1;
    runState.classification = classification;

    // Diagnose
    const logSummary = classification === "stuck-running"
      ? await fetchRunLogs(run.id)
      : null;
    const diagnosis = diagnose(classification, runnerStatus, logSummary);
    runState.diagnosis = diagnosis;
    runState.logSummary = logSummary || null;

    // Get budget count (resets daily)
    const budgetEntry = state.retryBudget[issueId];
    const budgetCount = (budgetEntry && budgetEntry.day === today)
      ? budgetEntry.count
      : 0;

    // Decide action
    const decision = decideAction(diagnosis, runState, budgetCount, pulseCheck);

    if (decision.action === "wait") {
      continue;
    }

    if (decision.action === "investigate") {
      const dailyCount = await countDailyRuns();
      if (dailyCount < getDailyLimit() && !runState.investigationDispatched) {
        await dispatchRun("PULSE-CHECK", `Investigate stuck agent ${issueId} (run ${runId})`);
        runState.investigationDispatched = true;
        await logAudit(`[pulse-check] Dispatched Claude investigation for ${issueId} (run ${runId})`);
        actionsCount++;
        details.push({ runId, issueId, action: "investigate", diagnosis });
      }
      continue;
    }

    if (decision.action === "cancel-requeue") {
      await cancelRun(run.id);
      incrementBudget(issueId, state, today);
      runState.lastActionAt = new Date(now).toISOString();

      const levelMsg = `Level ${decision.level} recovery`;
      await postLinearComment(issueId,
        `Pulse check: ${issueId} ${classification} (${diagnosis}). ${levelMsg} — cancelled run ${runId} and re-queued.`
      );
      await dispatchRun(issueId, issueTitle);
      await logAudit(`[pulse-check] ${levelMsg}: cancelled ${runId} (${issueId}), diagnosis: ${diagnosis}`);
      if (logRecoveryEvent) {
        await logRecoveryEvent({
          timestamp: new Date(now).toISOString(),
          level: decision.level,
          action: "cancel-requeue",
          issueId,
          issueTitle,
          diagnosis,
          runId,
        });
      }

      actionsCount++;
      details.push({ runId, issueId, action: "cancel-requeue", level: decision.level, diagnosis });
      continue;
    }

    if (decision.action === "halt-incident") {
      // Cancel ALL active runs
      for (const r of runs) {
        await cancelRun(r.id);
      }

      const timeline = Object.entries(state.runs)
        .map(([id, s]) => `- Run ${id} (${s.issueId}): ${s.classification}, seen ${s.seenCount}x, diagnosis: ${s.diagnosis}`)
        .join("\n");

      // Collect log excerpts
      const logExcerpts = Object.entries(state.runs)
        .filter(([, s]) => s.logSummary)
        .map(([id, s]) => `- Run ${id} (${s.issueId}):\n  ${s.logSummary}`)
        .join("\n");

      const incidentTitle = `Pulse Check Incident: ${issueId} stuck after ${budgetCount} recovery attempts`;
      const incidentBody = [
        `## Incident Summary`,
        ``,
        `**Task:** ${issueId} — ${issueTitle}`,
        `**Classification:** ${classification}`,
        `**Diagnosis:** ${diagnosis}`,
        `**Recovery attempts:** ${budgetCount}`,
        `**Runner status:** ${runnerStatus.online ? "online" : "offline"}`,
        ``,
        `## Timeline`,
        ``,
        timeline,
        ...(logExcerpts ? [``, `## Log Excerpts`, ``, logExcerpts] : []),
        ``,
        `## Action Taken`,
        ``,
        `All active agent-worker runs have been cancelled.`,
      ].join("\n");

      await createGitHubIssue(incidentTitle, incidentBody);

      // Notify ALL affected issues
      const affectedIssues = new Set(
        Object.values(state.runs).map((s) => s.issueId).filter((id) => id !== "unknown")
      );
      affectedIssues.add(issueId);
      for (const affected of affectedIssues) {
        await postLinearComment(affected,
          `Pulse check incident: ${issueId} stuck after ${budgetCount} recovery attempts. All agents halted. See GitHub issue for details.`
        );
      }
      await logAudit(`[pulse-check] Level 3 incident: ${issueId} — all agents halted`);
      if (logRecoveryEvent) {
        await logRecoveryEvent({
          timestamp: new Date(now).toISOString(),
          level: 3,
          action: "halt-incident",
          issueId,
          issueTitle,
          diagnosis,
          runId,
        });
      }

      actionsCount++;
      details.push({ runId, issueId, action: "halt-incident", level: 3, diagnosis });
      break; // Stop processing — we've halted everything
    }
  }

  // Log healthy summary if no actions taken
  if (actionsCount === 0) {
    const summary = runs.map((r) => {
      const id = extractIssueFromRun(r);
      const elapsed = Math.floor((now - new Date(r.run_started_at || r.created_at).getTime()) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      return `${id} (${mins}m ${secs}s)`;
    }).join(", ");
    await logAudit(`[pulse-check] All clear: ${runs.length} active run(s): ${summary}, runner ${runnerStatus.online ? "online" : "offline"}`);
  }

  await saveState(state);
  return { actionsCount, details };
}

/**
 * Decide what recovery action to take for a stuck run.
 * @param {"runner-offline"|"transient"|"log-errors"|"no-errors"} diagnosis
 * @param {{ seenCount: number, investigationDispatched: boolean }} runState
 * @param {number} budgetCount - retryBudget[issueId].count
 * @param {boolean} isPulseCheck - true if this is a PULSE-CHECK investigator run
 * @returns {{ action: "wait"|"cancel-requeue"|"halt-incident"|"investigate", level?: number }}
 */
export function decideAction(diagnosis, runState, budgetCount, isPulseCheck = false) {
  // Stuck PULSE-CHECK investigator → immediate Level 3
  if (isPulseCheck) {
    return { action: "halt-incident", level: 3 };
  }

  // Level 3: budget exhausted
  if (budgetCount >= MAX_PULSE_RETRIES) {
    return { action: "halt-incident", level: 3 };
  }

  const level = budgetCount === 0 ? 1 : 2;

  // Level 2: always cancel-requeue regardless of diagnosis
  if (level === 2) {
    return { action: "cancel-requeue", level: 2 };
  }

  // Level 1 decision tree
  if (diagnosis === "runner-offline" || diagnosis === "log-errors") {
    return { action: "cancel-requeue", level: 1 };
  }

  // No errors: check observation count for force-cancel
  if (runState.seenCount >= MAX_STUCK_OBSERVATIONS) {
    return { action: "cancel-requeue", level: 1 };
  }

  // Dispatch Claude investigation after 2 observations with no errors
  if (diagnosis === "no-errors" && runState.seenCount >= 2 && !runState.investigationDispatched) {
    return { action: "investigate" };
  }

  return { action: "wait" };
}

// ---------------------------------------------------------------------------
// Side-effect wrappers (not unit tested — integration only)
// ---------------------------------------------------------------------------

function ghApi(endpoint) {
  try {
    const output = execSync(`gh api "${endpoint}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(output);
  } catch {
    return null;
  }
}

async function realFetchRuns() {
  const data = ghApi(
    `/repos/{owner}/{repo}/actions/workflows/${WORKFLOW_FILE}/runs?status=queued&status=in_progress&per_page=30`
  );
  return data?.workflow_runs || [];
}

async function realFetchRunners() {
  const data = ghApi(`/repos/{owner}/{repo}/actions/runners`);
  const runners = data?.runners || [];
  const online = runners.some((r) => r.status === "online");
  return { online, runners };
}

async function realFetchRunLogs(runId) {
  try {
    const output = execSync(`gh run view ${runId} --log`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    // Take last 100 lines (JS-side truncation, no shell pipe)
    const lines = output.split("\n").slice(-100).join("\n");
    const errorPatterns = [/Error:/i, /permission denied/i, /rate limit/i, /FATAL/i, /failed/i];
    const matches = errorPatterns
      .filter((p) => p.test(lines))
      .map((p) => lines.match(new RegExp(`.*${p.source}.*`, "im"))?.[0]?.trim())
      .filter(Boolean);
    return matches.length > 0 ? matches.join("\n") : null;
  } catch {
    return null;
  }
}

async function realCancelRun(runId) {
  execSync(`gh run cancel ${runId}`, { stdio: "pipe" });
}

async function realDispatchRun(issueId, issueTitle) {
  execSync(
    `gh workflow run ${WORKFLOW_FILE} -f issue_id="${issueId}" -f issue_title="${issueTitle}"`,
    { stdio: "pipe" }
  );
}

async function realLoadState() {
  try {
    const output = execSync(
      `gh api repos/{owner}/{repo}/actions/variables/PULSE_CHECK_STATE --jq '.value'`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return JSON.parse(output.trim()) || emptyState();
  } catch {
    return emptyState();
  }
}

async function realSaveState(state) {
  const json = JSON.stringify(state);
  try {
    execSync(
      `gh api --method PATCH repos/{owner}/{repo}/actions/variables/PULSE_CHECK_STATE -f name=PULSE_CHECK_STATE -f value='${json.replace(/'/g, "'\\''")}'`,
      { stdio: "pipe" }
    );
  } catch {
    // Variable might not exist yet — create it
    execSync(
      `gh api --method POST repos/{owner}/{repo}/actions/variables -f name=PULSE_CHECK_STATE -f value='${json.replace(/'/g, "'\\''")}'`,
      { stdio: "pipe" }
    );
  }
}

async function realPostLinearComment(issueId, message) {
  if (issueId === "unknown" || issueId === "PULSE-CHECK") return;
  try {
    execSync(
      `node ${join(__dirname, "linear.mjs")} comment "${issueId}" "${message.replace(/"/g, '\\"')}"`,
      { stdio: "pipe", env: { ...process.env } }
    );
  } catch {
    // Best effort
  }
}

async function realCreateGitHubIssue(title, body) {
  execSync(
    `gh issue create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --label incident`,
    { stdio: "pipe" }
  );
}

export const RECOVERY_EVENTS_PATH = join(__dirname, "..", ".claude", "recovery-events.jsonl");

async function realLogRecoveryEvent(event) {
  try {
    mkdirSync(dirname(RECOVERY_EVENTS_PATH), { recursive: true });
    appendFileSync(RECOVERY_EVENTS_PATH, JSON.stringify(event) + "\n");
  } catch {
    // Best effort — don't break recovery flow
  }
}

async function realLogAudit(message) {
  try {
    execSync(
      `node ${join(__dirname, "audit.mjs")} log pulse-check "${message.replace(/"/g, '\\"')}"`,
      { stdio: "pipe" }
    );
  } catch {
    console.log(message);
  }
}

async function realCountDailyRuns() {
  const data = ghApi(
    `/repos/{owner}/{repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=30`
  );
  const runs = data?.workflow_runs || [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return runs.filter((r) => new Date(r.created_at).getTime() > cutoff).length;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const command = process.argv[2];

  if (command === "check") {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);

    const result = await orchestrate({
      fetchRuns: realFetchRuns,
      fetchRunners: realFetchRunners,
      fetchRunLogs: realFetchRunLogs,
      cancelRun: realCancelRun,
      dispatchRun: realDispatchRun,
      loadState: realLoadState,
      saveState: realSaveState,
      postLinearComment: realPostLinearComment,
      createGitHubIssue: realCreateGitHubIssue,
      logAudit: realLogAudit,
      logRecoveryEvent: realLogRecoveryEvent,
      countDailyRuns: realCountDailyRuns,
      now,
      today,
    });

    console.log(`Pulse check complete: ${result.actionsCount} action(s) taken`);
    if (result.details.length > 0) {
      for (const d of result.details) {
        console.log(`  ${d.issueId}: ${d.action} (${d.diagnosis})`);
      }
    }
  } else {
    console.log("Usage: node scripts/pulse-check.mjs check");
    console.log("");
    console.log("Commands:");
    console.log("  check    Run pulse check on active agent workflows");
  }
}
