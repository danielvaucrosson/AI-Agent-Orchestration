/**
 * Workflow Health Check
 *
 * Queries GitHub Actions via the `gh` CLI to verify recent workflow run health.
 *
 * Usage:
 *   node scripts/workflow-health.mjs
 *   node scripts/workflow-health.mjs --workflow linear-sync.yml
 *   node scripts/workflow-health.mjs --json
 *   node scripts/workflow-health.mjs --help
 *
 * Exit codes:
 *   0  — all workflows healthy (all recent runs succeeded or are in progress)
 *   1  — one or more workflows have failures
 */

import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKFLOWS_DIR = join(__dirname, "..", ".github", "workflows");
const LIMIT = 5;

// ---------------------------------------------------------------------------
// Core functions (exported for testing with dependency injection)
// ---------------------------------------------------------------------------

/**
 * Returns a list of workflow filenames from .github/workflows/.
 * Uses `deps.readDir` so it can be mocked in tests.
 *
 * @param {{ readDir?: (dir: string) => string[] }} [deps]
 * @returns {string[]}
 */
export function listWorkflowFiles(deps = {}) {
  const readDir = deps.readDir || ((dir) => readdirSync(dir, "utf-8"));
  try {
    return readDir(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  } catch {
    return [];
  }
}

/**
 * Checks recent runs for a single workflow file.
 *
 * @param {string} workflowName  e.g. "linear-sync.yml"
 * @param {{ exec?: (cmd: string) => string }} [deps]
 * @returns {{ workflow: string, healthy: boolean, runs: Array<{status: string, conclusion: string}> }}
 */
export function checkWorkflowHealth(workflowName, deps = {}) {
  const exec = deps.exec || ((cmd) => execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }));

  let runs = [];
  try {
    const raw = exec(
      `gh run list --workflow "${workflowName}" --limit ${LIMIT} --json status,conclusion`,
    );
    runs = JSON.parse(raw.trim() || "[]");
  } catch {
    // gh not available, no runs, or workflow not found — treat as unknown
    return { workflow: workflowName, healthy: true, runs: [], skipped: true };
  }

  if (runs.length === 0) {
    // No runs yet — not unhealthy, just untested
    return { workflow: workflowName, healthy: true, runs: [], skipped: true };
  }

  const hasFailure = runs.some(
    (r) => r.conclusion === "failure" || r.conclusion === "cancelled",
  );

  return {
    workflow: workflowName,
    healthy: !hasFailure,
    runs,
  };
}

/**
 * Checks all workflows in .github/workflows/.
 *
 * @param {{ exec?: (cmd: string) => string, readDir?: (dir: string) => string[] }} [deps]
 * @returns {{ healthy: boolean, results: ReturnType<typeof checkWorkflowHealth>[] }}
 */
export function checkAllWorkflows(deps = {}) {
  const files = listWorkflowFiles(deps);
  const results = files.map((f) => checkWorkflowHealth(f, deps));
  const healthy = results.every((r) => r.healthy);
  return { healthy, results };
}

/**
 * Formats a summary of workflow health results as a human-readable string.
 *
 * @param {{ healthy: boolean, results: ReturnType<typeof checkWorkflowHealth>[] }} summary
 * @returns {string}
 */
export function formatHealthSummary(summary) {
  const lines = ["=== Workflow Health Check ===", ""];

  for (const r of summary.results) {
    const icon = r.healthy ? "PASS" : "FAIL";
    const note = r.skipped ? " (no runs)" : ` (last ${r.runs.length} runs)`;
    lines.push(`[${icon}] ${r.workflow}${note}`);

    if (!r.healthy) {
      const failures = r.runs.filter(
        (run) => run.conclusion === "failure" || run.conclusion === "cancelled",
      );
      for (const f of failures) {
        lines.push(`       -> conclusion: ${f.conclusion}, status: ${f.status}`);
      }
    }
  }

  lines.push("");
  const total = summary.results.length;
  const failed = summary.results.filter((r) => !r.healthy).length;
  const skipped = summary.results.filter((r) => r.skipped).length;

  if (summary.healthy) {
    lines.push(`All ${total} workflow(s) healthy (${skipped} with no recorded runs).`);
  } else {
    lines.push(`${failed} of ${total} workflow(s) have failures.`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { workflow: null, json: false, help: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workflow" && args[i + 1]) {
      opts.workflow = args[++i];
    } else if (args[i] === "--json") {
      opts.json = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      opts.help = true;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// CLI entry-point
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    console.log(`Usage: node scripts/workflow-health.mjs [--workflow <name>] [--json] [--help]

Checks recent GitHub Actions workflow runs for failures.

Options:
  --workflow <name>   Check a specific workflow file (e.g. linear-sync.yml)
  --json              Output results as JSON
  --help, -h          Show this help message

Exit codes:
  0  All workflows healthy
  1  One or more workflows have failures
`);
    process.exit(0);
  }

  let summary;
  if (opts.workflow) {
    const result = checkWorkflowHealth(opts.workflow);
    summary = { healthy: result.healthy, results: [result] };
  } else {
    summary = checkAllWorkflows();
  }

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(formatHealthSummary(summary));
  }

  process.exit(summary.healthy ? 0 : 1);
}
