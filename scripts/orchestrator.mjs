/**
 * Multi-agent task decomposition orchestrator for DVA-18.
 *
 * Decomposes a Linear issue into parallel subtasks, creates sub-issues and
 * branches, monitors progress, and merges results back when complete.
 *
 * Usage:
 *   node scripts/orchestrator.mjs decompose <issue-id> --subtasks '<json>'
 *   node scripts/orchestrator.mjs status    <issue-id>
 *   node scripts/orchestrator.mjs merge     <issue-id>
 *   node scripts/orchestrator.mjs recover   <issue-id>
 *   node scripts/orchestrator.mjs --help
 */

import { LinearClient } from '@linear/sdk';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const defaultRunGit = (cmd) => execSync(`git ${cmd}`, { encoding: 'utf8' }).trim();

/**
 * Parse subtask definitions from JSON string or array.
 * @param {string|Array} input - JSON string or array of subtask defs
 * @returns {Array<{title: string, description: string, branchSuffix: string, labels?: string[]}>}
 */
export function parseSubtaskDefs(input) {
  let defs;
  if (Array.isArray(input)) {
    defs = input;
  } else {
    try {
      defs = JSON.parse(input);
    } catch {
      throw new Error('Invalid subtask definitions: could not parse JSON');
    }
  }
  if (!Array.isArray(defs)) {
    throw new Error('Subtask definitions must be an array');
  }
  return defs;
}

/**
 * Validate subtask definitions have required fields.
 * @param {Array} defs - Parsed subtask definitions
 * @returns {Array} - Validated definitions (unchanged)
 */
export function validateSubtaskDefs(defs) {
  if (defs.length < 2) {
    throw new Error('Decomposition requires at least 2 subtasks');
  }
  const suffixes = new Set();
  for (const def of defs) {
    if (!def.title) throw new Error('title is required for each subtask');
    if (!def.description) throw new Error('description is required for each subtask');
    if (!def.branchSuffix) throw new Error('branchSuffix is required for each subtask');
    if (suffixes.has(def.branchSuffix)) {
      throw new Error(`Duplicate branchSuffix: "${def.branchSuffix}"`);
    }
    suffixes.add(def.branchSuffix);
  }
  return defs;
}

// --- Stubs for functions implemented in later tasks ---
// These will be replaced with full implementations in subsequent tasks.

/**
 * Build a branch name for a subtask.
 * @param {string} parentIssueId - Parent issue identifier (e.g., 'DVA-18')
 * @param {string} suffix - Branch suffix from subtask def
 * @param {number} [index=0] - Subtask index (0=a, 1=b, etc.)
 * @returns {string} Branch name like 'feature/DVA-18a-api-client'
 */
export function buildBranchName(parentIssueId, suffix, index = 0) {
  const letter = String.fromCharCode(97 + index); // a, b, c, ...
  const sanitized = suffix.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `feature/${parentIssueId}${letter}-${sanitized}`;
}

/**
 * Create Linear sub-issues linked to a parent issue.
 * @param {string} parentIdentifier - Parent issue identifier (e.g., 'DVA-18')
 * @param {Array} subtasks - Validated subtask definitions
 * @param {Object} [deps] - Injected dependencies
 * @returns {Promise<Array<{id: string, identifier: string, url: string, branchName: string}>>}
 */
export async function createSubIssues(parentIdentifier, subtasks, deps = {}) {
  const client = deps.linearClient || new LinearClient({ apiKey: process.env.LINEAR_API_KEY });

  const parent = await client.issue(parentIdentifier);
  const teamId = (await parent.team).id;

  const results = [];
  for (let i = 0; i < subtasks.length; i++) {
    const sub = subtasks[i];
    const branchName = buildBranchName(parentIdentifier, sub.branchSuffix, i);
    const description = `**Parent:** ${parentIdentifier} — ${parent.title}\n**Branch:** \`${branchName}\`\n\n---\n\n${sub.description}`;

    const payload = await client.createIssue({
      title: sub.title,
      description,
      teamId,
      parentId: parent.id,
    });

    const created = await payload.issue;
    results.push({
      id: created.id,
      identifier: created.identifier,
      url: created.url,
      branchName,
      title: sub.title,
    });
  }

  return results;
}

/**
 * Create git branches for each subtask.
 * @param {string} baseBranch - Branch to create from (e.g., 'main')
 * @param {string} parentIssueId - Parent issue identifier
 * @param {Array} subtasks - Subtask definitions
 * @param {Object} [deps] - Injected dependencies
 * @returns {string[]} Created branch names
 */
export function createSubBranches(baseBranch, parentIssueId, subtasks, deps = {}) {
  const runGit = deps.runGit || defaultRunGit;
  const branches = [];

  for (let i = 0; i < subtasks.length; i++) {
    const branchName = buildBranchName(parentIssueId, subtasks[i].branchSuffix, i);
    runGit(`checkout -b ${branchName} ${baseBranch}`);
    branches.push(branchName);
  }

  runGit(`checkout ${baseBranch}`);
  return branches;
}

/**
 * Discover existing sub-branches for a parent issue.
 * @param {string} parentIssueId - Parent issue identifier (e.g., 'DVA-18')
 * @param {Object} [deps] - Injected dependencies
 * @returns {string[]} Branch names matching the pattern
 */
export function discoverSubBranches(parentIssueId, deps = {}) {
  const runGit = deps.runGit || defaultRunGit;
  const output = runGit('branch -a');
  const escaped = parentIssueId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^feature/${escaped}[a-z]-`);

  return output
    .split('\n')
    .map(line => line.trim().replace(/^(?:remotes\/)?origin\//, ''))
    .filter(name => pattern.test(name))
    .filter((name, i, arr) => arr.indexOf(name) === i); // dedupe
}

/**
 * Check progress of all sub-issues for a parent.
 * @param {string} parentIdentifier - Parent issue identifier
 * @param {Object} [deps] - Injected dependencies
 * @returns {Promise<{total, completed, inProgress, todo, failed, subtasks}>}
 */
export async function checkProgress(parentIdentifier, deps = {}) {
  const client = deps.linearClient || new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
  const parent = await client.issue(parentIdentifier);
  const children = await parent.children();

  const subtasks = children.nodes.map(child => ({
    id: child.id,
    identifier: child.identifier,
    title: child.title,
    stateName: child.state.name,
    stateType: child.state.type,
  }));

  return {
    total: subtasks.length,
    completed: subtasks.filter(s => s.stateType === 'completed').length,
    inProgress: subtasks.filter(s => s.stateType === 'started').length,
    todo: subtasks.filter(s => s.stateType === 'unstarted' || s.stateType === 'backlog').length,
    failed: subtasks.filter(s => s.stateType === 'canceled').length,
    subtasks,
  };
}

/**
 * Check if all subtasks are complete.
 */
export function isAllComplete(progress) {
  return progress.completed === progress.total;
}

/**
 * Find subtasks that have failed (canceled).
 */
export function findFailed(progress) {
  return progress.subtasks.filter(s => s.stateType === 'canceled');
}

/**
 * Format progress as a readable report.
 */
export function formatProgress(parentId, progress) {
  const lines = [
    `## ${parentId} — Progress: ${progress.completed}/${progress.total}`,
    '',
    '| Sub-issue | Title | Status |',
    '|-----------|-------|--------|',
  ];

  for (const sub of progress.subtasks) {
    const icon = sub.stateType === 'completed' ? '✅' :
                 sub.stateType === 'started' ? '🔄' :
                 sub.stateType === 'canceled' ? '❌' : '⬜';
    lines.push(`| ${sub.identifier} | ${sub.title} | ${icon} ${sub.stateName} |`);
  }

  if (progress.failed > 0) {
    lines.push('', `⚠️ ${progress.failed} subtask(s) failed — run \`orchestrator.mjs recover ${parentId}\` to handle.`);
  }

  return lines.join('\n');
}

/**
 * Pre-flight check for conflicts between sub-branches.
 * @param {string[]} branches - Sub-branch names
 * @param {string} baseBranch - Common ancestor branch
 * @param {Object} [deps] - Injected dependencies
 * @returns {{clean: boolean, conflicts: Array, warnings: Array}}
 */
export function preflightCheck(branches, baseBranch, deps = {}) {
  const runGit = deps.runGit || defaultRunGit;
  const conflicts = [];
  const warnings = [];

  const branchFiles = {};
  for (const branch of branches) {
    try {
      const mergeBase = runGit(`merge-base ${baseBranch} ${branch}`);
      const files = runGit(`diff --name-only ${mergeBase}..${branch}`);
      branchFiles[branch] = new Set(files.split('\n').filter(Boolean));
    } catch {
      branchFiles[branch] = new Set();
    }
  }

  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      const filesA = branchFiles[branches[i]];
      const filesB = branchFiles[branches[j]];
      const overlap = [...filesA].filter(f => filesB.has(f));

      if (overlap.length > 0) {
        conflicts.push({
          branchA: branches[i],
          branchB: branches[j],
          files: overlap,
        });
      }
    }
  }

  return { clean: conflicts.length === 0, conflicts, warnings };
}

/**
 * Merge sub-branches into a target branch.
 * @param {string} targetBranch - Branch to merge into
 * @param {string[]} subBranches - Branches to merge
 * @param {Object} [deps] - Injected dependencies
 * @returns {{merged: string[], failed: Array}}
 */
export function mergeBranches(targetBranch, subBranches, deps = {}) {
  const runGit = deps.runGit || defaultRunGit;
  const merged = [];
  const failed = [];

  runGit(`checkout ${targetBranch}`);

  for (const branch of subBranches) {
    try {
      runGit(`merge --no-ff ${branch} -m "Merge ${branch} into ${targetBranch}"`);
      merged.push(branch);
    } catch (err) {
      runGit('merge --abort');
      failed.push({ branch, error: err.message });
    }
  }

  return { merged, failed };
}

/** @todo Implemented in Task 7 */
export function buildRecoveryPlan() { throw new Error('Not yet implemented'); }

/** @todo Implemented in Task 8 */
export function parseCLI() { throw new Error('Not yet implemented'); }
