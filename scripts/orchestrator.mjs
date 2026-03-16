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

/**
 * Build a recovery plan for failed subtasks.
 * @param {string} parentId - Parent issue identifier
 * @param {Array} failedTasks - Failed subtask objects from findFailed()
 * @returns {{parentId: string, actions: Array, report: string}}
 */
export function buildRecoveryPlan(parentId, failedTasks) {
  if (failedTasks.length === 0) {
    return { parentId, actions: [], report: `## ${parentId} Recovery\n\nNo failures detected.` };
  }

  const actions = failedTasks.map(task => ({
    issueId: task.identifier,
    title: task.title,
    status: task.stateName,
    options: ['reassign', 'self-complete', 'skip'],
  }));

  const lines = [
    `## ${parentId} Recovery — ${failedTasks.length} failed subtask(s)`,
    '',
    '| Sub-issue | Title | Status | Options |',
    '|-----------|-------|--------|---------|',
  ];

  for (const action of actions) {
    lines.push(`| ${action.issueId} | ${action.title} | ${action.status} | ${action.options.join(', ')} |`);
  }

  lines.push('', 'For each failed subtask, the lead agent should:', '1. **Reassign** — move back to Todo for another agent', '2. **Self-complete** — lead agent picks up the work directly', '3. **Skip** — mark as not needed and proceed with merge');

  return { parentId, actions, report: lines.join('\n') };
}

/**
 * Parse CLI arguments.
 * @param {string[]} args - Command line arguments (after node and script)
 * @returns {Object} Parsed command object
 */
export function parseCLI(args) {
  const command = args[0];
  const validCommands = ['create-subtasks', 'status', 'merge', 'recover'];

  if (!validCommands.includes(command)) {
    throw new Error(`Unknown command: "${command}". Valid: ${validCommands.join(', ')}`);
  }

  const parentId = args[1];
  if (!parentId) {
    throw new Error('Issue ID required (e.g., DVA-18)');
  }

  const result = { command, parentId };

  if (command === 'create-subtasks') {
    const subtasksJson = args[2];
    if (!subtasksJson) throw new Error('Subtask definitions JSON required');
    result.subtasks = parseSubtaskDefs(subtasksJson);
  }

  if (command === 'merge') {
    const intoIdx = args.indexOf('--into');
    result.targetBranch = intoIdx !== -1 ? args[intoIdx + 1] : 'main';
  }

  return result;
}

// --- Main CLI Entry Point ---

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(`Usage:
  orchestrator.mjs create-subtasks <ISSUE-ID> '<json>'  Create sub-issues and branches
  orchestrator.mjs status <ISSUE-ID>                     Check progress of all sub-tasks
  orchestrator.mjs merge <ISSUE-ID> [--into <branch>]    Merge completed sub-branches
  orchestrator.mjs recover <ISSUE-ID>                    Show recovery plan for failures`);
    return;
  }

  const parsed = parseCLI(args);

  switch (parsed.command) {
    case 'create-subtasks': {
      const validated = validateSubtaskDefs(parsed.subtasks);
      console.log(`Creating ${validated.length} sub-issues for ${parsed.parentId}...`);
      const created = await createSubIssues(parsed.parentId, validated);
      console.log(`\nCreated sub-issues:`);
      for (const c of created) {
        console.log(`  ${c.identifier}: ${c.title} → ${c.branchName}`);
      }
      console.log(`\nCreating branches...`);
      createSubBranches('main', parsed.parentId, validated);
      console.log('Done. Branches created and ready for work.');
      break;
    }

    case 'status': {
      const progress = await checkProgress(parsed.parentId);
      console.log(formatProgress(parsed.parentId, progress));
      break;
    }

    case 'merge': {
      const branches = discoverSubBranches(parsed.parentId);
      if (branches.length === 0) {
        console.log(`No sub-branches found for ${parsed.parentId}.`);
        return;
      }
      console.log(`Pre-flight check on ${branches.length} branches...`);
      const check = preflightCheck(branches, parsed.targetBranch);
      if (!check.clean) {
        console.log('⚠️ Conflicts detected:');
        for (const c of check.conflicts) {
          console.log(`  ${c.branchA} ↔ ${c.branchB}: ${c.files.join(', ')}`);
        }
        console.log('\nResolve conflicts before merging.');
        return;
      }
      console.log('Pre-flight clean. Merging...');
      const result = mergeBranches(parsed.targetBranch, branches);
      console.log(`Merged: ${result.merged.length}/${branches.length}`);
      if (result.failed.length > 0) {
        console.log('Failed:');
        for (const f of result.failed) console.log(`  ${f.branch}: ${f.error}`);
      }
      break;
    }

    case 'recover': {
      const progress = await checkProgress(parsed.parentId);
      const failed = findFailed(progress);
      const plan = buildRecoveryPlan(parsed.parentId, failed);
      console.log(plan.report);
      break;
    }
  }
}

// Run if executed directly (imports already at top of file)
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch(err => { console.error(err.message); process.exit(1); });
