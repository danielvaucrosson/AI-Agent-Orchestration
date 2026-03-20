/**
 * Failure Pattern Detection — analyzes historical agent audit trails to
 * identify recurring failure patterns and generate actionable recommendations.
 *
 * Usage: node scripts/failure-patterns.mjs <command> [options]
 *
 * Commands:
 *   analyze [dir]           Parse audit trails and categorize failures
 *   report  [dir]           Generate a Markdown report with recommendations
 *   categories              List all failure categories and their patterns
 *   generate-synthetic [n]  Generate n synthetic audit sessions for testing
 *
 * Options:
 *   --json                  Output analyze results as JSON
 *   --output <file>         Write report to a file instead of stdout
 *
 * Dependencies: Agent Audit Trail (DVA-11), Agent Performance Dashboard (DVA-21)
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const AUDIT_DIR = join(PROJECT_ROOT, ".claude", "audit");
const DEFAULT_LOG = join(AUDIT_DIR, "current.jsonl");

// ---------------------------------------------------------------------------
// Failure Categories
// ---------------------------------------------------------------------------

/**
 * Each category has a name, description, and an array of regex patterns
 * that match against the error message from audit trail entries.
 */
export const FAILURE_CATEGORIES = [
  {
    id: "test-failure",
    name: "Test Failure",
    description: "Test suite failures, assertion errors, test runner crashes",
    patterns: [
      /\btest.*fail/i,
      /\bassert(ion)?.*fail/i,
      /\bnpm test.*fail/i,
      /\btest.*error/i,
      /\bexpect(ed)?.*to (be|equal|match|throw)/i,
      /\bfailing tests?\b/i,
      /\b\d+ fail(ed|ing)?\b/i,
    ],
  },
  {
    id: "lint-error",
    name: "Lint / Format Error",
    description: "ESLint, Prettier, or other linting/formatting failures",
    patterns: [
      /\blint(er|ing)?.*error/i,
      /\beslint/i,
      /\bprettier/i,
      /\bformatting/i,
      /\bsyntax error/i,
      /\bparse error/i,
      /\bunexpected token/i,
      /\bindentation/i,
    ],
  },
  {
    id: "merge-conflict",
    name: "Merge Conflict",
    description: "Git merge conflicts, rebase failures, branch issues",
    patterns: [
      /\bmerge conflict/i,
      /\bconflict.*merge/i,
      /\brebase.*fail/i,
      /\bCONFLICT.*Merge/i,
      /\bgit.*conflict/i,
      /\bautomatic merge failed/i,
    ],
  },
  {
    id: "api-error",
    name: "API / Network Error",
    description: "Linear API errors, GitHub API failures, network timeouts",
    patterns: [
      /\bapi.*error/i,
      /\b(4\d{2}|5\d{2})\b.*\b(error|fail|status)/i,
      /\bfetch.*fail/i,
      /\bnetwork.*error/i,
      /\bECONNREFUSED/i,
      /\bETIMEDOUT/i,
      /\brate limit/i,
      /\blinear.*error/i,
      /\bgithub.*error/i,
      /\bunauthorized/i,
      /\bforbidden/i,
    ],
  },
  {
    id: "timeout",
    name: "Timeout",
    description: "Command timeouts, process hangs, unresponsive operations",
    patterns: [
      /\btimeout/i,
      /\btimed?\s*out/i,
      /\bcommand.*timeout/i,
      /\bprocess.*kill/i,
      /\bhang(ed|ing|s)?\b/i,
    ],
  },
  {
    id: "wrong-approach",
    name: "Wrong Approach",
    description:
      "File not found, wrong path, missing dependency, configuration errors",
    patterns: [
      /\bno such file/i,
      /\bfile not found/i,
      /\bmodule not found/i,
      /\bcannot find/i,
      /\bENOENT/i,
      /\bcommand not found/i,
      /\bundefined.*is not/i,
      /\bnot a function/i,
      /\bimport.*error/i,
      /\brequire.*error/i,
      /\bmissing.*dependency/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// Parsing — read JSONL audit trails
// ---------------------------------------------------------------------------

/**
 * Parse a single JSONL file into an array of audit entries.
 */
export function parseAuditFile(filePath) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Load all .jsonl files from a directory as separate sessions.
 * Returns an array of { file, issueId, entries } objects.
 */
export function loadSessions(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  return files.map((f) => {
    const entries = parseAuditFile(join(dir, f));
    const start = entries.find((e) => e.type === "session_start");
    return {
      file: f,
      issueId: start?.issueId || extractIssueId(f),
      branch: start?.branch || "",
      entries,
    };
  });
}

function extractIssueId(filename) {
  const match = filename.match(/\b([A-Z]{1,5}-\d+)\b/);
  return match ? match[1] : "";
}

// ---------------------------------------------------------------------------
// Categorization
// ---------------------------------------------------------------------------

/**
 * Categorize a single error message into a failure category.
 * Returns the category id, or "uncategorized" if no pattern matches.
 */
export function categorizeError(errorMessage) {
  if (!errorMessage) return "uncategorized";
  for (const cat of FAILURE_CATEGORIES) {
    for (const pattern of cat.patterns) {
      if (pattern.test(errorMessage)) {
        return cat.id;
      }
    }
  }
  return "uncategorized";
}

/**
 * Extract all failures from a list of audit entries.
 * A failure is a tool_end with success=false, or an error-type entry.
 */
export function extractFailures(entries) {
  const failures = [];
  for (const entry of entries) {
    if (entry.type === "tool_end" && entry.success === false) {
      failures.push({
        ts: entry.ts,
        tool: entry.tool || "unknown",
        error: entry.error || "Unknown error",
        category: categorizeError(entry.error),
      });
    } else if (entry.type === "error") {
      failures.push({
        ts: entry.ts,
        tool: entry.tool || "system",
        error: entry.message || entry.error || "Unknown error",
        category: categorizeError(entry.message || entry.error),
      });
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Pattern Analysis
// ---------------------------------------------------------------------------

/**
 * Analyze multiple sessions and compute pattern statistics.
 */
export function analyzePatterns(sessions) {
  const allFailures = [];
  const sessionStats = [];

  for (const session of sessions) {
    const failures = extractFailures(session.entries);
    const toolStarts = session.entries.filter((e) => e.type === "tool_start");
    const totalTools = toolStarts.length;

    sessionStats.push({
      file: session.file,
      issueId: session.issueId,
      totalTools,
      totalFailures: failures.length,
      failureRate: totalTools > 0 ? failures.length / totalTools : 0,
      categories: countBy(failures, "category"),
    });

    for (const f of failures) {
      allFailures.push({ ...f, issueId: session.issueId, file: session.file });
    }
  }

  // Category breakdown
  const categoryBreakdown = {};
  for (const cat of FAILURE_CATEGORIES) {
    const matching = allFailures.filter((f) => f.category === cat.id);
    categoryBreakdown[cat.id] = {
      name: cat.name,
      count: matching.length,
      percentage:
        allFailures.length > 0
          ? ((matching.length / allFailures.length) * 100).toFixed(1)
          : "0.0",
      tools: countBy(matching, "tool"),
      issues: [...new Set(matching.map((f) => f.issueId).filter(Boolean))],
    };
  }
  const uncategorized = allFailures.filter(
    (f) => f.category === "uncategorized",
  );
  categoryBreakdown.uncategorized = {
    name: "Uncategorized",
    count: uncategorized.length,
    percentage:
      allFailures.length > 0
        ? ((uncategorized.length / allFailures.length) * 100).toFixed(1)
        : "0.0",
    tools: countBy(uncategorized, "tool"),
    issues: [...new Set(uncategorized.map((f) => f.issueId).filter(Boolean))],
  };

  // Error-prone files (from tool_start summaries preceding failures)
  const errorProneFiles = computeErrorProneFiles(sessions);

  // Top 3 failure modes
  const topFailureModes = Object.entries(categoryBreakdown)
    .filter(([id]) => id !== "uncategorized")
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)
    .map(([id, data]) => ({ id, ...data }));

  return {
    totalSessions: sessions.length,
    totalFailures: allFailures.length,
    categoryBreakdown,
    topFailureModes,
    errorProneFiles,
    sessionStats,
    allFailures,
  };
}

/**
 * Identify files that appear in tool_start entries shortly before failures.
 * Returns files sorted by failure correlation count.
 */
export function computeErrorProneFiles(sessions) {
  const fileCounts = {};

  for (const session of sessions) {
    const entries = session.entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (
        entry.type === "tool_end" &&
        entry.success === false
      ) {
        // Look back up to 5 entries for associated file references
        for (let j = Math.max(0, i - 5); j < i; j++) {
          const prev = entries[j];
          if (
            prev.type === "tool_start" &&
            prev.summary &&
            /\.\w+$/.test(prev.summary)
          ) {
            fileCounts[prev.summary] = (fileCounts[prev.summary] || 0) + 1;
          }
        }
      }
    }
  }

  return Object.entries(fileCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, count]) => ({ file, failureCorrelation: count }));
}

function countBy(arr, key) {
  const counts = {};
  for (const item of arr) {
    const val = item[key] || "unknown";
    counts[val] = (counts[val] || 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

/**
 * Generate actionable recommendations based on pattern analysis results.
 */
export function generateRecommendations(analysis) {
  const recs = [];

  for (const mode of analysis.topFailureModes) {
    if (mode.count === 0) continue;

    switch (mode.id) {
      case "test-failure":
        recs.push({
          priority: "high",
          category: mode.name,
          finding: `Test failures account for ${mode.percentage}% of all failures (${mode.count} occurrences).`,
          recommendation:
            "Consider adding pre-flight test checks before making changes. " +
            "Add common test patterns and gotchas to CLAUDE.md so agents " +
            "understand the test setup before modifying code.",
        });
        break;

      case "lint-error":
        recs.push({
          priority: "medium",
          category: mode.name,
          finding: `Lint/format errors account for ${mode.percentage}% of failures (${mode.count} occurrences).`,
          recommendation:
            "Add auto-formatting hooks (e.g., prettier --write on save) or " +
            "document the project's lint configuration in CLAUDE.md. " +
            "Agents should run the linter before committing.",
        });
        break;

      case "merge-conflict":
        recs.push({
          priority: "high",
          category: mode.name,
          finding: `Merge conflicts account for ${mode.percentage}% of failures (${mode.count} occurrences).`,
          recommendation:
            "Use git worktrees for parallel agent work to avoid conflicts. " +
            "Run conflict-detect.mjs before starting work on shared files.",
        });
        break;

      case "api-error":
        recs.push({
          priority: "medium",
          category: mode.name,
          finding: `API errors account for ${mode.percentage}% of failures (${mode.count} occurrences).`,
          recommendation:
            "Add retry logic for transient API failures. Check rate limits " +
            "and ensure API keys are properly configured in the environment.",
        });
        break;

      case "timeout":
        recs.push({
          priority: "medium",
          category: mode.name,
          finding: `Timeouts account for ${mode.percentage}% of failures (${mode.count} occurrences).`,
          recommendation:
            "Increase timeout limits for known long-running operations. " +
            "Add progress indicators and break large operations into steps.",
        });
        break;

      case "wrong-approach":
        recs.push({
          priority: "high",
          category: mode.name,
          finding: `Wrong approach errors account for ${mode.percentage}% of failures (${mode.count} occurrences).`,
          recommendation:
            "Add project structure documentation to CLAUDE.md (key file paths, " +
            "module organization). Agents should read the codebase structure " +
            "before making assumptions about file locations.",
        });
        break;
    }
  }

  // Error-prone file recommendations
  if (analysis.errorProneFiles.length > 0) {
    const topFiles = analysis.errorProneFiles.slice(0, 3);
    const fileList = topFiles
      .map((f) => `\`${f.file}\` (${f.failureCorrelation} failures)`)
      .join(", ");
    recs.push({
      priority: "medium",
      category: "Error-Prone Files",
      finding: `Files most correlated with failures: ${fileList}.`,
      recommendation:
        "Add extra context for these files in CLAUDE.md — document their " +
        "purpose, common pitfalls, and required patterns. Consider whether " +
        "these files need refactoring to reduce complexity.",
    });
  }

  // High failure rate sessions
  const highFailureSessions = analysis.sessionStats.filter(
    (s) => s.failureRate > 0.2 && s.totalTools > 5,
  );
  if (highFailureSessions.length > 0) {
    const issues = highFailureSessions.map((s) => s.issueId).filter(Boolean);
    recs.push({
      priority: "low",
      category: "High-Failure Sessions",
      finding: `${highFailureSessions.length} session(s) had >20% failure rate${issues.length > 0 ? ` (${issues.join(", ")})` : ""}.`,
      recommendation:
        "Review these sessions for systemic issues — the tasks may need " +
        "better specification or the affected code areas may need documentation.",
    });
  }

  return recs;
}

// ---------------------------------------------------------------------------
// Report Generation
// ---------------------------------------------------------------------------

/**
 * Generate a full Markdown report from analysis results.
 */
export function generateReport(analysis) {
  const recs = generateRecommendations(analysis);
  const lines = [];

  lines.push("# Failure Pattern Detection Report");
  lines.push("");
  lines.push(
    `> Generated: ${new Date().toISOString().slice(0, 16)} | Sessions analyzed: ${analysis.totalSessions} | Total failures: ${analysis.totalFailures}`,
  );
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  if (analysis.totalFailures === 0) {
    lines.push(
      "No failures detected across analyzed sessions. The agents are operating cleanly.",
    );
  } else {
    lines.push(
      `Analyzed **${analysis.totalSessions}** agent sessions and found **${analysis.totalFailures}** failures across **${analysis.topFailureModes.filter((m) => m.count > 0).length}** categories.`,
    );
  }
  lines.push("");

  // Top Failure Modes
  if (analysis.topFailureModes.length > 0) {
    lines.push("## Top Failure Modes");
    lines.push("");
    lines.push("| # | Category | Count | % of Total |");
    lines.push("|---|----------|-------|------------|");
    analysis.topFailureModes.forEach((mode, i) => {
      lines.push(
        `| ${i + 1} | ${mode.name} | ${mode.count} | ${mode.percentage}% |`,
      );
    });
    lines.push("");
  }

  // Category Breakdown
  lines.push("## Category Breakdown");
  lines.push("");
  lines.push("| Category | Count | % | Tools Affected |");
  lines.push("|----------|-------|---|----------------|");
  for (const [id, data] of Object.entries(analysis.categoryBreakdown)) {
    if (data.count === 0) continue;
    const tools = Object.entries(data.tools)
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${t}(${c})`)
      .join(", ");
    lines.push(`| ${data.name} | ${data.count} | ${data.percentage}% | ${tools} |`);
  }
  lines.push("");

  // Error-Prone Files
  if (analysis.errorProneFiles.length > 0) {
    lines.push("## Error-Prone Files");
    lines.push("");
    lines.push("| File | Failure Correlation |");
    lines.push("|------|---------------------|");
    for (const f of analysis.errorProneFiles) {
      lines.push(`| \`${f.file}\` | ${f.failureCorrelation} |`);
    }
    lines.push("");
  }

  // Recommendations
  if (recs.length > 0) {
    lines.push("## Recommendations");
    lines.push("");
    for (const rec of recs) {
      const icon =
        rec.priority === "high"
          ? "[HIGH]"
          : rec.priority === "medium"
            ? "[MED]"
            : "[LOW]";
      lines.push(`### ${icon} ${rec.category}`);
      lines.push("");
      lines.push(`**Finding:** ${rec.finding}`);
      lines.push("");
      lines.push(`**Recommendation:** ${rec.recommendation}`);
      lines.push("");
    }
  }

  // Session Details
  if (analysis.sessionStats.length > 0) {
    lines.push("## Session Details");
    lines.push("");
    lines.push("| Session | Issue | Tools | Failures | Rate |");
    lines.push("|---------|-------|-------|----------|------|");
    for (const s of analysis.sessionStats) {
      const rate = (s.failureRate * 100).toFixed(1);
      lines.push(
        `| ${s.file} | ${s.issueId || "—"} | ${s.totalTools} | ${s.totalFailures} | ${rate}% |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Synthetic Data Generator
// ---------------------------------------------------------------------------

const SAMPLE_TOOLS = ["Read", "Write", "Edit", "Bash", "Grep", "Glob"];
const SAMPLE_FILES = [
  "index.mjs",
  "auth.mjs",
  "api.mjs",
  "config.mjs",
  "utils.mjs",
  "router.mjs",
  "middleware.mjs",
  "database.mjs",
  "schema.mjs",
  "handlers.mjs",
];
const SAMPLE_ERRORS = [
  { msg: "Error: test suite failed\nExit code 1", cat: "test-failure" },
  {
    msg: "AssertionError: expected true to be false",
    cat: "test-failure",
  },
  { msg: "Error: 3 failing tests", cat: "test-failure" },
  { msg: "eslint: 5 errors found", cat: "lint-error" },
  { msg: "SyntaxError: Unexpected token '}'", cat: "lint-error" },
  { msg: "prettier: formatting check failed", cat: "lint-error" },
  { msg: "CONFLICT (content): Merge conflict in src/api.mjs", cat: "merge-conflict" },
  { msg: "error: automatic merge failed", cat: "merge-conflict" },
  { msg: "Error: Linear API returned 429 rate limit exceeded", cat: "api-error" },
  { msg: "Error: fetch failed ECONNREFUSED", cat: "api-error" },
  { msg: "Error: GitHub API 403 Forbidden", cat: "api-error" },
  { msg: "Error: command timeout after 120000ms", cat: "timeout" },
  { msg: "Error: process timed out", cat: "timeout" },
  { msg: "Error: ENOENT: no such file or directory, open 'src/missing.mjs'", cat: "wrong-approach" },
  { msg: "Error: Cannot find module './nonexistent'", cat: "wrong-approach" },
  { msg: "TypeError: undefined is not a function", cat: "wrong-approach" },
];

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

/**
 * Generate synthetic audit session data for testing.
 * Uses a seeded PRNG for deterministic output.
 */
export function generateSyntheticSessions(count, seed = 42) {
  const rand = seededRandom(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const sessions = [];

  for (let i = 0; i < count; i++) {
    const issueId = `DVA-${100 + i}`;
    const branch = `feature/${issueId}-synthetic-task-${i}`;
    const baseTime = new Date("2026-03-01T10:00:00Z").getTime() + i * 3600000;
    const entries = [];
    let time = baseTime;

    // Session start
    entries.push({
      ts: new Date(time).toISOString(),
      type: "session_start",
      branch,
      issueId,
    });
    time += 1000;

    // Generate 20-80 tool invocations per session
    const toolCount = 20 + Math.floor(rand() * 60);
    const failureChance = 0.05 + rand() * 0.2; // 5-25% failure rate

    for (let t = 0; t < toolCount; t++) {
      const tool = pick(SAMPLE_TOOLS);
      const file = pick(SAMPLE_FILES);
      const summary =
        tool === "Bash"
          ? pick(["npm test", "git status", "node scripts/audit.mjs summary"])
          : file;

      // tool_start
      entries.push({
        ts: new Date(time).toISOString(),
        type: "tool_start",
        tool,
        summary,
      });
      time += 500 + Math.floor(rand() * 5000);

      // tool_end — sometimes fails
      if (rand() < failureChance) {
        const err = pick(SAMPLE_ERRORS);
        entries.push({
          ts: new Date(time).toISOString(),
          type: "tool_end",
          tool,
          success: false,
          error: err.msg,
        });
      } else {
        entries.push({
          ts: new Date(time).toISOString(),
          type: "tool_end",
          tool,
          success: true,
        });
      }
      time += 200;
    }

    sessions.push({ file: `session-${issueId}.jsonl`, issueId, branch, entries });
  }

  return sessions;
}

/**
 * Write synthetic sessions to a directory as JSONL files.
 */
export function writeSyntheticSessions(dir, sessions) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const session of sessions) {
    const lines = session.entries.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(join(dir, session.file), lines + "\n", "utf8");
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function cmdAnalyze(dir, asJson) {
  const sessions = loadSessionsFromDirOrDefault(dir);
  if (sessions.length === 0) {
    console.error("No audit sessions found. Provide a directory or generate synthetic data.");
    process.exit(1);
  }

  const analysis = analyzePatterns(sessions);

  if (asJson) {
    // Strip allFailures for cleaner JSON output
    const { allFailures, ...rest } = analysis;
    console.log(JSON.stringify(rest, null, 2));
  } else {
    console.log(`Sessions: ${analysis.totalSessions}`);
    console.log(`Total failures: ${analysis.totalFailures}`);
    console.log("");
    console.log("Top failure modes:");
    for (const mode of analysis.topFailureModes) {
      console.log(`  ${mode.name}: ${mode.count} (${mode.percentage}%)`);
    }
    if (analysis.errorProneFiles.length > 0) {
      console.log("");
      console.log("Error-prone files:");
      for (const f of analysis.errorProneFiles.slice(0, 5)) {
        console.log(`  ${f.file}: ${f.failureCorrelation} failures`);
      }
    }
  }
}

function cmdReport(dir, outputFile) {
  const sessions = loadSessionsFromDirOrDefault(dir);
  if (sessions.length === 0) {
    console.error("No audit sessions found. Provide a directory or generate synthetic data.");
    process.exit(1);
  }

  const analysis = analyzePatterns(sessions);
  const report = generateReport(analysis);

  if (outputFile) {
    writeFileSync(outputFile, report, "utf8");
    console.log(`Report written to: ${outputFile}`);
  } else {
    console.log(report);
  }
}

function cmdCategories() {
  console.log("Failure Categories:");
  console.log("");
  for (const cat of FAILURE_CATEGORIES) {
    console.log(`  ${cat.id}`);
    console.log(`    ${cat.name}: ${cat.description}`);
    console.log(`    Patterns: ${cat.patterns.length} regex rules`);
    console.log("");
  }
}

function cmdGenerateSynthetic(count) {
  const n = parseInt(count, 10) || 12;
  const dir = join(AUDIT_DIR, "synthetic");
  const sessions = generateSyntheticSessions(n);
  writeSyntheticSessions(dir, sessions);
  console.log(`Generated ${n} synthetic sessions in: ${dir}`);
}

function loadSessionsFromDirOrDefault(dir) {
  if (dir && existsSync(dir)) {
    return loadSessions(dir);
  }
  // Fall back to current audit log as a single session
  if (existsSync(DEFAULT_LOG)) {
    const entries = parseAuditFile(DEFAULT_LOG);
    const start = entries.find((e) => e.type === "session_start");
    return [
      {
        file: "current.jsonl",
        issueId: start?.issueId || "",
        branch: start?.branch || "",
        entries,
      },
    ];
  }
  return [];
}

// --- CLI entry point (only runs when executed directly) ---

const isMainModule =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

if (isMainModule) {
  const args = process.argv.slice(2);
  const command = args[0];
  const jsonFlag = args.includes("--json");
  const outputIdx = args.indexOf("--output");
  const outputFile = outputIdx >= 0 ? args[outputIdx + 1] : null;

  function findDirArg() {
    for (let i = 1; i < args.length; i++) {
      if (!args[i].startsWith("--")) return args[i];
    }
    return null;
  }

  const commands = {
    analyze: () => cmdAnalyze(findDirArg(), jsonFlag),
    report: () => cmdReport(findDirArg(), outputFile),
    categories: () => cmdCategories(),
    "generate-synthetic": () => cmdGenerateSynthetic(findDirArg() || "12"),
  };

  if (!command || !commands[command]) {
    console.log(`Usage: node scripts/failure-patterns.mjs <command> [options]

Commands:
  analyze [dir]           Parse audit trails and categorize failures
  report  [dir]           Generate a Markdown report with recommendations
  categories              List all failure categories and their patterns
  generate-synthetic [n]  Generate n synthetic audit sessions for testing

Options:
  --json                  Output analyze results as JSON
  --output <file>         Write report to a file instead of stdout

Examples:
  node scripts/failure-patterns.mjs categories
  node scripts/failure-patterns.mjs generate-synthetic 12
  node scripts/failure-patterns.mjs analyze .claude/audit/synthetic
  node scripts/failure-patterns.mjs analyze .claude/audit/synthetic --json
  node scripts/failure-patterns.mjs report .claude/audit/synthetic
  node scripts/failure-patterns.mjs report .claude/audit/synthetic --output report.md

The script analyzes JSONL audit trails from agent sessions, categorizes
failures into 6 types (test-failure, lint-error, merge-conflict, api-error,
timeout, wrong-approach), identifies recurring patterns, and generates
actionable recommendations for improving agent instructions.`);
    process.exit(command ? 1 : 0);
  }

  try {
    await commands[command]();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
