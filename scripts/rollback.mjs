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

/**
 * Creates a revert branch, reverts the culprit commit, pushes, and opens a PR.
 * Returns { prUrl, branchName }.
 */
export function createRevertPR(culprit, execFn = null) {
  const { sha, message, isMergeCommit, issueId, failureOutput } = culprit;
  const run = execFn || ((cmd) => execSync(cmd, { encoding: "utf-8", cwd: PROJECT_ROOT }).trim());

  // Get the original commit subject for the PR title
  const commitSubject = run(`git log --format="%s" -1 ${sha}`);

  // Build branch name (lowercase, with short SHA suffix)
  const shortDesc = (issueId || "unknown").toLowerCase();
  const branchName = `revert/${shortDesc}-${sha.substring(0, 7)}`;

  // Create revert branch
  run(`git checkout -b ${branchName}`);

  // Revert the commit (use -m 1 for merge commits)
  const revertFlag = isMergeCommit ? " -m 1" : "";
  run(`git revert ${sha}${revertFlag} --no-edit`);

  // Push the branch
  run(`git push origin ${branchName}`);

  // Build PR title and body
  const prTitle = issueId
    ? `Revert ${issueId}: ${commitSubject}`
    : `Revert: ${commitSubject}`;

  const truncatedOutput = (failureOutput || "").substring(0, 2000);
  const prBody = [
    "## Automated Rollback",
    "",
    `Tests failed on \`main\` after commit ${sha.substring(0, 7)}.`,
    "",
    "### Failure Output",
    "```",
    truncatedOutput,
    "```",
    "",
    "**This revert PR requires human approval to merge.**",
  ].join("\n");

  // Create the PR
  const prUrl = run(`gh pr create --title "${prTitle}" --body "${prBody.replace(/"/g, '\\"')}" --base main --head ${branchName}`);

  // Return to main
  run("git checkout main");

  return { prUrl, branchName };
}

/**
 * Moves the Linear issue to "In Progress" and posts a failure comment.
 * Skips if issueId is null.
 */
export function updateLinear(issueId, details, execFn = null) {
  if (!issueId) return;
  const run = execFn || ((cmd) => execSync(cmd, { encoding: "utf-8", cwd: PROJECT_ROOT }).trim());

  run(`node "${LINEAR_SCRIPT}" status ${issueId} "In Progress"`);

  const truncated = (details.failureOutput || "").substring(0, 1500);
  const bisectNote = details.usedBisection ? "Bisection was used to isolate this commit." : "Single merge since last green — no bisection needed.";
  const comment = `Rollback triggered: tests failed on main.\\n\\nCulprit commit: ${details.culpritSha}\\n${bisectNote}\\n\\nFailure output:\\n\`\`\`\\n${truncated}\\n\`\`\``;

  run(`node "${LINEAR_SCRIPT}" comment ${issueId} "${comment.replace(/"/g, '\\"')}"`);
}

/**
 * Posts a follow-up Linear comment with the revert PR link.
 * Skips if issueId is null.
 */
export function postRevertLink(issueId, prUrl, execFn = null) {
  if (!issueId) return;
  const run = execFn || ((cmd) => execSync(cmd, { encoding: "utf-8", cwd: PROJECT_ROOT }).trim());

  run(`node "${LINEAR_SCRIPT}" comment ${issueId} "Revert PR created: ${prUrl}"`);
}
