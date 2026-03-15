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

/**
 * Main orchestration function. Accepts a `deps` object for testability.
 * In production, `deps` uses the real functions above.
 * Returns { action: "none"|"flaky"|"reverted", details? }.
 */
export function orchestrate(deps) {
  // Step 1: Run tests with retry
  const testResult = deps.runTests();

  if (testResult.passed && !testResult.flaky) {
    console.log("Tests passed on first try. All good.");
    return { action: "none" };
  }

  if (testResult.passed && testResult.flaky) {
    console.log("Tests flaky — passed on retry. No revert needed.");
    return { action: "flaky" };
  }

  // Step 2: Find culprit
  console.log("Tests failed consistently. Identifying culprit...");
  const greenSha = deps.findGreenSha();
  const merges = deps.getMerges(greenSha);

  if (merges.length === 0) {
    console.log("No merge commits found since last green. Cannot identify culprit.");
    return { action: "none" };
  }

  // Step 3: Identify culprit — single merge shortcut, no-baseline shortcut, or bisect
  let culprit;
  let usedBisection = false;

  if (merges.length === 1) {
    // Single merge — it's the culprit
    culprit = merges[0];
  } else if (!greenSha) {
    // No prior green baseline — can't bisect reliably, blame latest
    console.log("No prior green baseline — blaming most recent merge.");
    culprit = merges[merges.length - 1];
  } else {
    usedBisection = true;
    // Build a testFn that checks out each SHA, installs, and runs tests
    const testAtSha = (sha) => {
      try {
        execSync(`git checkout ${sha} && npm install && npm test`, {
          encoding: "utf-8", cwd: PROJECT_ROOT, timeout: 300000,
        });
        return true;
      } catch {
        return false;
      }
    };

    culprit = deps.bisect(merges, testAtSha);

    // Restore HEAD and node_modules after bisection
    deps.restoreHead();
  }

  if (!culprit) {
    console.log("Bisection failed to identify a culprit.");
    return { action: "none" };
  }

  const issueId = extractIssueId(culprit.message);
  const isMergeCommit = culprit.message.startsWith("Merge ");
  const failureOutput = testResult.outputs.join("\n---\n");

  console.log(`Culprit identified: ${culprit.sha.substring(0, 7)} (${issueId || "no issue ID"})`);

  // Step 4: Update Linear FIRST (before pushing revert branch)
  deps.linear(issueId, {
    failureOutput,
    culpritSha: culprit.sha,
    usedBisection: usedBisection && !culprit.skippedBisection,
  });

  // Step 5: Create revert PR
  const { prUrl } = deps.createPR({
    sha: culprit.sha,
    message: culprit.message,
    isMergeCommit,
    issueId,
    failureOutput,
  });

  // Step 6: Post follow-up Linear comment with PR link
  deps.revertLink(issueId, prUrl);

  // Step 7: Comment on original merged PR
  deps.commentPR(culprit.sha, {
    failureOutput,
    revertPrUrl: prUrl,
    issueId,
  });

  console.log(`Revert PR created: ${prUrl}`);
  return { action: "reverted", prUrl, issueId, culpritSha: culprit.sha };
}

// --- CLI entry point ---

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  const result = orchestrate({
    runTests: () => runTestsWithRetry(),
    findGreenSha: () => findLastGreenSha(),
    getMerges: (baseSha) => getMergeCommitsSince(baseSha),
    bisect: (merges, testFn) => bisectCulprit(merges, testFn),
    createPR: (culprit) => createRevertPR(culprit),
    linear: (issueId, details) => updateLinear(issueId, details),
    revertLink: (issueId, prUrl) => postRevertLink(issueId, prUrl),
    commentPR: (sha, details) => commentOnOriginalPR(sha, details),
    restoreHead: () => {
      execSync("git checkout main && npm install", {
        encoding: "utf-8", cwd: PROJECT_ROOT, timeout: 120000,
      });
    },
  });

  if (result.action === "none" || result.action === "flaky") {
    process.exit(0);
  }
  // Revert PR created — exit 1 so the workflow shows as failed
  process.exit(1);
}

/**
 * Finds the PR associated with a commit and posts a failure comment.
 * Skips if no PR is found for the commit.
 */
export function commentOnOriginalPR(commitSha, details, execFn = null) {
  const run = execFn || ((cmd) => execSync(cmd, { encoding: "utf-8", cwd: PROJECT_ROOT }).trim());

  // Look up the PR number from the commit SHA
  let prNumber;
  try {
    const pullsJson = run(`gh api "/repos/{owner}/{repo}/commits/${commitSha}/pulls" --jq "map({number})"`);
    const pulls = JSON.parse(pullsJson);
    if (!pulls.length) {
      console.log(`No PR found for commit ${commitSha} — skipping GitHub comment.`);
      return;
    }
    prNumber = pulls[0].number;
  } catch {
    console.log(`Failed to look up PR for commit ${commitSha} — skipping GitHub comment.`);
    return;
  }

  const truncated = (details.failureOutput || "").substring(0, 1500);
  const issueNote = details.issueId
    ? `Linear issue: [${details.issueId}](https://linear.app/dvaucrosson/issue/${details.issueId})`
    : "";

  const body = [
    "## Automated Rollback Notification",
    "",
    "Tests failed on `main` after this PR was merged.",
    "",
    `Revert PR: ${details.revertPrUrl}`,
    issueNote,
    "",
    "<details><summary>Failure output</summary>",
    "",
    "```",
    truncated,
    "```",
    "</details>",
  ].filter(Boolean).join("\n");

  run(`gh pr comment ${prNumber} --body "${body.replace(/"/g, '\\"')}"`);
}
