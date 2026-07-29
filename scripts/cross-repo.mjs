/**
 * Cross-repo orchestration for DVA-20.
 *
 * Coordinates changes across multiple repositories, linking multiple PRs
 * to a single Linear issue for atomic feature delivery.
 *
 * Usage:
 *   node scripts/cross-repo.mjs init         <issue-id> '<repos-json>'
 *   node scripts/cross-repo.mjs status       <issue-id>
 *   node scripts/cross-repo.mjs create-prs   <issue-id>
 *   node scripts/cross-repo.mjs merge-order  <issue-id>
 *   node scripts/cross-repo.mjs flag         <issue-id> <repo-name>
 *   node scripts/cross-repo.mjs --help
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WORKSPACE_DIR = '.cross-repo-workspace';

// ─── Parsing & Validation ─────────────────────────────────────────────

/**
 * Parse repo configuration from JSON string or array.
 * @param {string|Array} input - JSON string or array of repo definitions
 * @returns {Array<{name: string, url: string, branch: string, dependsOn?: string[]}>}
 */
export function parseRepoConfig(input) {
  let repos;
  if (Array.isArray(input)) {
    repos = input;
  } else {
    try {
      repos = JSON.parse(input);
    } catch {
      throw new Error('Invalid repo config: could not parse JSON');
    }
  }
  if (!Array.isArray(repos)) {
    throw new Error('Repo config must be an array');
  }
  return repos;
}

/**
 * Validate repo configuration has required fields and consistent dependencies.
 * @param {Array} repos - Parsed repo definitions
 * @returns {Array} Validated definitions (unchanged)
 */
export function validateRepoConfig(repos) {
  if (repos.length < 2) {
    throw new Error('Cross-repo orchestration requires at least 2 repositories');
  }

  const names = new Set();
  for (const repo of repos) {
    if (!repo.name) throw new Error('name is required for each repo');
    if (!repo.url) throw new Error('url is required for each repo');
    if (!repo.branch) throw new Error('branch is required for each repo');
    if (names.has(repo.name)) {
      throw new Error(`Duplicate repo name: "${repo.name}"`);
    }
    names.add(repo.name);
  }

  // Validate dependency references
  for (const repo of repos) {
    const deps = repo.dependsOn || [];
    for (const dep of deps) {
      if (!names.has(dep)) {
        throw new Error(`Unknown dependency "${dep}" in repo "${repo.name}"`);
      }
      if (dep === repo.name) {
        throw new Error(`Repo "${repo.name}" cannot depend on itself`);
      }
    }
  }

  // Check for dependency cycles
  const cycles = detectCycles(repos);
  if (cycles.length > 0) {
    throw new Error(`Dependency cycle detected: ${cycles.join(' → ')}`);
  }

  return repos;
}

// ─── Dependency Graph ──────────────────────────────────────────────────

/**
 * Detect cycles in the dependency graph using DFS.
 * @param {Array} repos - Repo definitions with dependsOn arrays
 * @returns {string[]} Cycle path (empty if no cycles)
 */
export function detectCycles(repos) {
  const adj = new Map();
  for (const repo of repos) {
    adj.set(repo.name, repo.dependsOn || []);
  }

  const visited = new Set();
  const inStack = new Set();
  const path = [];

  function dfs(node) {
    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const neighbor of (adj.get(node) || [])) {
      if (inStack.has(neighbor)) {
        path.push(neighbor);
        return true;
      }
      if (!visited.has(neighbor) && dfs(neighbor)) {
        return true;
      }
    }

    path.pop();
    inStack.delete(node);
    return false;
  }

  for (const repo of repos) {
    if (!visited.has(repo.name)) {
      if (dfs(repo.name)) return path;
    }
  }

  return [];
}

/**
 * Build merge order via topological sort. Upstream repos (no or fewer
 * dependencies) get lower merge-order numbers and should merge first.
 * @param {Array} repos - Repo definitions with dependsOn arrays
 * @returns {Array<{name: string, mergeOrder: number}>}
 */
export function buildMergeOrder(repos) {
  const inDegree = new Map();
  const adj = new Map();

  for (const repo of repos) {
    inDegree.set(repo.name, 0);
    adj.set(repo.name, []);
  }

  for (const repo of repos) {
    for (const dep of (repo.dependsOn || [])) {
      adj.get(dep).push(repo.name);
      inDegree.set(repo.name, (inDegree.get(repo.name) || 0) + 1);
    }
  }

  const queue = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  // Stable sort: alphabetical within the same level
  queue.sort();

  const order = [];
  let position = 1;

  while (queue.length > 0) {
    const current = queue.shift();
    order.push({ name: current, mergeOrder: position++ });

    const neighbors = [...(adj.get(current) || [])];
    neighbors.sort();
    for (const neighbor of neighbors) {
      inDegree.set(neighbor, inDegree.get(neighbor) - 1);
      if (inDegree.get(neighbor) === 0) {
        queue.push(neighbor);
        queue.sort();
      }
    }
  }

  return order;
}

// ─── Session Management ────────────────────────────────────────────────

/**
 * Get the workspace root directory.
 * @param {Object} [deps] - Injected dependencies
 * @returns {string} Absolute path to workspace root
 */
export function getWorkspaceRoot(deps = {}) {
  const cwd = deps.cwd || process.cwd();
  return resolve(cwd, WORKSPACE_DIR);
}

/**
 * Get the path to a session config file.
 * @param {string} issueId - Linear issue identifier
 * @param {Object} [deps] - Injected dependencies
 * @returns {string} Absolute path to session.json
 */
export function getSessionPath(issueId, deps = {}) {
  return join(getWorkspaceRoot(deps), issueId, 'session.json');
}

/**
 * Save a session config to disk.
 * @param {string} issueId - Linear issue identifier
 * @param {Object} config - Session configuration
 * @param {Object} [deps] - Injected dependencies
 */
export function saveSession(issueId, config, deps = {}) {
  const writeFn = deps.writeFile || writeFileSync;
  const mkdirFn = deps.mkdir || mkdirSync;
  const sessionPath = getSessionPath(issueId, deps);
  const dir = join(getWorkspaceRoot(deps), issueId);
  mkdirFn(dir, { recursive: true });
  writeFn(sessionPath, JSON.stringify(config, null, 2));
}

/**
 * Load an existing session config.
 * @param {string} issueId - Linear issue identifier
 * @param {Object} [deps] - Injected dependencies
 * @returns {Object} Session configuration
 */
export function loadSession(issueId, deps = {}) {
  const readFn = deps.readFile || readFileSync;
  const existsFn = deps.exists || existsSync;
  const sessionPath = getSessionPath(issueId, deps);
  if (!existsFn(sessionPath)) {
    throw new Error(`No cross-repo session found for ${issueId}. Run 'init' first.`);
  }
  return JSON.parse(readFn(sessionPath, 'utf8'));
}

// ─── Workspace Initialization ──────────────────────────────────────────

/**
 * Initialize a cross-repo workspace: create directories, clone repos, create branches.
 * @param {string} issueId - Linear issue identifier
 * @param {Array} repos - Validated repo definitions
 * @param {Object} [deps] - Injected dependencies
 * @returns {Object} Session configuration
 */
export function initWorkspace(issueId, repos, deps = {}) {
  const runShell = deps.runShell || ((cmd, opts) => execSync(cmd, { encoding: 'utf8', ...opts }).trim());
  const mkdirFn = deps.mkdir || mkdirSync;
  const existsFn = deps.exists || existsSync;
  const saveFn = deps.saveSession || saveSession;

  const workspaceRoot = getWorkspaceRoot(deps);
  const sessionDir = join(workspaceRoot, issueId);

  if (existsFn(join(sessionDir, 'session.json'))) {
    throw new Error(`Session already exists for ${issueId}. Use 'status' to check progress.`);
  }

  mkdirFn(sessionDir, { recursive: true });

  const mergeOrder = buildMergeOrder(repos);
  const mergeOrderMap = new Map(mergeOrder.map(m => [m.name, m.mergeOrder]));

  const repoResults = [];

  for (const repo of repos) {
    const repoDir = join(sessionDir, repo.name);

    if (!existsFn(repoDir)) {
      runShell(`git clone ${repo.url} ${repo.name}`, { cwd: sessionDir });
    }

    // Create the feature branch
    runShell(`git checkout -b ${repo.branch}`, { cwd: repoDir });

    repoResults.push({
      name: repo.name,
      url: repo.url,
      branch: repo.branch,
      dependsOn: repo.dependsOn || [],
      mergeOrder: mergeOrderMap.get(repo.name),
      localPath: repoDir,
      prUrl: null,
      prNumber: null,
      status: 'initialized',
    });
  }

  const session = {
    issueId,
    created: new Date().toISOString(),
    repos: repoResults,
    workspace: sessionDir,
  };

  saveFn(issueId, session, deps);
  return session;
}

// ─── PR Description & Creation ─────────────────────────────────────────

/**
 * Build a PR description that documents cross-repo dependencies and merge ordering.
 * @param {Object} repo - Repo entry from session config
 * @param {Object} session - Full session config
 * @returns {string} Markdown PR body
 */
export function buildPRDescription(repo, session) {
  const lines = [];

  lines.push(`## Cross-Repo Change — ${session.issueId}`);
  lines.push('');
  lines.push(`This PR is part of a coordinated cross-repo change tracked by [${session.issueId}](https://linear.app/issue/${session.issueId}).`);
  lines.push('');

  // Related PRs
  const otherRepos = session.repos.filter(r => r.name !== repo.name);
  if (otherRepos.length > 0) {
    lines.push('### Related PRs');
    lines.push('');
    for (const other of otherRepos) {
      const prLink = other.prUrl || '*(not yet created)*';
      const depNote = (repo.dependsOn || []).includes(other.name)
        ? ' **(dependency)**'
        : (other.dependsOn || []).includes(repo.name)
          ? ' **(depends on this)**'
          : '';
      lines.push(`- **${other.name}**: ${prLink}${depNote}`);
    }
    lines.push('');
  }

  // Dependencies
  const deps = repo.dependsOn || [];
  if (deps.length > 0) {
    lines.push('### Dependencies');
    lines.push('');
    lines.push(`This repo depends on changes in: ${deps.map(d => `**${d}**`).join(', ')}`);
    lines.push('');
    lines.push('> **Merge ordering:** Merge the dependency PRs first before merging this one.');
    lines.push('');
  }

  // Merge ordering
  lines.push('### Merge Order');
  lines.push('');
  const sorted = [...session.repos].sort((a, b) => a.mergeOrder - b.mergeOrder);
  for (const r of sorted) {
    const marker = r.name === repo.name ? ' **← this PR**' : '';
    lines.push(`${r.mergeOrder}. **${r.name}** (\`${r.branch}\`)${marker}`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Create PRs for all repos in the session and link them to the Linear issue.
 * @param {Object} session - Session configuration
 * @param {Object} [deps] - Injected dependencies
 * @returns {Promise<Object>} Updated session with PR URLs
 */
export async function createRepoPRs(session, deps = {}) {
  const runShell = deps.runShell || ((cmd, opts) => execSync(cmd, { encoding: 'utf8', ...opts }).trim());
  const saveFn = deps.saveSession || saveSession;
  const linearComment = deps.linearComment || null;

  const results = [];

  for (const repo of session.repos) {
    const description = buildPRDescription(repo, session);
    const title = `${session.issueId}: ${repo.name} — cross-repo change`;

    // Push the branch
    runShell(`git push -u origin ${repo.branch}`, { cwd: repo.localPath });

    // Create the PR via gh CLI
    const prUrl = runShell(
      `gh pr create --title "${title}" --body "${description.replace(/"/g, '\\"')}" --head ${repo.branch}`,
      { cwd: repo.localPath }
    );

    // Extract PR number from URL
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : null;

    repo.prUrl = prUrl;
    repo.prNumber = prNumber;
    repo.status = 'pr-created';
    results.push({ name: repo.name, prUrl, prNumber });
  }

  // Update session with PR info
  saveFn(session.issueId, session, deps);

  // Link all PRs to the Linear issue
  if (linearComment) {
    const prSummary = results
      .map(r => `- **${r.name}**: ${r.prUrl}`)
      .join('\n');
    await linearComment(
      session.issueId,
      `Cross-repo PRs created:\n\n${prSummary}`
    );
  }

  return { session, results };
}

// ─── Status & Reporting ────────────────────────────────────────────────

/**
 * Check the status of all repos in a cross-repo session.
 * @param {Object} session - Session configuration
 * @param {Object} [deps] - Injected dependencies
 * @returns {Object} Status report with per-repo details
 */
export function checkRepoStatus(session, deps = {}) {
  const runShell = deps.runShell || ((cmd, opts) => {
    try {
      return execSync(cmd, { encoding: 'utf8', ...opts }).trim();
    } catch {
      return '';
    }
  });

  const repoStatuses = session.repos.map(repo => {
    let branchExists = false;
    let hasChanges = false;
    let commitCount = 0;

    try {
      runShell(`git rev-parse --verify ${repo.branch}`, { cwd: repo.localPath });
      branchExists = true;
    } catch {
      // branch doesn't exist
    }

    if (branchExists) {
      const status = runShell('git status --porcelain', { cwd: repo.localPath });
      hasChanges = status.length > 0;

      const log = runShell(`git log main..${repo.branch} --oneline`, { cwd: repo.localPath });
      commitCount = log ? log.split('\n').filter(Boolean).length : 0;
    }

    return {
      name: repo.name,
      branch: repo.branch,
      branchExists,
      hasChanges,
      commitCount,
      prUrl: repo.prUrl,
      prNumber: repo.prNumber,
      mergeOrder: repo.mergeOrder,
      dependsOn: repo.dependsOn || [],
      status: repo.status,
    };
  });

  return {
    issueId: session.issueId,
    workspace: session.workspace,
    repos: repoStatuses,
    totalRepos: repoStatuses.length,
    withPRs: repoStatuses.filter(r => r.prUrl).length,
    withChanges: repoStatuses.filter(r => r.hasChanges || r.commitCount > 0).length,
  };
}

/**
 * Format a status report as a readable table.
 * @param {Object} statusReport - From checkRepoStatus
 * @returns {string} Formatted report
 */
export function formatStatusReport(statusReport) {
  const lines = [
    `## ${statusReport.issueId} — Cross-Repo Status`,
    '',
    `Workspace: \`${statusReport.workspace}\``,
    `Repos: ${statusReport.totalRepos} | PRs: ${statusReport.withPRs} | With changes: ${statusReport.withChanges}`,
    '',
    '| # | Repo | Branch | Commits | PR | Status | Depends On |',
    '|---|------|--------|---------|----|--------|------------|',
  ];

  const sorted = [...statusReport.repos].sort((a, b) => a.mergeOrder - b.mergeOrder);
  for (const repo of sorted) {
    const pr = repo.prUrl || '—';
    const deps = repo.dependsOn.length > 0 ? repo.dependsOn.join(', ') : '—';
    lines.push(
      `| ${repo.mergeOrder} | ${repo.name} | \`${repo.branch}\` | ${repo.commitCount} | ${pr} | ${repo.status} | ${deps} |`
    );
  }

  return lines.join('\n');
}

// ─── Cross-Repo Flagging ───────────────────────────────────────────────

/**
 * When a PR in one repo fails review, flag all related PRs.
 * Returns the list of repos that should be warned.
 * @param {Object} session - Session configuration
 * @param {string} failedRepoName - Name of the repo whose PR failed
 * @param {Object} [deps] - Injected dependencies
 * @returns {Promise<{flagged: Array, message: string}>}
 */
export async function flagRelatedPRs(session, failedRepoName, deps = {}) {
  const runShell = deps.runShell || ((cmd, opts) => execSync(cmd, { encoding: 'utf8', ...opts }).trim());
  const linearComment = deps.linearComment || null;

  const failedRepo = session.repos.find(r => r.name === failedRepoName);
  if (!failedRepo) {
    throw new Error(`Repo "${failedRepoName}" not found in session ${session.issueId}`);
  }

  // Find repos that depend on the failed repo (downstream)
  const downstream = session.repos.filter(r =>
    (r.dependsOn || []).includes(failedRepoName)
  );

  // Find repos that the failed repo depends on (upstream)
  const upstream = session.repos.filter(r =>
    (failedRepo.dependsOn || []).includes(r.name)
  );

  // All related repos (both upstream and downstream, excluding the failed one)
  const related = [...new Set([...downstream, ...upstream])].filter(
    r => r.name !== failedRepoName
  );

  const flagged = [];

  for (const repo of related) {
    if (repo.prNumber && repo.prUrl) {
      const relationship = downstream.includes(repo) ? 'depends on' : 'is a dependency of';
      const comment = `**Cross-repo warning:** The PR for **${failedRepoName}** (which ${relationship} this repo) has failed review in the coordinated change ${session.issueId}. This PR may need to be held until the issue is resolved.`;

      try {
        runShell(
          `gh pr comment ${repo.prNumber} --body "${comment.replace(/"/g, '\\"')}"`,
          { cwd: repo.localPath }
        );
      } catch {
        // Non-fatal: log but continue
      }

      flagged.push({
        name: repo.name,
        prNumber: repo.prNumber,
        relationship,
      });
    }
  }

  // Post summary to Linear
  if (linearComment && flagged.length > 0) {
    const flagSummary = flagged
      .map(f => `- **${f.name}** (PR #${f.prNumber}) — ${f.relationship} ${failedRepoName}`)
      .join('\n');
    await linearComment(
      session.issueId,
      `Cross-repo review failure in **${failedRepoName}**. Flagged related PRs:\n\n${flagSummary}`
    );
  }

  const message = flagged.length > 0
    ? `Flagged ${flagged.length} related PR(s) due to review failure in ${failedRepoName}.`
    : `No related PRs with open PRs to flag for ${failedRepoName}.`;

  return { flagged, message };
}

// ─── CLI ───────────────────────────────────────────────────────────────

/**
 * Parse CLI arguments.
 * @param {string[]} args - Command line arguments
 * @returns {Object} Parsed command
 */
export function parseCLI(args) {
  const command = args[0];
  const validCommands = ['init', 'status', 'create-prs', 'merge-order', 'flag'];

  if (!validCommands.includes(command)) {
    throw new Error(`Unknown command: "${command}". Valid: ${validCommands.join(', ')}`);
  }

  const issueId = args[1];
  if (!issueId) {
    throw new Error('Issue ID required (e.g., DVA-20)');
  }

  const result = { command, issueId };

  if (command === 'init') {
    const reposJson = args[2];
    if (!reposJson) throw new Error('Repo configuration JSON required');
    result.repos = parseRepoConfig(reposJson);
  }

  if (command === 'flag') {
    const repoName = args[2];
    if (!repoName) throw new Error('Repo name required for flag command');
    result.repoName = repoName;
  }

  return result;
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(`Usage:
  cross-repo.mjs init         <ISSUE-ID> '<repos-json>'  Initialize workspace and clone repos
  cross-repo.mjs status       <ISSUE-ID>                  Check status of all repos
  cross-repo.mjs create-prs   <ISSUE-ID>                  Create PRs and link to Linear issue
  cross-repo.mjs merge-order  <ISSUE-ID>                  Show merge ordering
  cross-repo.mjs flag         <ISSUE-ID> <repo-name>      Flag related PRs on review failure

Repo config JSON format:
  [
    {"name": "lib", "url": "https://github.com/org/lib", "branch": "feature/DVA-20-lib"},
    {"name": "app", "url": "https://github.com/org/app", "branch": "feature/DVA-20-app", "dependsOn": ["lib"]}
  ]`);
    return;
  }

  const parsed = parseCLI(args);

  switch (parsed.command) {
    case 'init': {
      const validated = validateRepoConfig(parsed.repos);
      console.log(`Initializing cross-repo workspace for ${parsed.issueId} with ${validated.length} repos...`);
      const session = initWorkspace(parsed.issueId, validated);
      console.log(`\nWorkspace: ${session.workspace}`);
      console.log(`\nRepos initialized:`);
      for (const repo of session.repos) {
        console.log(`  ${repo.mergeOrder}. ${repo.name} → ${repo.branch}`);
      }
      console.log('\nMerge order determined from dependency graph.');
      break;
    }

    case 'status': {
      const session = loadSession(parsed.issueId);
      const status = checkRepoStatus(session);
      console.log(formatStatusReport(status));
      break;
    }

    case 'create-prs': {
      const session = loadSession(parsed.issueId);
      console.log(`Creating PRs for ${session.repos.length} repos...`);
      const { results } = await createRepoPRs(session);
      console.log('\nPRs created:');
      for (const r of results) {
        console.log(`  ${r.name}: ${r.prUrl}`);
      }
      break;
    }

    case 'merge-order': {
      const session = loadSession(parsed.issueId);
      const order = buildMergeOrder(session.repos);
      console.log(`## Merge Order for ${parsed.issueId}\n`);
      for (const entry of order) {
        const repo = session.repos.find(r => r.name === entry.name);
        const deps = (repo.dependsOn || []).join(', ') || 'none';
        const pr = repo.prUrl || 'no PR yet';
        console.log(`${entry.mergeOrder}. ${entry.name} (depends on: ${deps}) — ${pr}`);
      }
      console.log('\nMerge in this order. Wait for CI to pass on each before merging the next.');
      break;
    }

    case 'flag': {
      const session = loadSession(parsed.issueId);
      const { flagged, message } = await flagRelatedPRs(session, parsed.repoName);
      console.log(message);
      if (flagged.length > 0) {
        for (const f of flagged) {
          console.log(`  ${f.name} (PR #${f.prNumber}) — ${f.relationship}`);
        }
      }
      break;
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch(err => { console.error(err.message); process.exit(1); });
