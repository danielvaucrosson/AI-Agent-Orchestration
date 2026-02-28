/**
 * Claude Code "Stop" hook.
 *
 * Runs when the agent is about to finish. If the current branch is linked to
 * a Linear issue and the agent hasn't mentioned updating Linear, it blocks
 * and reminds the agent to update the issue status and post a summary comment.
 *
 * Also checks whether the task is incomplete and, if so, reminds the agent
 * to generate a handoff document for session continuity.
 *
 * Input (stdin): JSON with { stop_hook_active, last_assistant_message, ... }
 * Output (stdout): JSON with { decision, reason } to block, or nothing to allow.
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getBranch, extractIssueId } from "./linear-helpers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HANDOFFS_DIR = join(__dirname, "..", "handoffs");
const AUDIT_LOG = join(__dirname, "..", "audit", "current.jsonl");

// Patterns that indicate the agent already updated Linear this turn
const UPDATED_PATTERNS = [
  /linear\.mjs\s+(status|comment|link-pr)/i,
  /update[d]?\s+(the\s+)?linear/i,
  /move[d]?\s+.*\s+to\s+(in progress|in review|done|backlog|todo)/i,
  /post(ed)?\s+(a\s+)?comment\s+(on|to)\s+(the\s+)?linear/i,
  /\bupdate_issue\b/i,
  /\bcreate_comment\b/i,
];

// Patterns that indicate the task was completed (PR created, merged, etc.)
const COMPLETED_PATTERNS = [
  /\bpr\s+(created|opened|merged)\b/i,
  /\bpull\s+request\s+(created|opened|merged)\b/i,
  /\bgh\s+pr\s+create\b/i,
  /\bmove[d]?\s+.*\s+to\s+(done|in review)\b/i,
  /\btask\s+(is\s+)?complete[d]?\b/i,
  /\bwork\s+(is\s+)?done\b/i,
  /\ball\s+acceptance\s+criteria\s+(are\s+)?met\b/i,
];

// Patterns that indicate a handoff was already created
const HANDOFF_PATTERNS = [
  /\bhandoff\b.*\b(creat|writ|generat|sav)/i,
  /\bhandoff\.mjs\b/i,
  /\.claude\/handoffs\//i,
  /\bhandoff\s+document\b/i,
  /\bsession\s+handoff\b/i,
];

// Patterns that indicate the audit trail was already exported/attached
const AUDIT_PATTERNS = [
  /\baudit\.mjs\s+(export|attach|summary)\b/i,
  /\baudit\s+trail\s+(export|attach|post)/i,
  /\baudit\s+log\s+(export|attach|post)/i,
  /\bposted?\s+audit/i,
];

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

function handoffExists(issueId) {
  const normalized = issueId.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  const path = join(HANDOFFS_DIR, `${normalized}.md`);
  return existsSync(path);
}

try {
  const input = await readStdin();
  const data = JSON.parse(input);

  // Prevent infinite loops — if the hook already fired once, let the agent finish
  if (data.stop_hook_active) {
    process.exit(0);
  }

  const branch = getBranch();
  const issueId = extractIssueId(branch);

  // No Linear issue on this branch — nothing to do
  if (!issueId) {
    process.exit(0);
  }

  const lastMsg = data.last_assistant_message || "";

  // Check if the agent already mentioned updating Linear
  const alreadyUpdated = UPDATED_PATTERNS.some((re) => re.test(lastMsg));

  // Check if the task appears complete
  const taskComplete = COMPLETED_PATTERNS.some((re) => re.test(lastMsg));

  // Check if a handoff was already generated
  const handoffDone =
    HANDOFF_PATTERNS.some((re) => re.test(lastMsg)) || handoffExists(issueId);

  // Build reminders as needed
  const reminders = [];

  if (!alreadyUpdated) {
    reminders.push(
      `You are working on Linear issue ${issueId}.`,
      `Before finishing, please update Linear:`,
      `1. Update the issue status if appropriate using the Linear MCP update_issue tool (set state to "In Progress", "In Review", or "Done")`,
      `2. Post a summary comment using the Linear MCP create_comment tool describing what was accomplished`,
      `If MCP tools are unavailable, use the CLI fallback:`,
      `   LINEAR_API_KEY="$LINEAR_API_KEY" node scripts/linear.mjs status ${issueId} "In Progress"`,
      `   LINEAR_API_KEY="$LINEAR_API_KEY" node scripts/linear.mjs comment ${issueId} "<summary of work done>"`,
    );
  }

  if (!taskComplete && !handoffDone) {
    reminders.push(
      ``,
      `The task for ${issueId} appears incomplete. Please generate a handoff document:`,
      `1. Write a handoff file to .claude/handoffs/${issueId}.md following the template in .claude/handoff-template.md`,
      `2. Include: current state, files changed, decisions made, blockers, and next steps`,
      `3. Post the handoff summary as a Linear comment so the next agent can find it`,
      `This ensures the next agent can resume your work seamlessly.`,
    );
  }

  // Check if an audit log exists and hasn't been exported yet
  const auditLogExists = existsSync(AUDIT_LOG);
  const auditExported = AUDIT_PATTERNS.some((re) => re.test(lastMsg));

  if (auditLogExists && !auditExported && taskComplete) {
    reminders.push(
      ``,
      `An audit trail was recorded for this session (.claude/audit/current.jsonl).`,
      `Before finishing, please export and attach it:`,
      `1. Run: node scripts/audit.mjs export   (to preview the trail)`,
      `2. After creating the PR, run: node scripts/audit.mjs attach <pr-number>`,
      `This posts the audit trail as a PR comment so reviewers can trace your work.`,
    );
  }

  if (reminders.length === 0) {
    process.exit(0);
  }

  const result = {
    decision: "block",
    reason: reminders.join("\n"),
  };

  console.log(JSON.stringify(result));
} catch (err) {
  // If the hook itself fails, don't block the agent — just let it finish
  console.error(`check-linear-update hook error: ${err.message}`);
  process.exit(0);
}
