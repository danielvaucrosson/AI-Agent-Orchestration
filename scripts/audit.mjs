/**
 * Audit trail CLI utility for agent sessions.
 *
 * Manages structured audit logs that capture agent actions during a task
 * session. Logs are stored as JSONL and can be exported as Markdown
 * summaries attached to PRs.
 *
 * Usage: node scripts/audit.mjs <command> [args]
 *
 * Commands:
 *   init                     Start a new audit session
 *   log <category> <message> Add a manual log entry
 *   summary                  Print summary stats to stdout
 *   export [file]            Export full audit trail as Markdown
 *   attach <pr-number>       Post audit summary as a PR comment
 *   clear                    Remove current session log
 */

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const AUDIT_DIR = join(PROJECT_ROOT, ".claude", "audit");
const LOG_PATH = join(AUDIT_DIR, "current.jsonl");

// --- Helpers ---

function ensureDir() {
  if (!existsSync(AUDIT_DIR)) {
    mkdirSync(AUDIT_DIR, { recursive: true });
  }
}

function appendEntry(entry) {
  ensureDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(LOG_PATH, line + "\n", "utf8");
}

function readLog() {
  if (!existsSync(LOG_PATH)) return [];
  const lines = readFileSync(LOG_PATH, "utf8").trim().split("\n");
  return lines.filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function getBranchName() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function getIssueId(branch) {
  const match = branch.match(/\b([A-Z]{1,5}-\d+)\b/);
  return match ? match[1] : "";
}

/**
 * Summarize tool input for the log based on tool type.
 * Keeps entries concise by extracting the most relevant info.
 */
export function summarizeToolInput(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";

  switch (toolName) {
    case "Read":
      return toolInput.file_path
        ? basename(toolInput.file_path)
        : "";

    case "Write":
      return toolInput.file_path
        ? basename(toolInput.file_path)
        : "";

    case "Edit":
      return toolInput.file_path
        ? basename(toolInput.file_path)
        : "";

    case "Bash":
      return toolInput.command
        ? truncate(toolInput.command, 120)
        : "";

    case "Glob":
      return toolInput.pattern || "";

    case "Grep":
      return toolInput.pattern
        ? `/${toolInput.pattern}/`
        : "";

    case "Task":
      return toolInput.description || toolInput.prompt
        ? truncate(toolInput.description || toolInput.prompt, 80)
        : "";

    case "WebFetch":
    case "WebSearch":
      return toolInput.url || toolInput.query || "";

    default:
      // For MCP tools and others, try common field names
      return toolInput.id
        || toolInput.issueId
        || toolInput.query
        || toolInput.title
        || "";
  }
}

function truncate(str, maxLen) {
  if (!str) return "";
  return str.length > maxLen ? str.slice(0, maxLen - 3) + "..." : str;
}

// --- Stats / Summary ---

function computeStats(entries) {
  const stats = {
    sessionStart: null,
    sessionEnd: null,
    toolCounts: {},
    categories: {},
    filesRead: new Set(),
    filesEdited: new Set(),
    commandsRun: 0,
    errors: [],
    decisions: [],
    totalTools: 0,
  };

  for (const entry of entries) {
    if (!stats.sessionStart || entry.ts < stats.sessionStart) {
      stats.sessionStart = entry.ts;
    }
    if (!stats.sessionEnd || entry.ts > stats.sessionEnd) {
      stats.sessionEnd = entry.ts;
    }

    switch (entry.type) {
      case "tool_start":
        stats.totalTools++;
        stats.toolCounts[entry.tool] = (stats.toolCounts[entry.tool] || 0) + 1;
        if (entry.tool === "Read" && entry.summary) {
          stats.filesRead.add(entry.summary);
        }
        if ((entry.tool === "Edit" || entry.tool === "Write") && entry.summary) {
          stats.filesEdited.add(entry.summary);
        }
        if (entry.tool === "Bash") {
          stats.commandsRun++;
        }
        break;

      case "tool_end":
        if (!entry.success) {
          stats.errors.push({
            ts: entry.ts,
            tool: entry.tool,
            error: entry.error || "Unknown error",
          });
        }
        break;

      case "decision":
        stats.decisions.push({
          ts: entry.ts,
          message: entry.message,
        });
        break;

      case "error":
        stats.errors.push({
          ts: entry.ts,
          tool: entry.tool || "system",
          error: entry.message || entry.error || "Unknown error",
        });
        break;

      case "manual":
        const cat = entry.category || "other";
        stats.categories[cat] = (stats.categories[cat] || 0) + 1;
        break;
    }
  }

  return stats;
}

function formatDuration(startISO, endISO) {
  if (!startISO || !endISO) return "unknown";
  const ms = new Date(endISO) - new Date(startISO);
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "<1 min";
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hrs}h ${rem}m`;
}

function formatTime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  return d.toISOString().slice(11, 16); // HH:MM
}

// --- Export ---

function generateMarkdown(entries, branch, issueId) {
  const stats = computeStats(entries);
  const duration = formatDuration(stats.sessionStart, stats.sessionEnd);

  const lines = [];

  // Header
  lines.push(`# Audit Trail${issueId ? ` — ${issueId}` : ""}`);
  lines.push("");
  lines.push(
    `**Session:** ${stats.sessionStart ? stats.sessionStart.slice(0, 16) : "?"} → ${stats.sessionEnd ? stats.sessionEnd.slice(0, 16) : "?"} (${duration})`,
  );
  lines.push(`**Branch:** \`${branch}\``);
  lines.push("");

  // Quick Stats
  lines.push("## Quick Stats");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("|--------|-------|");
  lines.push(`| Tool invocations | ${stats.totalTools} |`);
  lines.push(`| Files read | ${stats.filesRead.size} |`);
  lines.push(`| Files edited | ${stats.filesEdited.size} |`);
  lines.push(`| Commands run | ${stats.commandsRun} |`);
  lines.push(`| Errors | ${stats.errors.length} |`);
  lines.push(`| Duration | ${duration} |`);
  lines.push("");

  // Tool breakdown
  const toolEntries = Object.entries(stats.toolCounts).sort(
    (a, b) => b[1] - a[1],
  );
  if (toolEntries.length > 0) {
    lines.push("## Tool Usage");
    lines.push("");
    lines.push("| Tool | Count |");
    lines.push("|------|-------|");
    for (const [tool, count] of toolEntries) {
      lines.push(`| ${tool} | ${count} |`);
    }
    lines.push("");
  }

  // Timeline (condensed — group repetitive actions)
  lines.push("## Timeline");
  lines.push("");
  lines.push("| Time | Category | Description |");
  lines.push("|------|----------|-------------|");

  const timelineEntries = entries.filter(
    (e) => e.type !== "tool_end" || !e.success,
  );
  let lastTool = null;
  let repeatCount = 0;

  for (let i = 0; i < timelineEntries.length; i++) {
    const entry = timelineEntries[i];
    const time = formatTime(entry.ts);

    if (entry.type === "tool_start") {
      // Look ahead for repeats of the same tool
      const next = timelineEntries[i + 1];
      if (
        next &&
        next.type === "tool_start" &&
        next.tool === entry.tool &&
        lastTool === entry.tool
      ) {
        repeatCount++;
        continue;
      }

      if (repeatCount > 0 && lastTool === entry.tool) {
        lines.push(
          `| ${time} | ${entry.tool} | ... and ${repeatCount + 1} more ${entry.tool} calls |`,
        );
        repeatCount = 0;
      } else {
        const desc = entry.summary ? `${entry.summary}` : "";
        lines.push(`| ${time} | ${entry.tool} | ${desc} |`);
      }
      lastTool = entry.tool;
    } else if (entry.type === "tool_end" && !entry.success) {
      lines.push(
        `| ${time} | ERROR | ${entry.tool}: ${truncate(entry.error || "failed", 80)} |`,
      );
      lastTool = null;
      repeatCount = 0;
    } else if (entry.type === "decision") {
      lines.push(
        `| ${time} | decision | ${truncate(entry.message, 100)} |`,
      );
      lastTool = null;
      repeatCount = 0;
    } else if (entry.type === "manual") {
      lines.push(
        `| ${time} | ${entry.category || "note"} | ${truncate(entry.message, 100)} |`,
      );
      lastTool = null;
      repeatCount = 0;
    } else if (entry.type === "session_start") {
      lines.push(`| ${time} | session | Session started |`);
      lastTool = null;
      repeatCount = 0;
    }
  }
  lines.push("");

  // Decisions
  if (stats.decisions.length > 0) {
    lines.push("## Decisions");
    lines.push("");
    for (const d of stats.decisions) {
      lines.push(`- **${formatTime(d.ts)}:** ${d.message}`);
    }
    lines.push("");
  }

  // Errors
  if (stats.errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const e of stats.errors) {
      lines.push(`- **${formatTime(e.ts)}** \`${e.tool}\`: ${e.error}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// --- Commands ---

function cmdInit() {
  ensureDir();
  // Clear any existing log
  if (existsSync(LOG_PATH)) {
    unlinkSync(LOG_PATH);
  }
  const branch = getBranchName();
  const issueId = getIssueId(branch);
  appendEntry({
    type: "session_start",
    branch,
    issueId,
  });
  console.log(`Audit session started. Log: ${LOG_PATH}`);
  if (issueId) console.log(`Issue: ${issueId}`);
}

function cmdLog(category, ...messageParts) {
  if (!category) {
    console.error("Usage: node scripts/audit.mjs log <category> <message>");
    process.exit(1);
  }
  const message = messageParts.join(" ");
  if (!message) {
    console.error("Usage: node scripts/audit.mjs log <category> <message>");
    process.exit(1);
  }
  appendEntry({ type: "manual", category, message });
  console.log(`Logged [${category}]: ${message}`);
}

function cmdSummary() {
  const entries = readLog();
  if (entries.length === 0) {
    console.log("No audit log found. Run `init` to start a session.");
    return;
  }
  const stats = computeStats(entries);
  const duration = formatDuration(stats.sessionStart, stats.sessionEnd);

  console.log("=== Audit Summary ===");
  console.log(`Duration: ${duration}`);
  console.log(`Tool invocations: ${stats.totalTools}`);
  console.log(`Files read: ${stats.filesRead.size}`);
  console.log(`Files edited: ${stats.filesEdited.size}`);
  console.log(`Commands run: ${stats.commandsRun}`);
  console.log(`Errors: ${stats.errors.length}`);
  console.log(`Decisions: ${stats.decisions.length}`);

  if (Object.keys(stats.toolCounts).length > 0) {
    console.log("\nTool breakdown:");
    for (const [tool, count] of Object.entries(stats.toolCounts).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`  ${tool}: ${count}`);
    }
  }
}

function cmdExport(outputFile) {
  const entries = readLog();
  if (entries.length === 0) {
    console.error("No audit log found. Run `init` to start a session.");
    process.exit(1);
  }

  const branch = getBranchName();
  const issueId = getIssueId(branch);
  const md = generateMarkdown(entries, branch, issueId);

  if (outputFile) {
    writeFileSync(outputFile, md, "utf8");
    console.log(`Audit trail exported to: ${outputFile}`);
  } else {
    console.log(md);
  }
}

function cmdAttach(prNumber) {
  if (!prNumber) {
    console.error("Usage: node scripts/audit.mjs attach <pr-number>");
    process.exit(1);
  }

  const entries = readLog();
  if (entries.length === 0) {
    console.error("No audit log found. Run `init` to start a session.");
    process.exit(1);
  }

  const branch = getBranchName();
  const issueId = getIssueId(branch);
  const md = generateMarkdown(entries, branch, issueId);

  // Wrap in a details/summary to keep PR comments tidy
  const comment = [
    "## Agent Audit Trail",
    "",
    "<details>",
    `<summary>Audit log — ${entries.length} entries, ${computeStats(entries).errors.length} errors</summary>`,
    "",
    md,
    "",
    "</details>",
  ].join("\n");

  try {
    // Write comment body to a temp file to avoid shell escaping issues
    const tmpFile = join(AUDIT_DIR, "_pr-comment.md");
    writeFileSync(tmpFile, comment, "utf8");

    execSync(`gh pr comment ${prNumber} --body-file "${tmpFile}"`, {
      encoding: "utf-8",
      stdio: "inherit",
      cwd: PROJECT_ROOT,
    });

    // Clean up temp file
    unlinkSync(tmpFile);
    console.log(`Audit trail posted to PR #${prNumber}`);
  } catch (err) {
    console.error(`Failed to attach audit trail: ${err.message}`);
    console.error("Make sure gh CLI is installed and authenticated.");
    process.exit(1);
  }
}

function cmdClear() {
  if (existsSync(LOG_PATH)) {
    unlinkSync(LOG_PATH);
    console.log("Audit log cleared.");
  } else {
    console.log("No audit log to clear.");
  }
}

// --- CLI ---

const [command, ...args] = process.argv.slice(2);

const commands = {
  init: () => cmdInit(),
  log: () => cmdLog(args[0], ...args.slice(1)),
  summary: () => cmdSummary(),
  export: () => cmdExport(args[0]),
  attach: () => cmdAttach(args[0]),
  clear: () => cmdClear(),
};

if (!command || !commands[command]) {
  console.log(`Usage: node scripts/audit.mjs <command> [args]

Commands:
  init                     Start a new audit session (clears previous log)
  log <category> <message> Add a manual log entry (e.g., decision, note, blocker)
  summary                  Print summary stats to stdout
  export [file]            Export full audit trail as Markdown (stdout or file)
  attach <pr-number>       Post audit trail as a PR comment via gh CLI
  clear                    Remove current session log

Examples:
  node scripts/audit.mjs init
  node scripts/audit.mjs log decision "Chose JSONL format for better append performance"
  node scripts/audit.mjs log blocker "Test suite requires Node 20+ but CI uses 18"
  node scripts/audit.mjs summary
  node scripts/audit.mjs export audit-trail.md
  node scripts/audit.mjs attach 5

The audit log is stored at .claude/audit/current.jsonl and is auto-populated
by PreToolUse and PostToolUse hooks. Use 'log' for manual entries like
decisions, notes, or blockers that hooks can't capture automatically.`);
  process.exit(command ? 1 : 0);
}

try {
  await commands[command]();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
