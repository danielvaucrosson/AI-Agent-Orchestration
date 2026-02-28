/**
 * Code analysis scanner — finds actionable items in the codebase and
 * optionally creates Linear issues for them.
 *
 * Scan types:
 *   1. Comment markers — TODO, FIXME, HACK, BUG, XXX
 *   2. Test gaps — source files without corresponding test files
 *   3. Anti-patterns — configurable pattern detection
 *
 * Usage: node scripts/scan.mjs <command> [options]
 *
 * Commands:
 *   scan              Scan codebase and print findings (default)
 *   create            Scan and create Linear issues for new findings
 *
 * Options:
 *   --json            Output findings as JSON
 *   --team <key>      Linear team key (default: DVA)
 *   --dry-run         Show what would be created without creating
 */

import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, dirname, basename, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

// --- Configuration ---

/** File extensions to scan for comment markers */
const SCAN_EXTENSIONS = new Set([
  ".mjs", ".js", ".ts", ".tsx", ".jsx",
  ".py", ".rb", ".go", ".rs", ".java",
  ".css", ".scss", ".html", ".vue", ".svelte",
  ".sh", ".bash", ".zsh",
  ".yml", ".yaml", ".toml",
]);

/** Directories to skip */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".claude",
  "__pycache__", ".venv", "venv", ".eggs",
  "coverage", ".nyc_output",
]);

/** Files to skip (e.g., this scanner itself to avoid circular self-detection) */
const SKIP_FILES = new Set([
  "scan.mjs",
]);

/**
 * Comment marker pattern — only matches markers that appear after a comment
 * prefix (// # /* *) to avoid false positives in string literals and code.
 */
const COMMENT_PREFIXES = /(?:\/\/|#|\/\*|\*)\s*/;
const MARKER_RE =
  /\b(TODO|FIXME|HACK|BUG|XXX)\b[:\s]*(.*)/;

/** Source directories to check for test coverage */
const SOURCE_DIRS = ["src"];

/** Test directory and file pattern */
const TEST_DIR = "tests";
const TEST_SUFFIX = ".test.mjs";

/**
 * Anti-patterns to detect.
 * Each entry: { name, pattern (RegExp), description, extensions (optional) }
 */
const ANTI_PATTERNS = [
  {
    name: "console.log in production code",
    pattern: /\bconsole\.log\b/,
    description: "Leftover console.log statement — consider removing or using a proper logger",
    extensions: new Set([".mjs", ".js", ".ts", ".tsx", ".jsx"]),
    // Exclude files that are supposed to log (CLI scripts, tests, hooks)
    excludePaths: [/scripts[/\\]/, /tests[/\\]/, /\.test\./, /hooks[/\\]/],
  },
  {
    name: "Hardcoded localhost",
    pattern: /\b(localhost|127\.0\.0\.1)\b/,
    description: "Hardcoded localhost reference — consider using environment variables",
    excludePaths: [/\.test\./, /package\.json/, /scripts[/\\]/],
  },
  {
    name: "Empty catch block",
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
    description: "Empty catch block swallows errors silently — consider logging or re-throwing",
    extensions: new Set([".mjs", ".js", ".ts", ".tsx", ".jsx"]),
  },
];

// --- File Discovery ---

/**
 * Recursively walk a directory, yielding file paths.
 * Skips directories in SKIP_DIRS.
 */
function* walkDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        yield* walkDir(fullPath);
      }
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

/**
 * Get all scannable source files in the project.
 */
function getSourceFiles() {
  const files = [];
  for (const filePath of walkDir(PROJECT_ROOT)) {
    const ext = extname(filePath);
    const name = basename(filePath);
    if (SCAN_EXTENSIONS.has(ext) && !SKIP_FILES.has(name)) {
      files.push(filePath);
    }
  }
  return files;
}

// --- Scanners ---

/**
 * Generate a deterministic content hash for deduplication.
 */
export function contentHash(type, filePath, content) {
  const relPath = relative(PROJECT_ROOT, filePath);
  const input = `${type}::${relPath}::${content.trim()}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

/**
 * Scan a file for TODO/FIXME/HACK/BUG/XXX markers in comments.
 * Only matches markers that appear in comment lines (after //, #, /*, *)
 * to avoid false positives from code, strings, and regex patterns.
 * Returns an array of findings.
 */
export function scanMarkers(filePath) {
  const findings = [];
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return findings;
  }

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Only match markers in comment lines
    if (!COMMENT_PREFIXES.test(line)) continue;

    const match = line.match(MARKER_RE);
    if (match) {
      const marker = match[1].toUpperCase();
      const message = match[2].trim();
      const relPath = relative(PROJECT_ROOT, filePath);

      // Gather surrounding context (2 lines before and after)
      const contextStart = Math.max(0, i - 2);
      const contextEnd = Math.min(lines.length - 1, i + 2);
      const context = lines
        .slice(contextStart, contextEnd + 1)
        .map((l, idx) => {
          const lineNum = contextStart + idx + 1;
          const prefix = lineNum === i + 1 ? ">>>" : "   ";
          return `${prefix} ${lineNum}: ${l}`;
        })
        .join("\n");

      findings.push({
        type: "marker",
        marker,
        message: message || `${marker} found`,
        file: relPath,
        line: i + 1,
        context,
        hash: contentHash("marker", filePath, `${marker}::${message}`),
      });
    }
  }
  return findings;
}

/**
 * Detect source files without corresponding test files.
 */
export function scanTestGaps() {
  const findings = [];

  for (const srcDir of SOURCE_DIRS) {
    const srcPath = join(PROJECT_ROOT, srcDir);
    if (!existsSync(srcPath)) continue;

    for (const filePath of walkDir(srcPath)) {
      const ext = extname(filePath);
      if (!SCAN_EXTENSIONS.has(ext)) continue;

      const name = basename(filePath, ext);
      const testFile = join(PROJECT_ROOT, TEST_DIR, `${name}${TEST_SUFFIX}`);
      const relSrc = relative(PROJECT_ROOT, filePath);

      if (!existsSync(testFile)) {
        findings.push({
          type: "test-gap",
          marker: "TEST",
          message: `No test file found for ${relSrc}`,
          file: relSrc,
          line: 0,
          context: `Expected: ${relative(PROJECT_ROOT, testFile)}`,
          hash: contentHash("test-gap", filePath, relSrc),
        });
      }
    }
  }

  return findings;
}

/**
 * Scan for anti-patterns in source files.
 */
export function scanAntiPatterns(filePath) {
  const findings = [];
  const ext = extname(filePath);
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return findings;
  }

  const relPath = relative(PROJECT_ROOT, filePath);
  const lines = content.split("\n");

  for (const pattern of ANTI_PATTERNS) {
    // Check extension filter
    if (pattern.extensions && !pattern.extensions.has(ext)) continue;

    // Check path exclusions
    if (pattern.excludePaths?.some((re) => re.test(relPath))) continue;

    for (let i = 0; i < lines.length; i++) {
      if (pattern.pattern.test(lines[i])) {
        const contextStart = Math.max(0, i - 1);
        const contextEnd = Math.min(lines.length - 1, i + 1);
        const context = lines
          .slice(contextStart, contextEnd + 1)
          .map((l, idx) => {
            const lineNum = contextStart + idx + 1;
            const prefix = lineNum === i + 1 ? ">>>" : "   ";
            return `${prefix} ${lineNum}: ${l}`;
          })
          .join("\n");

        findings.push({
          type: "anti-pattern",
          marker: "PATTERN",
          message: pattern.description,
          file: relPath,
          line: i + 1,
          context,
          hash: contentHash("anti-pattern", filePath, `${pattern.name}::${i + 1}`),
        });
      }
    }
  }

  return findings;
}

/**
 * Run all scanners and return combined findings.
 */
export function scanAll() {
  const findings = [];
  const files = getSourceFiles();

  for (const filePath of files) {
    findings.push(...scanMarkers(filePath));
    findings.push(...scanAntiPatterns(filePath));
  }

  findings.push(...scanTestGaps());

  return findings;
}

// --- Linear Integration ---

/**
 * Fetch existing auto-detected issues from Linear to check for duplicates.
 * Uses the Linear MCP list_issues wouldn't work from CLI, so we use the SDK.
 */
async function getExistingAutoDetectedIssues(teamKey) {
  // Dynamically import to avoid requiring @linear/sdk when just scanning
  const { LinearClient } = await import("@linear/sdk");
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    throw new Error(
      "LINEAR_API_KEY environment variable required for creating issues",
    );
  }
  const client = new LinearClient({ apiKey });

  const issues = await client.issues({
    filter: {
      team: { key: { eq: teamKey } },
      labels: { name: { eq: "auto-detected" } },
      state: { type: { nin: ["completed", "canceled"] } },
    },
  });

  // Extract content hashes from issue descriptions
  const hashes = new Set();
  for (const issue of issues.nodes) {
    const match = issue.description?.match(/`scan-hash: ([a-f0-9]+)`/);
    if (match) hashes.add(match[1]);
  }

  return { client, existingHashes: hashes };
}

/**
 * Create a Linear issue for a finding.
 */
async function createIssueForFinding(client, finding, teamKey) {
  // Find team
  const teams = await client.teams();
  const team = teams.nodes.find((t) => t.key === teamKey);
  if (!team) throw new Error(`Team ${teamKey} not found`);

  // Find "Backlog" state
  const states = await team.states();
  const backlog = states.nodes.find(
    (s) => s.name.toLowerCase() === "backlog",
  );

  // Find auto-detected label
  const labels = await client.issueLabels();
  const autoLabel = labels.nodes.find((l) => l.name === "auto-detected");

  const title = `[${finding.marker}] ${finding.file}:${finding.line} — ${truncate(finding.message, 80)}`;

  const description = [
    `## Auto-detected Issue`,
    ``,
    `**Type:** ${finding.type}`,
    `**File:** \`${finding.file}\``,
    finding.line ? `**Line:** ${finding.line}` : "",
    ``,
    `### Description`,
    ``,
    finding.message,
    ``,
    `### Context`,
    ``,
    "```",
    finding.context,
    "```",
    ``,
    `---`,
    `_This issue was automatically created by \`scripts/scan.mjs\`._`,
    `\`scan-hash: ${finding.hash}\``,
  ]
    .filter(Boolean)
    .join("\n");

  const issueData = {
    title,
    description,
    teamId: team.id,
    priority: finding.marker === "BUG" || finding.marker === "FIXME" ? 2 : 4,
  };

  if (backlog) issueData.stateId = backlog.id;
  if (autoLabel) issueData.labelIds = [autoLabel.id];

  const issue = await client.createIssue(issueData);
  return issue;
}

function truncate(str, maxLen) {
  if (!str) return "";
  return str.length > maxLen ? str.slice(0, maxLen - 3) + "..." : str;
}

// --- CLI Output ---

function printFindings(findings) {
  if (findings.length === 0) {
    console.log("No findings detected. Codebase looks clean!");
    return;
  }

  console.log(`Found ${findings.length} finding(s):\n`);

  // Group by type
  const grouped = {};
  for (const f of findings) {
    const key = f.type;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(f);
  }

  for (const [type, items] of Object.entries(grouped)) {
    const label =
      type === "marker"
        ? "Comment Markers"
        : type === "test-gap"
          ? "Test Coverage Gaps"
          : "Anti-Patterns";
    console.log(`── ${label} (${items.length}) ──`);
    for (const f of items) {
      const location = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`  [${f.marker}] ${location}`);
      console.log(`    ${f.message}`);
    }
    console.log();
  }
}

// --- Commands ---

async function cmdScan(options) {
  const findings = scanAll();

  if (options.json) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    printFindings(findings);
  }

  return findings;
}

async function cmdCreate(options) {
  const findings = scanAll();

  if (findings.length === 0) {
    console.log("No findings to create issues for.");
    return;
  }

  console.log(`Found ${findings.length} finding(s). Checking for duplicates...`);

  const { client, existingHashes } = await getExistingAutoDetectedIssues(
    options.team,
  );

  const newFindings = findings.filter((f) => !existingHashes.has(f.hash));

  if (newFindings.length === 0) {
    console.log("All findings already have Linear issues. Nothing to create.");
    return;
  }

  console.log(
    `${newFindings.length} new finding(s) to create (${findings.length - newFindings.length} already exist).`,
  );

  if (options.dryRun) {
    console.log("\n[DRY RUN] Would create:");
    for (const f of newFindings) {
      const location = f.line ? `${f.file}:${f.line}` : f.file;
      console.log(`  [${f.marker}] ${location} — ${f.message}`);
    }
    return;
  }

  for (const f of newFindings) {
    try {
      const issue = await createIssueForFinding(client, f, options.team);
      const created = await issue.issue;
      console.log(`  Created: ${created.identifier} — ${created.title}`);
    } catch (err) {
      console.error(`  Failed: ${f.file}:${f.line} — ${err.message}`);
    }
  }

  console.log("\nDone.");
}

// --- CLI ---

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    command: "scan",
    json: false,
    team: "DVA",
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "scan" || arg === "create") {
      options.command = arg;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--team" && args[i + 1]) {
      options.team = args[++i];
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.command = "help";
    }
  }

  return options;
}

function showHelp() {
  console.log(`Usage: node scripts/scan.mjs [command] [options]

Commands:
  scan              Scan codebase and print findings (default)
  create            Scan, deduplicate, and create Linear issues

Options:
  --json            Output findings as JSON
  --team <key>      Linear team key (default: DVA)
  --dry-run         Show what 'create' would do without creating issues
  --help            Show this help message

Examples:
  node scripts/scan.mjs                      # Scan and print findings
  node scripts/scan.mjs --json               # Scan with JSON output
  node scripts/scan.mjs create --dry-run     # Preview issue creation
  node scripts/scan.mjs create               # Create issues (needs LINEAR_API_KEY)

Scan Types:
  • Comment markers: TODO, FIXME, HACK, BUG, XXX in source files
  • Test gaps: Source files in src/ without corresponding test files
  • Anti-patterns: console.log in prod code, hardcoded localhost, empty catch blocks

Deduplication:
  Each finding has a content hash embedded in the Linear issue description.
  Re-running 'create' will skip findings that already have matching issues.`);
}

const options = parseArgs(process.argv);

try {
  switch (options.command) {
    case "scan":
      await cmdScan(options);
      break;
    case "create":
      await cmdCreate(options);
      break;
    case "help":
      showHelp();
      break;
    default:
      showHelp();
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
