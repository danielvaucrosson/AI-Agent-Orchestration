/**
 * Claude Code "PreToolUse" hook.
 *
 * Automatically logs every tool invocation to the audit trail before it runs.
 * This hook is non-blocking — it always allows the tool to proceed.
 *
 * Input (stdin):  JSON with { tool_name, tool_input }
 * Output (stdout): nothing (exit 0 = allow)
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AUDIT_DIR = join(__dirname, "..", "audit");
const LOG_PATH = join(AUDIT_DIR, "current.jsonl");

// Tools to skip logging (noisy internal tools that clutter the audit trail)
const SKIP_TOOLS = new Set([
  "TodoRead",
  "TodoWrite",
]);

/**
 * Summarize tool input — extract the most meaningful piece of info per tool.
 */
function summarizeInput(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";

  switch (toolName) {
    case "Read":
      return toolInput.file_path ? basename(toolInput.file_path) : "";
    case "Write":
      return toolInput.file_path ? basename(toolInput.file_path) : "";
    case "Edit":
      return toolInput.file_path ? basename(toolInput.file_path) : "";
    case "Bash":
      return toolInput.command ? truncate(toolInput.command, 120) : "";
    case "Glob":
      return toolInput.pattern || "";
    case "Grep":
      return toolInput.pattern ? `/${toolInput.pattern}/` : "";
    case "Task":
      return truncate(toolInput.description || toolInput.prompt || "", 80);
    case "WebFetch":
      return toolInput.url || "";
    case "WebSearch":
      return toolInput.query || "";
    default:
      // MCP / other tools — try common field names
      return (
        toolInput.id ||
        toolInput.issueId ||
        toolInput.query ||
        toolInput.title ||
        ""
      );
  }
}

function basename(filePath) {
  return filePath.split(/[/\\]/).pop() || filePath;
}

function truncate(str, maxLen) {
  if (!str) return "";
  return str.length > maxLen ? str.slice(0, maxLen - 3) + "..." : str;
}

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

try {
  const input = await readStdin();
  const data = JSON.parse(input);

  const toolName = data.tool_name || "unknown";

  // Skip noisy tools
  if (SKIP_TOOLS.has(toolName)) {
    process.exit(0);
  }

  // Ensure audit dir exists
  if (!existsSync(AUDIT_DIR)) {
    mkdirSync(AUDIT_DIR, { recursive: true });
  }

  // Auto-initialize session if no log exists yet
  if (!existsSync(LOG_PATH)) {
    const initEntry = JSON.stringify({
      ts: new Date().toISOString(),
      type: "session_start",
      branch: "auto",
      issueId: "",
    });
    appendFileSync(LOG_PATH, initEntry + "\n", "utf8");
  }

  const entry = {
    ts: new Date().toISOString(),
    type: "tool_start",
    tool: toolName,
    summary: summarizeInput(toolName, data.tool_input),
  };

  appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
} catch {
  // Never block the agent if the hook fails
}

// Always allow — exit silently
process.exit(0);
