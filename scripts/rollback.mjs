// scripts/rollback.mjs
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

const MAX_RETRIES = 3;
const MAX_BISECT_ITERATIONS = 5;
const LINEAR_SCRIPT = join(__dirname, "linear.mjs");

// Linear issue IDs: uppercase team key + dash + number
const ISSUE_RE = /\b([A-Z]{1,5}-\d+)\b/;

export function extractIssueId(text) {
  if (!text) return null;
  const match = text.match(ISSUE_RE);
  return match ? match[1] : null;
}

/**
 * Runs tests up to `retries` times. Returns { passed, flaky, outputs[] }.
 * Accepts an optional `execFn` for testing (defaults to execSync with npm test).
 */
export function runTestsWithRetry(retries = MAX_RETRIES, execFn = null) {
  const run = execFn || (() => execSync("npm test 2>&1", {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    timeout: 120000,
  }));

  const outputs = [];
  for (let i = 0; i < retries; i++) {
    try {
      const output = run();
      outputs.push(output);
      return {
        passed: true,
        flaky: i > 0,
        outputs,
      };
    } catch (err) {
      outputs.push(err.stdout || err.stderr || err.message || "");
    }
  }

  return { passed: false, flaky: false, outputs };
}

/**
 * Binary search over merge commits to find the first one that breaks tests.
 * `merges` is an array of { sha, message } ordered oldest-to-newest.
 * `testFn(sha)` returns true if tests pass at that SHA, false if they fail.
 * Returns the culprit merge object, with optional `skippedBisection` flag.
 */
export function bisectCulprit(merges, testFn, maxIterations = MAX_BISECT_ITERATIONS) {
  if (merges.length === 0) return null;
  if (merges.length === 1) return merges[0];

  // Safety cap: if too many merges, skip bisection (33+ merges for default cap of 5)
  if (Math.ceil(Math.log2(merges.length)) > maxIterations) {
    const last = merges[merges.length - 1];
    return { ...last, skippedBisection: true };
  }

  let lo = 0;
  let hi = merges.length - 1;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const passes = testFn(merges[mid].sha);
    if (passes) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return merges[lo];
}

/**
 * Queries GitHub Actions API for the last successful run of the rollback workflow.
 * Uses `conclusion=success` (not `status=success`) to filter by outcome.
 * Returns the head SHA of that run, or null if none found.
 * Accepts optional execFn for testing.
 */
export function findLastGreenSha(execFn = null) {
  const run = execFn || (() => execSync(
    'gh api "/repos/{owner}/{repo}/actions/workflows/rollback.yml/runs?branch=main&conclusion=success&per_page=5" --jq ".workflow_runs | map({conclusion, headSha: .head_sha})"',
    { encoding: "utf-8", cwd: PROJECT_ROOT }
  ));

  try {
    const data = JSON.parse(run());
    const success = data.find((r) => r.conclusion === "success");
    return success ? success.headSha : null;
  } catch {
    return null;
  }
}

/**
 * Lists merge commits between baseSha and HEAD.
 * Returns array of { sha, message } ordered oldest-to-newest.
 * If baseSha is null, uses HEAD with -n 50 limit.
 */
export function getMergeCommitsSince(baseSha, execFn = null) {
  const range = baseSha ? `${baseSha}..HEAD` : "HEAD";
  const limit = baseSha ? "" : " -n 50";
  const cmd = `git log --merges --reverse --format="%H %s"${limit} ${range}`;

  const run = execFn || (() => execSync(cmd, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
  }));

  const output = run().trim();
  if (!output) return [];

  return output.split("\n").map((line) => {
    const spaceIdx = line.indexOf(" ");
    return {
      sha: line.substring(0, spaceIdx),
      message: line.substring(spaceIdx + 1),
    };
  });
}
