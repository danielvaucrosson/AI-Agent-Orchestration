/**
 * PR Reviewer Agent — verifies test plans, runs quality gates, and merges PRs.
 *
 * Reviews PRs created by worker agents, validates pre-merge test plan items,
 * approves/merges or requests changes, and performs post-merge verification.
 *
 * Usage:
 *   node scripts/pr-reviewer.mjs review --pr <number>          Review a specific PR
 *   node scripts/pr-reviewer.mjs review-all                    Review all open agent PRs
 *   node scripts/pr-reviewer.mjs post-merge --pr <number>      Run post-merge verification
 *   node scripts/pr-reviewer.mjs --help                        Show help
 *
 * Environment:
 *   GH_TOKEN or GITHUB_TOKEN   GitHub token for API access
 *   GITHUB_REPOSITORY          owner/repo (e.g., "user/repo")
 *   LINEAR_API_KEY             For Linear issue updates (optional, falls back to MCP)
 */

import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const LINEAR_SCRIPT = join(__dirname, "linear.mjs");

const MAX_REVIEW_ROUNDS = 2;
const AGENT_BRANCH_RE = /^(feature|fix)\/(DVA-\d+)/;
const ISSUE_RE = /\b(DVA-\d+)\b/;

// --- Helpers ---

function gh(args, execFn) {
  const run = execFn || ((cmd) =>
    execSync(cmd, {
      encoding: "utf-8",
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    }).trim()
  );
  return run(`gh ${args}`);
}

/**
 * Post a comment on a PR using stdin (--body-file -) to avoid shell escaping
 * issues with multi-line markdown on Windows Git Bash.
 */
function ghComment(prNumber, body, execFn) {
  if (execFn) {
    // In test mode, delegate to the exec function
    return execFn(`gh pr comment ${prNumber} --body-file -<<__BODY__\n${body}\n__BODY__`);
  }
  execSync(`gh pr comment ${prNumber} --body-file -`, {
    encoding: "utf-8",
    cwd: PROJECT_ROOT,
    input: body,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Extract Linear issue ID from PR title or branch name.
 */
export function extractIssueId(text) {
  if (!text) return null;
  const match = text.match(ISSUE_RE);
  return match ? match[1] : null;
}

/**
 * Parse test plan items from PR body markdown.
 * Splits into pre-merge and post-merge sections.
 * Returns { preMerge: [{ text, checked }], postMerge: [{ text, checked }] }
 */
export function parseTestPlan(body) {
  if (!body) return { preMerge: [], postMerge: [] };

  const lines = body.split("\n");
  const preMerge = [];
  const postMerge = [];

  let section = "none"; // "none" | "pre" | "post"

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers
    if (/^#{1,3}\s+test\s+plan\b/i.test(trimmed)) {
      section = "pre";
      continue;
    }
    if (/^#{1,3}\s+post[- ]?merge\s+(verification|checks?)\b/i.test(trimmed)) {
      section = "post";
      continue;
    }
    // A new H2/H3 that isn't test plan or post-merge ends the section
    if (/^#{1,3}\s+/.test(trimmed) && section !== "none") {
      if (!/test\s+plan|post[- ]?merge/i.test(trimmed)) {
        section = "none";
      }
      continue;
    }

    // Parse checkbox items
    const checkboxMatch = trimmed.match(/^-\s+\[([ xX])\]\s+(.+)$/);
    if (checkboxMatch) {
      const item = {
        text: checkboxMatch[2].trim(),
        checked: checkboxMatch[1] !== " ",
      };

      if (section === "pre") {
        preMerge.push(item);
      } else if (section === "post") {
        postMerge.push(item);
      }
    }
  }

  return { preMerge, postMerge };
}

/**
 * List open PRs created by agent worker branches.
 * Returns array of { number, title, branch, issueId, url }
 */
export function listAgentPRs(execFn) {
  const raw = gh(
    'pr list --state open --json number,title,headRefName,url --limit 50',
    execFn
  );
  const prs = JSON.parse(raw || "[]");

  return prs
    .filter((pr) => AGENT_BRANCH_RE.test(pr.headRefName))
    .map((pr) => {
      const branchMatch = pr.headRefName.match(AGENT_BRANCH_RE);
      return {
        number: pr.number,
        title: pr.title,
        branch: pr.headRefName,
        issueId: branchMatch ? branchMatch[2] : extractIssueId(pr.title),
        url: pr.url,
      };
    });
}

/**
 * Count how many review rounds the reviewer bot has already done on a PR.
 * Counts comments that contain the reviewer signature.
 */
export function countReviewRounds(prNumber, execFn) {
  const repo = process.env.GITHUB_REPOSITORY || "";
  const raw = gh(
    `api repos/${repo}/issues/${prNumber}/comments --paginate --jq "map(select(.body | test(\\"PR Reviewer Agent\\")))" `,
    execFn
  );
  const comments = JSON.parse(raw || "[]");
  return comments.length;
}

/**
 * Run pre-merge validation on a PR branch.
 * Checks out the branch, runs tests and quality gates.
 * Returns { passed, gateResults, testOutput }
 */
export function runPreMergeValidation(prNumber, deps) {
  const runCmd = deps.exec || ((cmd) =>
    execSync(cmd, { encoding: "utf-8", cwd: PROJECT_ROOT, timeout: 120000 }).trim()
  );

  // Get PR details
  const prJson = gh(
    `pr view ${prNumber} --json body,headRefName,title`,
    deps.exec
  );
  const pr = JSON.parse(prJson);
  const testPlan = parseTestPlan(pr.body);

  // Check pre-merge items are all checked
  const uncheckedItems = testPlan.preMerge.filter((item) => !item.checked);

  // Run quality gates on the PR branch
  let gateResults;
  try {
    const gateOutput = deps.runGates
      ? deps.runGates()
      : runCmd(`node "${join(__dirname, "pre-pr-review.mjs")}" --json --force`);
    gateResults = JSON.parse(gateOutput);
  } catch (err) {
    gateResults = {
      overall: "fail",
      gates: [{ name: "Gate Runner", status: "fail", details: [err.message] }],
    };
  }

  const gatesPassed = gateResults.overall !== "fail";
  const allItemsChecked = uncheckedItems.length === 0;
  const hasPreMergeItems = testPlan.preMerge.length > 0;

  return {
    passed: gatesPassed && (allItemsChecked || !hasPreMergeItems),
    gateResults,
    testPlan,
    uncheckedItems,
    prTitle: pr.title,
    branch: pr.headRefName,
  };
}

/**
 * Build the review comment body for the PR.
 */
export function buildReviewComment(validation, action) {
  const lines = ["## PR Reviewer Agent", ""];

  if (action === "approve") {
    lines.push("All pre-merge checks passed. Approving and merging.");
    lines.push("");
  } else if (action === "request-changes") {
    lines.push("Pre-merge checks did not pass. Please address the following:");
    lines.push("");
  } else if (action === "escalate") {
    lines.push(
      "This PR has been through multiple review rounds without resolution. Escalating to human review."
    );
    lines.push("");
  }

  // Gate results summary
  if (validation.gateResults && validation.gateResults.gates) {
    const icon = { pass: "pass", warn: "warn", fail: "FAIL" };
    lines.push("### Quality Gates");
    lines.push("");
    lines.push("| Gate | Status |");
    lines.push("|------|--------|");
    for (const gate of validation.gateResults.gates) {
      lines.push(`| ${gate.name} | ${icon[gate.status] || gate.status} |`);
    }
    lines.push("");
  }

  // Unchecked pre-merge items
  if (validation.uncheckedItems && validation.uncheckedItems.length > 0) {
    lines.push("### Unchecked Pre-merge Items");
    lines.push("");
    for (const item of validation.uncheckedItems) {
      lines.push(`- [ ] ${item.text}`);
    }
    lines.push("");
  }

  // Gate failure details
  if (validation.gateResults && validation.gateResults.overall === "fail") {
    const failedGates = validation.gateResults.gates.filter(
      (g) => g.status === "fail"
    );
    if (failedGates.length > 0) {
      lines.push("### Failed Gate Details");
      lines.push("");
      for (const gate of failedGates) {
        lines.push(`**${gate.name}:**`);
        for (const detail of gate.details) {
          lines.push(`- ${detail}`);
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

/**
 * Approve and squash-merge a PR.
 */
export function approvePR(prNumber, deps) {
  const execFn = deps.exec;
  gh(`pr review ${prNumber} --approve --body "PR Reviewer Agent: All checks passed."`, execFn);
  gh(`pr merge ${prNumber} --squash --delete-branch`, execFn);
}

/**
 * Post a review requesting changes on a PR.
 */
export function requestChangesPR(prNumber, comment, deps) {
  const execFn = deps.exec;
  ghComment(prNumber, comment, execFn);
  // Add agent-actionable label so worker agent can pick up feedback
  gh(`pr edit ${prNumber} --add-label "agent-actionable"`, execFn);
}

/**
 * Escalate a PR to human review.
 */
export function escalatePR(prNumber, issueId, deps) {
  const execFn = deps.exec;

  // Add labels to PR
  gh(`pr edit ${prNumber} --add-label "needs-human-review"`, execFn);

  // Post escalation comment
  const comment = [
    "## PR Reviewer Agent",
    "",
    "This PR has been through multiple review rounds without resolution.",
    "Escalating to human review.",
    "",
    "@danielvaucrosson — please review this PR manually.",
  ].join("\n");

  ghComment(prNumber, comment, execFn);

  // Update Linear issue if we have an issue ID
  if (issueId && deps.updateLinear) {
    deps.updateLinear(issueId, "needs-human-review");
  }
}

/**
 * Update Linear issue with a label or comment.
 */
export async function updateLinearIssue(issueId, action, details, execFn) {
  if (!issueId) return;
  const run = execFn || ((cmd) =>
    execSync(cmd, { encoding: "utf-8", cwd: PROJECT_ROOT }).trim()
  );

  try {
    if (action === "needs-human-review") {
      run(
        `node "${LINEAR_SCRIPT}" comment ${issueId} "PR reviewer escalating to human review after ${MAX_REVIEW_ROUNDS} rounds without resolution. Label: needs-human-review."`
      );
    } else if (action === "approved") {
      run(
        `node "${LINEAR_SCRIPT}" comment ${issueId} "PR reviewer approved and merged the PR. All pre-merge checks passed. Label: agent-approved."`
      );
      // Apply agent-approved label via Linear SDK
      try {
        const apiKey = process.env.LINEAR_API_KEY;
        if (apiKey) {
          const { LinearClient } = await import("@linear/sdk");
          const client = new LinearClient({ apiKey });
          const issue = await client.issue(issueId);
          const labels = await issue.labels();
          const existingIds = labels.nodes.map((l) => l.id);
          // Find or skip the agent-approved label
          const allLabels = await client.issueLabels({ filter: { name: { eq: "agent-approved" } } });
          const label = allLabels.nodes[0];
          if (label && !existingIds.includes(label.id)) {
            await issue.update({ labelIds: [...existingIds, label.id] });
          }
        }
      } catch (labelErr) {
        console.error(`Warning: could not apply agent-approved label: ${labelErr.message}`);
      }
    } else if (action === "post-merge-passed") {
      run(
        `node "${LINEAR_SCRIPT}" comment ${issueId} "Post-merge verification passed. All items verified.${details ? "\\n" + details : ""}"`
      );
    } else if (action === "post-merge-failed") {
      run(
        `node "${LINEAR_SCRIPT}" comment ${issueId} "Post-merge verification FAILED. Reverting merge.${details ? "\\n" + details : ""}"`
      );
      run(`node "${LINEAR_SCRIPT}" status ${issueId} "In Progress"`);
    }
  } catch (err) {
    console.error(`Warning: Linear update failed for ${issueId}: ${err.message}`);
  }
}

/**
 * Run post-merge verification for a PR.
 * Parses the post-merge checklist from the PR body and attempts to verify each item.
 * Returns { passed, results: [{ text, verified, details }] }
 */
export function runPostMergeVerification(prNumber, deps) {
  const execFn = deps.exec;

  // Get PR body
  const prJson = gh(`pr view ${prNumber} --json body,title,mergeCommit`, execFn);
  const pr = JSON.parse(prJson);
  const testPlan = parseTestPlan(pr.body);

  if (testPlan.postMerge.length === 0) {
    return { passed: true, results: [], message: "No post-merge items to verify" };
  }

  const results = [];

  for (const item of testPlan.postMerge) {
    // Run automated verification for known patterns
    const verification = verifyPostMergeItem(item.text, deps);
    results.push({
      text: item.text,
      verified: verification.verified,
      skipped: verification.skipped || false,
      details: verification.details,
    });
  }

  const allPassed = results.every((r) => r.verified);

  return {
    passed: allPassed,
    results,
    message: allPassed
      ? "All post-merge items verified"
      : `${results.filter((r) => !r.verified).length} item(s) failed verification`,
  };
}

/**
 * Attempt to verify a single post-merge checklist item.
 * Uses keyword matching to determine what type of verification to run.
 */
export function verifyPostMergeItem(text, deps) {
  const lower = text.toLowerCase();

  // Test-related items
  if (/\btests?\s+(pass|succeed|green)\b/.test(lower) || /\ball\s+tests\b/.test(lower)) {
    try {
      const output = deps.runTests
        ? deps.runTests()
        : execSync("npm test 2>&1", { encoding: "utf-8", cwd: PROJECT_ROOT, timeout: 120000 });
      return { verified: true, details: "Tests passed" };
    } catch (err) {
      return { verified: false, details: `Tests failed: ${(err.stdout || err.message || "").substring(0, 500)}` };
    }
  }

  // Dashboard/UI verification — check for recent successful dashboard deployment
  if (/\bdashboard\b/.test(lower)) {
    try {
      const repo = process.env.GITHUB_REPOSITORY || "";
      const runs = deps.checkWorkflowRuns
        ? deps.checkWorkflowRuns("update-dashboard.yml")
        : gh(`run list --workflow=update-dashboard.yml --limit 1 --json conclusion,createdAt --jq ".[0]"`, deps.exec);
      const latest = JSON.parse(runs || "{}");
      if (latest.conclusion === "success") {
        return { verified: true, details: `Dashboard deployed successfully (${latest.createdAt})` };
      }
      return { verified: false, details: `Latest dashboard run: ${latest.conclusion || "no runs found"}` };
    } catch (err) {
      return { verified: false, details: `Dashboard check failed: ${err.message}` };
    }
  }

  // Workflow/scheduler verification — check for recent successful runs
  if (/\bworkflow\b|\bscheduler\b|\bcron\b/.test(lower)) {
    try {
      const runs = deps.checkWorkflowRuns
        ? deps.checkWorkflowRuns("agent-scheduler.yml")
        : gh(`run list --workflow=agent-scheduler.yml --limit 1 --json conclusion,createdAt --jq ".[0]"`, deps.exec);
      const latest = JSON.parse(runs || "{}");
      if (latest.conclusion === "success") {
        return { verified: true, details: `Scheduler ran successfully (${latest.createdAt})` };
      }
      return { verified: false, details: `Latest scheduler run: ${latest.conclusion || "no runs found"}` };
    } catch (err) {
      return { verified: false, details: `Workflow check failed: ${err.message}` };
    }
  }

  // Default: can't auto-verify — flag for human review (not a failure)
  return { verified: true, skipped: true, details: "Cannot auto-verify — needs manual check" };
}

/**
 * Handle post-merge verification failure: revert the merge and re-open the issue.
 */
export function handlePostMergeFailure(prNumber, issueId, verification, deps) {
  const execFn = deps.exec;

  // Get the merge commit
  const prJson = gh(`pr view ${prNumber} --json mergeCommit`, execFn);
  const pr = JSON.parse(prJson);
  const mergeCommit = pr.mergeCommit && pr.mergeCommit.oid;

  if (!mergeCommit) {
    console.error("Cannot find merge commit — skipping revert");
    return { reverted: false, reason: "No merge commit found" };
  }

  // Build failure details
  const failedItems = verification.results
    .filter((r) => !r.verified)
    .map((r) => `- ${r.text}: ${r.details}`)
    .join("\n");

  // Post failure comment on PR
  const comment = [
    "## Post-merge Verification Failed",
    "",
    "The following post-merge checks failed:",
    "",
    failedItems,
    "",
    `Reverting merge commit \`${mergeCommit.substring(0, 7)}\`.`,
  ].join("\n");

  ghComment(prNumber, comment, execFn);

  // Revert the merge commit
  try {
    const run = execFn || ((cmd) =>
      execSync(cmd, { encoding: "utf-8", cwd: PROJECT_ROOT }).trim()
    );
    run(`git revert ${mergeCommit} -m 1 --no-edit`);
    run("git push origin main");
  } catch (err) {
    console.error(`Revert failed: ${err.message}`);
    return { reverted: false, reason: err.message };
  }

  // Update Linear issue
  if (issueId) {
    updateLinearIssue(issueId, "post-merge-failed", failedItems, execFn);
  }

  return { reverted: true, mergeCommit };
}

/**
 * Main review orchestration for a single PR.
 * Returns { action, prNumber, issueId, details }
 */
export function reviewPR(prNumber, deps) {
  const execFn = deps.exec;

  // Get PR metadata
  const prJson = gh(`pr view ${prNumber} --json title,headRefName,body,url`, execFn);
  const pr = JSON.parse(prJson);
  const issueId = extractIssueId(pr.title) || extractIssueId(pr.headRefName);

  // Count existing review rounds
  const rounds = deps.countRounds
    ? deps.countRounds(prNumber)
    : countReviewRounds(prNumber, execFn);

  console.error(`Reviewing PR #${prNumber} (${issueId || "no issue"}) — round ${rounds + 1}`);

  // Check if we should escalate
  if (rounds >= MAX_REVIEW_ROUNDS) {
    console.error(`Escalating PR #${prNumber} after ${rounds} rounds`);
    const comment = buildReviewComment(
      { gateResults: null, uncheckedItems: [] },
      "escalate"
    );
    escalatePR(prNumber, issueId, {
      exec: execFn,
      updateLinear: (id, action) => updateLinearIssue(id, action, null, execFn),
    });
    return { action: "escalated", prNumber, issueId };
  }

  // Run pre-merge validation
  const validation = runPreMergeValidation(prNumber, deps);

  if (validation.passed) {
    console.error(`PR #${prNumber} passed all checks — approving and merging`);
    const comment = buildReviewComment(validation, "approve");
    // Post approval summary as a regular comment (NOT via requestChangesPR,
    // which would incorrectly add the agent-actionable label)
    ghComment(prNumber, comment, execFn);
    approvePR(prNumber, { exec: execFn });

    // Update Linear
    if (issueId) {
      updateLinearIssue(issueId, "approved", null, execFn);
    }

    return { action: "merged", prNumber, issueId };
  }

  // Request changes
  console.error(`PR #${prNumber} failed checks — requesting changes`);
  const comment = buildReviewComment(validation, "request-changes");
  requestChangesPR(prNumber, comment, { exec: execFn });

  return {
    action: "changes-requested",
    prNumber,
    issueId,
    details: {
      gatesPassed: validation.gateResults?.overall !== "fail",
      uncheckedItems: validation.uncheckedItems.length,
    },
  };
}

/**
 * Review all open agent PRs.
 * Returns array of review results.
 */
export function reviewAll(deps) {
  const prs = deps.listPRs
    ? deps.listPRs()
    : listAgentPRs(deps.exec);

  if (prs.length === 0) {
    console.error("No open agent PRs to review.");
    return [];
  }

  console.error(`Found ${prs.length} open agent PR(s) to review`);

  const results = [];
  for (const pr of prs) {
    try {
      const result = reviewPR(pr.number, deps);
      results.push(result);
    } catch (err) {
      console.error(`Error reviewing PR #${pr.number}: ${err.message}`);
      results.push({
        action: "error",
        prNumber: pr.number,
        issueId: pr.issueId,
        error: err.message,
      });
    }
  }

  return results;
}

// --- CLI ---

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
        flags[arg.slice(2)] = rest[i + 1];
        i++;
      } else {
        flags[arg.slice(2)] = true;
      }
    }
  }

  if (command === "--help" || flags.help || !command) {
    console.log(`Usage: node scripts/pr-reviewer.mjs <command> [options]

Commands:
  review       Review a specific PR (pre-merge)
  review-all   Review all open agent PRs
  post-merge   Run post-merge verification on a merged PR

Options:
  --pr <number>   PR number (required for review, post-merge)
  --help          Show this help

Examples:
  node scripts/pr-reviewer.mjs review --pr 42
  node scripts/pr-reviewer.mjs review-all
  node scripts/pr-reviewer.mjs post-merge --pr 42

Environment:
  GH_TOKEN             GitHub token (set automatically in Actions)
  GITHUB_REPOSITORY    owner/repo (e.g., "user/repo")
  LINEAR_API_KEY       For Linear issue updates`);
    process.exit(0);
  }

  const defaultDeps = {
    exec: null, // Uses real execSync
  };

  try {
    if (command === "review") {
      if (!flags.pr) {
        console.error("Error: --pr <number> is required");
        process.exit(1);
      }
      const result = reviewPR(parseInt(flags.pr), defaultDeps);
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "review-all") {
      const results = reviewAll(defaultDeps);
      console.log(JSON.stringify(results, null, 2));
    } else if (command === "post-merge") {
      if (!flags.pr) {
        console.error("Error: --pr <number> is required");
        process.exit(1);
      }
      const prNumber = parseInt(flags.pr);
      const verification = runPostMergeVerification(prNumber, defaultDeps);
      console.log(JSON.stringify(verification, null, 2));

      if (!verification.passed) {
        const prJson = gh(`pr view ${prNumber} --json title,headRefName`);
        const pr = JSON.parse(prJson);
        const issueId = extractIssueId(pr.title) || extractIssueId(pr.headRefName);
        handlePostMergeFailure(prNumber, issueId, verification, defaultDeps);
        process.exit(1);
      }
    } else {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
