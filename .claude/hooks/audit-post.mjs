/**
 * Claude Code "PostToolUse" hook.
 *
 * Logs tool completion (success or failure) to the audit trail after a tool runs.
 * This hook is non-blocking — it always allows the agent to continue.
 *
 * Input (stdin):  JSON with { tool_name, tool_input, tool_output }
 * Output (stdout): nothing (exit 0 = allow)
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const AUDIT_DIR = join(__dirname, "..", "audit");
const LOG_PATH = join(AUDIT_DIR, "current.jsonl");

// Tools to skip logging (must match audit-pre.mjs SKIP_TOOLS)
const SKIP_TOOLS = new Set([
  "TodoRead",
  "TodoWrite",
]);

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

/**
 * Detect whether the tool output indicates an error.
 */
function detectError(toolName, toolOutput) {
  if (!toolOutput) return { success: true };

  const output =
    typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput);

  // Common error indicators
  if (
    output.includes("Error:") ||
    output.includes("error:") ||
    output.includes("FAILED") ||
    output.includes("Exit code")
  ) {
    // Extract a short error message (first line containing "error")
    const errorLine = output
      .split("\n")
      .find(
        (l) =>
          /error|failed|exit code/i.test(l),
      );
    return {
      success: false,
      error: errorLine
        ? errorLine.trim().slice(0, 200)
        : "Tool reported an error",
    };
  }

  return { success: true };
}

try {
  const input = await readStdin();
  const data = JSON.parse(input);

  const toolName = data.tool_name || "unknown";

  // Skip noisy tools
  if (SKIP_TOOLS.has(toolName)) {
    process.exit(0);
  }

  // Only log if audit dir and log file exist (session was started)
  if (!existsSync(LOG_PATH)) {
    process.exit(0);
  }

  const { success, error } = detectError(toolName, data.tool_output);

  const entry = {
    ts: new Date().toISOString(),
    type: "tool_end",
    tool: toolName,
    success,
  };

  if (error) {
    entry.error = error;
  }

  appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
} catch {
  // Never block the agent if the hook fails
}

// Always allow — exit silently
process.exit(0);
