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
