// scripts/pulse-check.mjs — Agent health monitoring (pulse check)
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WORKFLOW_FILE = "agent-worker.yml";
const QUEUE_TIMEOUT_MS = 2 * 60 * 1000;
const RUNNING_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_STUCK_OBSERVATIONS = 3;
const MAX_PULSE_RETRIES = 2;
const ISSUE_RE = /\b([A-Z]{1,5}-\d+)\b/;

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
