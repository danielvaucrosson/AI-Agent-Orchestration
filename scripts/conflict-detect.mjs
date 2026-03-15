/**
 * Conflict detection between concurrent agent branches.
 *
 * Detects file-level overlaps between the current branch and other active
 * feature/fix branches. Posts severity-classified warnings to Linear.
 *
 * Usage:
 *   node scripts/conflict-detect.mjs scan   [--json]
 *   node scripts/conflict-detect.mjs warn   [--dry-run]
 *   node scripts/conflict-detect.mjs --help
 *
 * Commands:
 *   scan    Detect conflicts and print report
 *   warn    Detect conflicts and post warnings to Linear
 *
 * Options:
 *   --json      Output as JSON (scan only)
 *   --dry-run   Preview Linear comments without posting (warn only)
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// --- Issue ID extraction ---

/** Same regex as .claude/hooks/linear-helpers.mjs (duplicated to avoid cross-layer import) */
const ISSUE_ID_RE = /\b([A-Z]{1,5}-\d+)\b/;

export function extractIssueId(text) {
  const match = text.match(ISSUE_ID_RE);
  return match ? match[1] : null;
}

// --- Hunk header parsing ---

const HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

export function parseHunkHeaders(diffOutput) {
  const hunks = [];
  for (const line of diffOutput.split("\n")) {
    const match = line.match(HUNK_RE);
    if (match) {
      hunks.push({
        oldStart: parseInt(match[1], 10),
        oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
        newStart: parseInt(match[3], 10),
        newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
      });
    }
  }
  return hunks;
}

// --- Line range overlap detection ---

export function rangesOverlap(hunksA, hunksB) {
  for (const a of hunksA) {
    if (a.newCount === 0) continue;
    const aEnd = a.newStart + a.newCount - 1;
    for (const b of hunksB) {
      if (b.newCount === 0) continue;
      const bEnd = b.newStart + b.newCount - 1;
      if (a.newStart <= bEnd && b.newStart <= aEnd) {
        return true;
      }
    }
  }
  return false;
}

// --- Severity classification, conflict hash, directory overlaps, file overlaps ---

export function topLevelDir(filePath) {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts[0] : ".";
}

export function classifySeverity(_file, linesOverlap) {
  return linesOverlap ? "critical" : "warning";
}

export function findDirOverlaps(pushedFiles, otherFiles, fileOverlaps) {
  const pushedDirs = new Set([...pushedFiles].map(topLevelDir));
  const otherDirs = new Set([...otherFiles].map(topLevelDir));
  const fileOverlapDirs = new Set(fileOverlaps.map(topLevelDir));

  const sharedDirs = [];
  for (const dir of pushedDirs) {
    if (dir === ".") continue;
    if (otherDirs.has(dir) && !fileOverlapDirs.has(dir)) {
      sharedDirs.push(dir);
    }
  }
  return sharedDirs.sort();
}

export function conflictHash(branchA, branchB, files) {
  const sorted = [...files].sort();
  const input = `${branchA}::${branchB}::${sorted.join(",")}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

export function findOverlaps(pushedFiles, otherFiles) {
  const overlaps = [];
  for (const file of pushedFiles) {
    if (otherFiles.has(file)) {
      overlaps.push(file);
    }
  }
  return overlaps.sort();
}

// --- Branch discovery and staleness filter ---

function defaultRunGit(cmd) {
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

const ACTIVE_BRANCH_RE = /^\s*origin\/((?:feature|fix)\/.+)$/;

export function discoverBranches(currentBranch, deps = {}) {
  const runGit = deps.runGit || defaultRunGit;
  const output = runGit("git branch -r");
  const branches = [];

  for (const line of output.split("\n")) {
    const match = line.match(ACTIVE_BRANCH_RE);
    if (match && match[1] !== currentBranch) {
      branches.push(`origin/${match[1]}`);
    }
  }
  return branches;
}

export function filterStaleBranches(branches, deps = {}) {
  const runGit = deps.runGit || defaultRunGit;
  const maxAgeDays = deps.maxAgeDays ?? 7;
  const now = deps.now || new Date();
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);

  return branches.filter((branch) => {
    try {
      const dateStr = runGit(`git log -1 --format=%ci ${branch}`);
      const commitDate = new Date(dateStr);
      return commitDate >= cutoff;
    } catch {
      return false;
    }
  });
}

// --- Changed file computation ---

export function getChangedFiles(branch, deps = {}) {
  const runGit = deps.runGit || defaultRunGit;
  let mergeBase;
  try {
    mergeBase = runGit(`git merge-base origin/main ${branch}`);
  } catch {
    return null;
  }
  const output = runGit(`git diff --name-only ${mergeBase}..${branch}`);
  const files = output.split("\n").map((f) => f.trim()).filter(Boolean);
  return { mergeBase, files: new Set(files) };
}

// --- Task 6: Conflict detection pipeline ---

export function detectConflicts(currentBranch, deps = {}) {
  const runGit = deps.runGit || defaultRunGit;
  const depsWithGit = { ...deps, runGit };

  const allBranches = discoverBranches(currentBranch, depsWithGit);
  const branches = filterStaleBranches(allBranches, depsWithGit);

  if (branches.length === 0) return [];

  const currentRef = `origin/${currentBranch}`;
  const pushedResult = getChangedFiles(currentRef, depsWithGit);
  if (!pushedResult || pushedResult.files.size === 0) return [];

  const pushedIssueId = extractIssueId(currentBranch);
  const conflicts = [];

  for (const branch of branches) {
    const otherResult = getChangedFiles(branch, depsWithGit);
    if (!otherResult) continue;

    const overlapping = findOverlaps(pushedResult.files, otherResult.files);
    const dirOverlaps = findDirOverlaps(pushedResult.files, otherResult.files, overlapping);

    if (overlapping.length === 0 && dirOverlaps.length === 0) continue;

    if (overlapping.length === 0) {
      const issueId = extractIssueId(branch);
      conflicts.push({
        branch,
        issueId,
        pushedIssueId,
        severity: "info",
        files: [],
        directories: dirOverlaps,
        lineRanges: {},
        hash: conflictHash(currentRef, branch, dirOverlaps),
      });
      continue;
    }

    let maxSeverity = "warning";
    const lineRanges = {};

    for (const file of overlapping) {
      try {
        const pushedDiff = runGit(`git diff --unified=0 ${pushedResult.mergeBase} ${currentRef} -- ${file}`);
        const otherDiff = runGit(`git diff --unified=0 ${otherResult.mergeBase} ${branch} -- ${file}`);

        const pushedHunks = parseHunkHeaders(pushedDiff);
        const otherHunks = parseHunkHeaders(otherDiff);

        if (rangesOverlap(pushedHunks, otherHunks)) {
          maxSeverity = "critical";
          lineRanges[file] = { pushed: pushedHunks, other: otherHunks };
        }
      } catch {
        // If line-level check fails, keep as warning
      }
    }

    const issueId = extractIssueId(branch);
    conflicts.push({
      branch,
      issueId,
      pushedIssueId,
      severity: maxSeverity,
      files: overlapping,
      lineRanges,
      hash: conflictHash(currentRef, branch, overlapping),
    });
  }

  return conflicts;
}

// --- Task 7: Report formatting ---

const SEVERITY_ICONS = {
  info: "\u2139",
  warning: "\u26A0",
  critical: "\uD83D\uDD34",
};

function formatLineRange(hunks) {
  return hunks
    .filter((h) => h.newCount > 0)
    .map((h) => {
      const end = h.newStart + h.newCount - 1;
      return h.newCount === 1 ? `${h.newStart}` : `${h.newStart}-${end}`;
    })
    .join(", ");
}

export function formatReport(pushedBranch, totalBranches, filteredBranches, conflicts) {
  const lines = [];
  lines.push("Conflict Detection Report");
  lines.push("\u2500".repeat(25));
  lines.push(`Pushed branch: ${pushedBranch}`);
  lines.push(`Active branches: ${totalBranches} (${filteredBranches} after staleness filter)`);
  lines.push("");

  if (conflicts.length === 0) {
    lines.push("No conflicts detected.");
    return lines.join("\n");
  }

  for (const c of conflicts) {
    const icon = SEVERITY_ICONS[c.severity] || "?";
    const label = c.severity.toUpperCase();
    const issueStr = c.issueId ? ` (${c.issueId})` : "";
    lines.push(`${icon} ${label} \u2014 ${c.branch}${issueStr}`);

    if (c.severity === "info" && c.directories) {
      lines.push("  Same directory:");
      for (const dir of c.directories) {
        lines.push(`    ${dir}/`);
      }
    } else if (c.severity === "critical" && Object.keys(c.lineRanges).length > 0) {
      lines.push("  Shared files (line overlap):");
      for (const file of c.files) {
        if (c.lineRanges[file]) {
          const pushedRange = formatLineRange(c.lineRanges[file].pushed);
          const otherRange = formatLineRange(c.lineRanges[file].other);
          lines.push(`    ${file} (lines ${pushedRange} vs ${otherRange})`);
        } else {
          lines.push(`    ${file}`);
        }
      }
    } else {
      lines.push("  Shared files:");
      for (const file of c.files) {
        lines.push(`    ${file}`);
      }
    }
    lines.push("");
  }

  const counts = { info: 0, warning: 0, critical: 0 };
  for (const c of conflicts) counts[c.severity]++;
  const parts = [];
  if (counts.info > 0) parts.push(`${counts.info} info`);
  if (counts.warning > 0) parts.push(`${counts.warning} warning`);
  if (counts.critical > 0) parts.push(`${counts.critical} critical`);
  lines.push(`Summary: ${parts.join(", ")}`);

  return lines.join("\n");
}

// --- Task 9: Linear warning functions ---

export function buildWarningComment(conflict, pushedBranch) {
  const severity = conflict.severity.toUpperCase();
  const icon = SEVERITY_ICONS[conflict.severity] || "?";
  const lines = [];

  lines.push(`## ${icon} Conflict Detection — ${severity}`);
  lines.push("");
  lines.push(`Branch \`${pushedBranch}\` has overlapping file changes with \`${conflict.branch.replace("origin/", "")}\`.`);
  lines.push("");
  lines.push("**Shared files:**");

  for (const file of conflict.files) {
    if (conflict.severity === "critical" && conflict.lineRanges[file]) {
      const pushed = formatLineRange(conflict.lineRanges[file].pushed);
      const other = formatLineRange(conflict.lineRanges[file].other);
      lines.push(`- \`${file}\` (line overlap: ${pushed} vs ${other})`);
    } else {
      lines.push(`- \`${file}\``);
    }
  }

  lines.push("");
  lines.push(`**Recommendation:** Consider coordinating with ${conflict.issueId || "the other branch"} to avoid merge conflicts.`);
  lines.push("");
  lines.push("---");
  lines.push(`_Auto-detected by \`scripts/conflict-detect.mjs\`_`);
  lines.push(`\`conflict-hash: ${conflict.hash}\``);

  return lines.join("\n");
}

export function hasExistingWarning(comments, hash) {
  return comments.some((c) => c.body && c.body.includes(`\`conflict-hash: ${hash}\``));
}

async function postWarnings(conflicts, pushedBranch, options = {}) {
  const { LinearClient } = await import("@linear/sdk");
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.error("LINEAR_API_KEY not set — skipping Linear posting.");
    return;
  }
  const client = new LinearClient({ apiKey });

  for (const conflict of conflicts) {
    const comment = buildWarningComment(conflict, pushedBranch);
    const issuesToNotify = [conflict.pushedIssueId, conflict.issueId].filter(Boolean);

    for (const issueIdentifier of issuesToNotify) {
      try {
        const issue = await client.issue(issueIdentifier);
        const commentsResult = await issue.comments();
        const existingComments = commentsResult.nodes || [];

        if (hasExistingWarning(existingComments, conflict.hash)) {
          console.log(`  ${issueIdentifier}: Skipped (warning already exists)`);
          continue;
        }

        if (options.dryRun) {
          console.log(`  [DRY RUN] Would post to ${issueIdentifier}:`);
          console.log(`    Severity: ${conflict.severity}`);
          console.log(`    Files: ${conflict.files.join(", ")}`);
        } else {
          await client.createComment({ issueId: issue.id, body: comment });
          console.log(`  ${issueIdentifier}: Warning posted (${conflict.severity})`);
        }
      } catch (err) {
        console.error(`  ${issueIdentifier}: Failed — ${err.message}`);
      }
    }
  }
}

// --- Task 8: CLI ---

export function parseArgs(argv) {
  const args = argv.slice(2);
  const options = { command: "", json: false, dryRun: false, team: "DVA" };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "scan" || arg === "warn") {
      options.command = arg;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--team" && args[i + 1]) {
      options.team = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      options.command = "help";
    }
  }

  return options;
}

export function computeExitCode(conflicts) {
  if (conflicts.some((c) => c.severity === "critical")) return 2;
  if (conflicts.some((c) => c.severity === "warning")) return 1;
  return 0;
}

function getCurrentBranch() {
  return defaultRunGit("git rev-parse --abbrev-ref HEAD");
}

function showHelp() {
  console.log(`Usage: node scripts/conflict-detect.mjs <command> [options]

Commands:
  scan    Detect conflicts and print report
  warn    Detect conflicts and post warnings to Linear

Options:
  --json      Output as JSON (scan only)
  --dry-run   Preview Linear comments without posting (warn only)
  --team <k>  Linear team key (default: DVA)
  --help      Show this help message

Examples:
  node scripts/conflict-detect.mjs scan
  node scripts/conflict-detect.mjs scan --json
  node scripts/conflict-detect.mjs warn --dry-run
  node scripts/conflict-detect.mjs warn

Exit Codes (scan):
  0  No conflicts or info-level only
  1  Warnings exist
  2  Critical conflicts found`);
}

// --- Main ---

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const options = parseArgs(process.argv);

  if (options.command === "help" || !options.command) {
    showHelp();
    process.exit(options.command ? 0 : 1);
  }

  try {
    const currentBranch = getCurrentBranch();
    const allBranches = discoverBranches(currentBranch, {});
    const filteredBranches = filterStaleBranches(allBranches, {});
    const conflicts = detectConflicts(currentBranch, {});

    if (options.command === "scan") {
      if (options.json) {
        console.log(JSON.stringify(conflicts, null, 2));
      } else {
        console.log(formatReport(currentBranch, allBranches.length, filteredBranches.length, conflicts));
      }
      process.exit(computeExitCode(conflicts));
    } else if (options.command === "warn") {
      if (conflicts.length === 0) {
        console.log("No conflicts to warn about.");
      } else {
        console.log(`Posting warnings for ${conflicts.length} conflict(s)...`);
        await postWarnings(conflicts, currentBranch, { dryRun: options.dryRun });
        console.log("Done.");
      }
      process.exit(0);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(options.command === "warn" ? 0 : 1);
  }
}
