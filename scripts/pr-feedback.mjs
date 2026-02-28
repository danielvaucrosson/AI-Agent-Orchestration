/**
 * PR Feedback Loop utility.
 *
 * Collects review comments from a GitHub PR, generates a structured prompt
 * for an agent to address them, and posts replies after fixes are applied.
 *
 * Usage:
 *   node scripts/pr-feedback.mjs collect --pr <number> [--trigger <type>] [--output <file>]
 *   node scripts/pr-feedback.mjs prompt  --input <file> [--output <file>]
 *   node scripts/pr-feedback.mjs reply   --pr <number> --input <file>
 *   node scripts/pr-feedback.mjs summary --input <file>
 *
 * Environment:
 *   GH_TOKEN or GITHUB_TOKEN   GitHub token for API access (set automatically in Actions)
 *   GITHUB_REPOSITORY          owner/repo (e.g., "user/repo")
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Helpers ---

/**
 * Run a `gh` CLI command and return stdout as a string.
 */
function gh(args, opts = {}) {
  const cmd = `gh ${args}`;
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
      ...opts,
    }).trim();
  } catch (err) {
    const stderr = err.stderr || "";
    throw new Error(`gh command failed: ${cmd}\n${stderr}`);
  }
}

/**
 * Parse command-line flags into a map.
 * Supports: --flag value, --flag=value
 */
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags[arg.slice(2)] = argv[i + 1];
        i++;
      } else {
        flags[arg.slice(2)] = true;
      }
    }
  }
  return flags;
}

/**
 * Categorize a review comment for agent processing.
 * Returns a priority level and category tag.
 */
export function categorizeComment(body) {
  const lower = (body || "").toLowerCase();

  // Bug / error indicators
  if (/\b(bug|error|crash|broken|incorrect|wrong|fail)\b/.test(lower)) {
    return { priority: "high", category: "bug" };
  }

  // Security concerns (prefix match — vulnerab* matches vulnerability, inject* matches injection)
  if (/\b(security|vulnerab|inject|xss|csrf|auth|secret|credential)/i.test(lower)) {
    return { priority: "high", category: "security" };
  }

  // Direct request to change something
  if (/\b(please|should|must|need to|change|fix|update|rename|move|remove|add|replace)\b/.test(lower)) {
    return { priority: "medium", category: "change-request" };
  }

  // Question or suggestion
  if (/\b(why|how|consider|suggest|maybe|could|might|what if|opinion)\b/.test(lower)) {
    return { priority: "low", category: "suggestion" };
  }

  // Style / formatting
  if (/\b(style|format|indent|spacing|naming|typo|nit|minor)\b/.test(lower)) {
    return { priority: "low", category: "style" };
  }

  return { priority: "medium", category: "general" };
}

/**
 * Determine if a comment is out-of-scope or non-actionable.
 */
export function isNonActionable(body) {
  const lower = (body || "").toLowerCase().trim();

  // Very short or empty
  if (lower.length < 5) return true;

  // Pure praise / acknowledgment
  if (/^(lgtm|looks good|nice|great|awesome|👍|✅|💯|🎉)\s*!?\s*$/.test(lower)) return true;

  // "Resolved" or "done" markers
  if (/^(resolved|done|fixed|addressed)\s*\.?\s*$/.test(lower)) return true;

  return false;
}

// --- Commands ---

/**
 * Collect all unresolved review comments from a PR.
 */
export function collectComments(prNumber, triggerType, repoOverride) {
  const repo = repoOverride || process.env.GITHUB_REPOSITORY || "";
  if (!repo) throw new Error("GITHUB_REPOSITORY not set");

  // Fetch PR review comments (on specific lines of code)
  const reviewCommentsRaw = gh(
    `api repos/${repo}/pulls/${prNumber}/comments --paginate`
  );
  const reviewComments = JSON.parse(reviewCommentsRaw || "[]");

  // Fetch PR reviews (overall review bodies)
  const reviewsRaw = gh(
    `api repos/${repo}/pulls/${prNumber}/reviews --paginate`
  );
  const reviews = JSON.parse(reviewsRaw || "[]");

  // Fetch general issue comments (for /agent fix commands)
  const issueCommentsRaw = gh(
    `api repos/${repo}/issues/${prNumber}/comments --paginate`
  );
  const issueComments = JSON.parse(issueCommentsRaw || "[]");

  // Parse review comments (inline on code)
  const comments = [];

  for (const rc of reviewComments) {
    // Skip resolved / outdated comments
    if (rc.position === null && rc.original_position === null) continue;

    const body = (rc.body || "").trim();
    if (!body || isNonActionable(body)) continue;

    const { priority, category } = categorizeComment(body);
    comments.push({
      id: rc.id,
      type: "review_comment",
      path: rc.path || "",
      line: rc.line || rc.original_line || null,
      side: rc.side || "RIGHT",
      diff_hunk: rc.diff_hunk || "",
      body,
      author: rc.user?.login || "unknown",
      created_at: rc.created_at,
      priority,
      category,
      in_reply_to_id: rc.in_reply_to_id || null,
    });
  }

  // Parse review bodies (overall review summaries)
  for (const review of reviews) {
    const body = (review.body || "").trim();
    if (!body || isNonActionable(body)) continue;
    if (review.state === "APPROVED" || review.state === "DISMISSED") continue;

    const { priority, category } = categorizeComment(body);
    comments.push({
      id: review.id,
      type: "review_body",
      path: "",
      line: null,
      side: null,
      diff_hunk: "",
      body,
      author: review.user?.login || "unknown",
      created_at: review.submitted_at,
      priority,
      category,
      review_state: review.state,
    });
  }

  // Only include issue comments if triggered by /agent fix command
  if (triggerType === "command") {
    for (const ic of issueComments) {
      const body = (ic.body || "").trim();
      if (!body.startsWith("/agent fix") && !body.startsWith("/agent-fix")) continue;

      // Extract any additional instructions after the command
      const instructions = body.replace(/^\/agent[\s-]fix\s*/i, "").trim();
      if (instructions) {
        comments.push({
          id: ic.id,
          type: "agent_command",
          path: "",
          line: null,
          side: null,
          diff_hunk: "",
          body: instructions,
          author: ic.user?.login || "unknown",
          created_at: ic.created_at,
          priority: "high",
          category: "command",
        });
      }
    }
  }

  // Sort by priority (high > medium > low), then by file path
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  comments.sort((a, b) => {
    const pd = (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1);
    if (pd !== 0) return pd;
    return (a.path || "").localeCompare(b.path || "");
  });

  return {
    pr_number: prNumber,
    repo,
    trigger_type: triggerType || "review",
    collected_at: new Date().toISOString(),
    total_review_comments: reviewComments.length,
    total_reviews: reviews.length,
    total_issue_comments: issueComments.length,
    comments,
  };
}

/**
 * Generate a structured agent prompt from collected feedback.
 */
export function generatePrompt(feedbackData) {
  const { comments, pr_number, repo } = feedbackData;

  if (comments.length === 0) {
    return `# PR #${pr_number} Feedback\n\nNo actionable review comments found. The PR looks good!\n`;
  }

  const lines = [
    `# PR #${pr_number} Review Feedback`,
    ``,
    `You are addressing review feedback on PR #${pr_number} in \`${repo}\`.`,
    `There are **${comments.length} actionable comment(s)** to address.`,
    ``,
    `## Instructions`,
    ``,
    `For each comment below:`,
    `1. Read the reviewer's feedback carefully`,
    `2. If it's a code change request, make the fix in the referenced file/line`,
    `3. If it's a question, add a code comment or documentation to clarify`,
    `4. If the request is out of scope or conflicts with another comment, note why`,
    `5. After addressing all comments, commit and push your changes`,
    ``,
    `## Review Comments`,
    ``,
  ];

  let idx = 1;
  for (const c of comments) {
    lines.push(`### Comment ${idx} — [${c.priority.toUpperCase()}] ${c.category}`);
    lines.push(``);

    if (c.author) lines.push(`**Reviewer:** @${c.author}`);
    if (c.path) lines.push(`**File:** \`${c.path}\`${c.line ? ` (line ${c.line})` : ""}`);
    if (c.review_state) lines.push(`**Review state:** ${c.review_state}`);
    lines.push(``);

    if (c.diff_hunk) {
      lines.push(`**Code context:**`);
      lines.push("```diff");
      lines.push(c.diff_hunk);
      lines.push("```");
      lines.push(``);
    }

    lines.push(`**Feedback:**`);
    lines.push(`> ${c.body.split("\n").join("\n> ")}`);
    lines.push(``);

    if (c.type === "review_comment" && c.id) {
      lines.push(`_Reply to this comment after addressing: comment ID ${c.id}_`);
      lines.push(``);
    }

    lines.push(`---`);
    lines.push(``);
    idx++;
  }

  lines.push(`## After Addressing All Comments`);
  lines.push(``);
  lines.push(`1. Commit your changes with a message like: \`fix: address PR #${pr_number} review feedback\``);
  lines.push(`2. Push to the current branch`);
  lines.push(`3. Reply to each review comment explaining what was changed`);
  lines.push(``);

  return lines.join("\n");
}

/**
 * Generate a summary of collected comments (for logging / display).
 */
export function generateSummary(feedbackData) {
  const { comments, pr_number, repo, collected_at } = feedbackData;

  const lines = [
    `PR #${pr_number} Feedback Summary (${repo})`,
    `Collected: ${collected_at}`,
    `Total actionable comments: ${comments.length}`,
    ``,
  ];

  // Count by category
  const categories = {};
  const priorities = { high: 0, medium: 0, low: 0 };
  for (const c of comments) {
    categories[c.category] = (categories[c.category] || 0) + 1;
    priorities[c.priority] = (priorities[c.priority] || 0) + 1;
  }

  lines.push(`By priority: high=${priorities.high} medium=${priorities.medium} low=${priorities.low}`);
  lines.push(`By category: ${Object.entries(categories).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  lines.push(``);

  // Affected files
  const files = new Set(comments.filter((c) => c.path).map((c) => c.path));
  if (files.size > 0) {
    lines.push(`Affected files (${files.size}):`);
    for (const f of files) lines.push(`  ${f}`);
  }

  return lines.join("\n");
}

/**
 * Post replies to review comments after fixes are applied.
 */
function replyToComments(prNumber, feedbackData, replyMap) {
  const repo = feedbackData.repo || process.env.GITHUB_REPOSITORY || "";
  if (!repo) throw new Error("GITHUB_REPOSITORY not set");

  let replied = 0;
  let skipped = 0;

  for (const comment of feedbackData.comments) {
    if (comment.type !== "review_comment" || !comment.id) {
      skipped++;
      continue;
    }

    const replyBody = replyMap[comment.id] ||
      `Addressed in the latest commit. The ${comment.category} feedback on \`${comment.path}\` has been resolved.`;

    try {
      gh(
        `api repos/${repo}/pulls/${prNumber}/comments \
         -f body="${replyBody.replace(/"/g, '\\"')}" \
         -F in_reply_to=${comment.id}`
      );
      replied++;
    } catch (err) {
      console.error(`Failed to reply to comment ${comment.id}: ${err.message}`);
      skipped++;
    }
  }

  console.log(`Replied to ${replied} comments (${skipped} skipped)`);
}

// --- CLI ---

// Only run CLI when executed directly (not when imported as a module)
import { pathToFileURL } from "node:url";
const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  const commands = {
    collect: () => {
      const prNumber = flags.pr;
      if (!prNumber) {
        console.error("Error: --pr <number> is required");
        process.exit(1);
      }

      const data = collectComments(prNumber, flags.trigger || "review", flags.repo);
      const json = JSON.stringify(data, null, 2);

      if (flags.output) {
        writeFileSync(flags.output, json, "utf-8");
        console.log(`Collected ${data.comments.length} actionable comments -> ${flags.output}`);
      } else {
        console.log(json);
      }
    },

    prompt: () => {
      const inputPath = flags.input;
      if (!inputPath || !existsSync(inputPath)) {
        console.error("Error: --input <file> is required (JSON from collect step)");
        process.exit(1);
      }

      const data = JSON.parse(readFileSync(inputPath, "utf-8"));
      const prompt = generatePrompt(data);

      if (flags.output) {
        writeFileSync(flags.output, prompt, "utf-8");
        console.log(`Prompt written to ${flags.output}`);
      } else {
        console.log(prompt);
      }
    },

    reply: () => {
      const prNumber = flags.pr;
      const inputPath = flags.input;
      if (!prNumber || !inputPath) {
        console.error("Error: --pr <number> and --input <file> are required");
        process.exit(1);
      }

      const data = JSON.parse(readFileSync(inputPath, "utf-8"));
      const replyMap = flags["reply-map"]
        ? JSON.parse(readFileSync(flags["reply-map"], "utf-8"))
        : {};

      replyToComments(prNumber, data, replyMap);
    },

    summary: () => {
      const inputPath = flags.input;
      if (!inputPath || !existsSync(inputPath)) {
        console.error("Error: --input <file> is required");
        process.exit(1);
      }

      const data = JSON.parse(readFileSync(inputPath, "utf-8"));
      console.log(generateSummary(data));
    },
  };

  if (!command || !commands[command]) {
    console.log(`Usage: node scripts/pr-feedback.mjs <command> [options]

Commands:
  collect   Fetch review comments from a PR
  prompt    Generate an agent prompt from collected feedback
  reply     Post replies to review comments after fixes
  summary   Display a summary of collected feedback

Options:
  --pr <number>       PR number (required for collect, reply)
  --trigger <type>    Trigger type: "review" or "command" (default: review)
  --input <file>      Input JSON file (from collect step)
  --output <file>     Output file path (default: stdout)
  --repo <owner/repo> Override GITHUB_REPOSITORY
  --reply-map <file>  JSON map of comment IDs to reply bodies

Examples:
  node scripts/pr-feedback.mjs collect --pr 7 --output /tmp/feedback.json
  node scripts/pr-feedback.mjs prompt --input /tmp/feedback.json
  node scripts/pr-feedback.mjs summary --input /tmp/feedback.json
  node scripts/pr-feedback.mjs reply --pr 7 --input /tmp/feedback.json

Environment:
  GH_TOKEN             GitHub token (set automatically in Actions)
  GITHUB_REPOSITORY    owner/repo (e.g., "user/repo")`);
    process.exit(command ? 1 : 0);
  }

  try {
    await commands[command]();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
