/**
 * Scheduler logic for automated agent task pickup.
 *
 * Handles rate limiting, task selection (with retry filtering),
 * and output for the GitHub Actions scheduler workflow.
 *
 * Usage:
 *   node scripts/agent-scheduler.mjs next [--max-daily N] [--team DVA]
 *   node scripts/agent-scheduler.mjs --help
 */

import { execSync } from "node:child_process";
import { existsSync, appendFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Check if dispatching another agent run is allowed under the rate limit.
 *
 * Caller is responsible for passing only runs from the last 24 hours.
 * This function counts them and compares against the limit.
 *
 * @param {object[]} runs - Recent workflow runs from GitHub API
 *   (each has `created_at` and `conclusion`)
 * @param {number} maxDaily - Maximum allowed runs per 24 hours
 * @returns {{ allowed: boolean, currentCount: number, maxDaily: number }}
 */
export function checkRateLimit(runs, maxDaily) {
  const currentCount = runs.length;
  return {
    allowed: currentCount < maxDaily,
    currentCount,
    maxDaily,
  };
}

/**
 * Parse the retry count from an issue's comments.
 * Looks for structured markers like `[agent-retry: N]`.
 *
 * @param {object[]} comments - Array of comment objects with `body` string
 * @returns {number} The highest retry count found, or 0
 */
export function parseRetryCount(comments) {
  let maxRetry = 0;
  const pattern = /\[agent-retry:\s*(\d+)\]/;
  for (const comment of comments) {
    const match = comment.body.match(pattern);
    if (match) {
      const count = parseInt(match[1], 10);
      if (count > maxRetry) maxRetry = count;
    }
  }
  return maxRetry;
}

/**
 * Filter task list to issues suitable for automated pickup.
 * - Only "Todo" status (not Backlog — those aren't ready)
 * - Exclude issues with `agent-failed` label and retry count >= maxRetries
 *
 * @param {object[]} tasks - Ordered list of task objects (from task-ordering.mjs)
 * @param {Object<string, object[]>} commentsMap - Map of identifier -> comments array
 * @param {number} [maxRetries=2] - Maximum retry attempts before skipping
 * @returns {object[]} Filtered and ordered tasks
 */
export function filterForScheduler(tasks, commentsMap = {}, maxRetries = 2) {
  return tasks.filter((task) => {
    // Skip archived issues — they shouldn't be picked up for work
    if (task.archivedAt) return false;

    if (task.statusLower !== "todo") return false;

    const hasFailedLabel = (task.labels || []).includes("agent-failed");
    if (hasFailedLabel) {
      const comments = commentsMap[task.identifier] || [];
      const retryCount = parseRetryCount(comments);
      if (retryCount >= maxRetries) return false;
    }

    return true;
  });
}

/**
 * Write a key=value pair to GitHub Actions output.
 * Falls back to console.log if not running in Actions.
 *
 * @param {string} key - Output variable name
 * @param {string} value - Output value
 */
export function setOutput(key, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile && existsSync(outputFile)) {
    appendFileSync(outputFile, `${key}=${value}\n`);
  }
  console.log(`${key}=${value}`);
}

/**
 * Fetch recent agent-worker workflow runs from GitHub API.
 * Uses `gh` CLI which is pre-authenticated in GitHub Actions.
 *
 * @param {string} workflowFile - Workflow filename (e.g., "agent-worker.yml")
 * @returns {object[]} Array of workflow run objects
 */
export function fetchRecentRuns(workflowFile) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const output = execSync(
      `gh api "/repos/{owner}/{repo}/actions/workflows/${workflowFile}/runs?created=>${since}&per_page=100"`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    const data = JSON.parse(output);
    return data.workflow_runs || [];
  } catch {
    // If workflow doesn't exist yet or gh not available, no runs
    return [];
  }
}

/**
 * Fetch comments for a Linear issue using the @linear/sdk.
 * Returns array of { body } objects.
 *
 * @param {string} identifier - Issue identifier (e.g., "DVA-5")
 * @returns {Promise<object[]>} Comment objects with `body` field
 */
async function fetchIssueComments(identifier) {
  try {
    const { LinearClient } = await import("@linear/sdk");
    const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
    const issue = await client.issue(identifier);
    const comments = await issue.comments();
    return comments.nodes.map((c) => ({ body: c.body }));
  } catch (err) {
    console.warn(`Warning: could not fetch comments for ${identifier}: ${err.message}`);
    return [];
  }
}

// --- CLI ---

function parseArgs(argv) {
  const args = { command: null, maxDaily: 2, team: "DVA", issueId: null, handoffMsg: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-daily" && argv[i + 1]) {
      args.maxDaily = parseInt(argv[i + 1], 10);
      i++;
    } else if (argv[i] === "--team" && argv[i + 1]) {
      args.team = argv[i + 1];
      i++;
    } else if (argv[i] === "--help") {
      args.command = "help";
    } else if (!args.command) {
      args.command = argv[i];
    } else if (args.command === "handle-failure" && !args.issueId) {
      args.issueId = argv[i];
    } else if (args.command === "handle-failure" && !args.handoffMsg) {
      args.handoffMsg = argv[i];
    }
  }
  return args;
}

// ESM-safe main guard — matches project pattern (see task-ordering.mjs)
const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help" || !args.command) {
    console.log(`Usage: node scripts/agent-scheduler.mjs <command> [options]

Commands:
  next              Select the next task for automated pickup
  handle-failure    Handle agent worker failure (retry count, label, comment)

Options:
  --max-daily N   Maximum agent runs per 24h (default: 2)
  --team TEAM     Linear team key (default: DVA)
  --help          Show this help

Examples:
  node scripts/agent-scheduler.mjs next --max-daily 2 --team DVA
  node scripts/agent-scheduler.mjs handle-failure DVA-19 "Handoff exists"

Outputs (for GitHub Actions):
  task=none|<issue-id>
  task_title=<title>
  task_url=<url>`);
    process.exit(args.command === "help" ? 0 : 1);
  }

  if (args.command === "next") {
    try {
      // 1. Check rate limit
      const runs = fetchRecentRuns("agent-worker.yml");
      const rateCheck = checkRateLimit(runs, args.maxDaily);

      if (!rateCheck.allowed) {
        console.log(
          `Rate limit reached: ${rateCheck.currentCount}/${rateCheck.maxDaily} runs in last 24h`
        );
        setOutput("task", "none");
        process.exit(0);
      }

      console.log(
        `Rate limit OK: ${rateCheck.currentCount}/${rateCheck.maxDaily} runs in last 24h`
      );

      // 2. Get ordered tasks from task-ordering.mjs
      const taskOutput = execSync(
        `node scripts/task-ordering.mjs next --team ${args.team} --json`,
        { encoding: "utf8", cwd: process.cwd() }
      );
      const taskResult = JSON.parse(taskOutput);

      if (!taskResult.task) {
        console.log("No actionable tasks found");
        setOutput("task", "none");
        process.exit(0);
      }

      // 3. Apply scheduler filter (Todo-only + failed-task exclusion)
      const task = taskResult.task;
      const commentsMap = {};
      const hasFailedLabel = (task.labels || []).includes("agent-failed");

      if (hasFailedLabel) {
        const comments = await fetchIssueComments(task.identifier);
        commentsMap[task.identifier] = comments;
      }

      const eligible = filterForScheduler([task], commentsMap);

      if (eligible.length === 0) {
        console.log(
          `Skipping ${task.identifier}: not eligible (status: ${task.status}, failed-label: ${hasFailedLabel})`
        );
        setOutput("task", "none");
        process.exit(0);
      }

      // 4. Output selected task
      const selected = eligible[0];
      console.log(`Selected task: ${selected.identifier} — ${selected.title}`);
      setOutput("task", selected.identifier);
      setOutput("task_title", selected.title);
      setOutput("task_url", selected.url || "");
    } catch (err) {
      console.error(`Error: ${err.message}`);
      setOutput("task", "none");
      process.exit(1);
    }
  }

  if (args.command === "handle-failure") {
    const issueId = args.issueId;
    const handoffMsg = args.handoffMsg || "";

    if (!issueId) {
      console.error("Error: issue ID is required for handle-failure");
      process.exit(1);
    }

    try {
      const { LinearClient } = await import("@linear/sdk");
      const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
      const issue = await client.issue(issueId);

      // 1. Read existing retry count from comments
      const comments = await issue.comments();
      const commentBodies = comments.nodes.map((c) => ({ body: c.body }));
      const prevCount = parseRetryCount(commentBodies);
      const retryCount = prevCount + 1;

      // 2. Apply agent-failed label (create if needed)
      const labels = await issue.labels();
      if (!labels.nodes.find((l) => l.name === "agent-failed")) {
        const team = await issue.team;
        const teamLabels = await team.labels();
        let label = teamLabels.nodes.find((l) => l.name === "agent-failed");
        if (!label) {
          const payload = await client.createIssueLabel({
            name: "agent-failed",
            teamId: team.id,
            color: "#ef4444",
          });
          label = await payload.issueLabel;
        }
        const currentLabelIds = labels.nodes.map((l) => l.id);
        await issue.update({ labelIds: [...currentLabelIds, label.id] });
      }
      console.log(`Label agent-failed applied to ${issueId}`);

      // 3. Post retry comment
      await client.createComment({
        issueId: issue.id,
        body: `[agent-retry: ${retryCount}] Automated agent run failed (attempt ${retryCount}). ${handoffMsg}.`,
      });
      console.log(`Posted retry comment (attempt ${retryCount}) to ${issueId}`);
    } catch (err) {
      console.error(`Error handling failure: ${err.message}`);
      process.exit(1);
    }
  }
}
