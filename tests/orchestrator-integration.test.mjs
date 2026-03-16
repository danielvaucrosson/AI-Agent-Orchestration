/**
 * Integration tests for scripts/orchestrator.mjs
 *
 * These tests chain multiple orchestrator functions together to prove the full
 * decomposition lifecycle works end-to-end, using dependency injection for
 * both the Linear client and git operations.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSubtaskDefs,
  validateSubtaskDefs,
  createSubIssues,
  createSubBranches,
  discoverSubBranches,
  checkProgress,
  findFailed,
  formatProgress,
  preflightCheck,
  mergeBranches,
  buildRecoveryPlan,
} from '../scripts/orchestrator.mjs';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock Linear client.
 *
 * @param {Object} options
 * @param {string}   options.parentId      - Parent issue identifier (e.g. 'DVA-60')
 * @param {string}   options.parentTitle   - Parent issue title
 * @param {string}   options.teamId        - Team UUID
 * @param {Array}    [options.children]    - Child issue stubs for checkProgress
 */
function mockLinearClient({ parentId, parentTitle, teamId, children = [] }) {
  let issueCounter = 0;

  return {
    issue: async (id) => ({
      id: `uuid-${parentId}`,
      identifier: parentId,
      title: parentTitle,
      team: Promise.resolve({ id: teamId }),
      children: async () => ({ nodes: children }),
    }),
    createIssue: async (input) => {
      issueCounter += 1;
      const idx = issueCounter;
      return {
        issue: Promise.resolve({
          id: `uuid-child-${idx}`,
          identifier: `${parentId}-sub${idx}`,
          url: `https://linear.app/test/issue/${parentId}-sub${idx}`,
        }),
      };
    },
  };
}

/**
 * Build a mock runGit that maps branch names to file sets.
 *
 * @param {Object<string, string[]>} branchFiles
 *   Keys are branch names; values are arrays of files changed on that branch.
 * @param {string} [mergeBase='basesha'] - Fake merge-base SHA returned for all branches.
 */
function mockRunGit(branchFiles, mergeBase = 'basesha') {
  const branches = Object.keys(branchFiles);
  return (cmd) => {
    // Branch listing
    if (cmd.includes('branch -a') || cmd === 'branch -a') {
      return branches.map(b => `  ${b}`).join('\n');
    }
    // Merge-base
    if (cmd.includes('merge-base')) {
      return mergeBase;
    }
    // Changed files per branch
    if (cmd.includes('diff --name-only')) {
      const matched = branches.find(b => cmd.includes(b));
      if (matched) {
        return branchFiles[matched].join('\n');
      }
      return '';
    }
    // checkout / merge — silently succeed
    return '';
  };
}

// ---------------------------------------------------------------------------
// Test 1: Full sub-issue creation flow with 3+ subtasks
// ---------------------------------------------------------------------------

describe('full sub-issue creation flow with 3+ subtasks', () => {
  it('chains parseSubtaskDefs → validateSubtaskDefs → createSubIssues and produces correct metadata', async () => {
    // --- Step 1: parse ---
    const raw = [
      { title: 'API client', description: 'Build the HTTP layer', branchSuffix: 'api-client' },
      { title: 'DB schema', description: 'Create database tables', branchSuffix: 'db-schema' },
      { title: 'UI components', description: 'Build React components', branchSuffix: 'ui-components' },
    ];
    const parsed = parseSubtaskDefs(raw);
    assert.equal(parsed.length, 3, 'parsed 3 subtask defs');

    // --- Step 2: validate ---
    const validated = validateSubtaskDefs(parsed);
    assert.equal(validated.length, 3, 'validated 3 subtask defs');

    // --- Step 3: create sub-issues via mock Linear client ---
    const createdIssueInputs = [];
    const client = {
      issue: async () => ({
        id: 'uuid-parent',
        identifier: 'DVA-60',
        title: 'Multi-agent decomposition parent',
        team: Promise.resolve({ id: 'team-uuid' }),
      }),
      createIssue: async (input) => {
        createdIssueInputs.push(input);
        const idx = createdIssueInputs.length;
        return {
          issue: Promise.resolve({
            id: `uuid-child-${idx}`,
            identifier: `DVA-6${idx}`,
            url: `https://linear.app/test/issue/DVA-6${idx}`,
          }),
        };
      },
    };

    const results = await createSubIssues('DVA-60', validated, { linearClient: client });

    // 3 sub-issues created
    assert.equal(results.length, 3, '3 sub-issues created');
    assert.equal(createdIssueInputs.length, 3, '3 Linear createIssue calls made');

    // All linked to the parent
    for (const input of createdIssueInputs) {
      assert.equal(input.parentId, 'uuid-parent', 'each sub-issue uses parent UUID');
      assert.equal(input.teamId, 'team-uuid', 'each sub-issue uses correct teamId');
    }

    // Sequential letters (a, b, c) in branch names
    assert.equal(results[0].branchName, 'feature/DVA-60a-api-client', 'first branch uses letter a');
    assert.equal(results[1].branchName, 'feature/DVA-60b-db-schema', 'second branch uses letter b');
    assert.equal(results[2].branchName, 'feature/DVA-60c-ui-components', 'third branch uses letter c');

    // Descriptions include parent reference
    for (const input of createdIssueInputs) {
      assert.ok(input.description.includes('DVA-60'), 'description includes parent identifier');
    }

    // Metadata correct
    assert.equal(results[0].identifier, 'DVA-61');
    assert.equal(results[1].identifier, 'DVA-62');
    assert.equal(results[2].identifier, 'DVA-63');
    assert.ok(results[0].url.startsWith('https://'), 'url present');
    assert.equal(results[0].title, 'API client', 'title preserved');
  });
});

// ---------------------------------------------------------------------------
// Test 2: Progress monitoring flow
// ---------------------------------------------------------------------------

describe('progress monitoring flow', () => {
  it('chains checkProgress → findFailed → formatProgress and produces a correct report', async () => {
    // Mock parent with 4 children in mixed states
    const children = [
      { id: 'c1', identifier: 'DVA-61', title: 'API client', state: { name: 'Done', type: 'completed' } },
      { id: 'c2', identifier: 'DVA-62', title: 'DB schema', state: { name: 'Done', type: 'completed' } },
      { id: 'c3', identifier: 'DVA-63', title: 'UI components', state: { name: 'In Progress', type: 'started' } },
      { id: 'c4', identifier: 'DVA-64', title: 'Auth layer', state: { name: 'Canceled', type: 'canceled' } },
    ];

    const client = mockLinearClient({
      parentId: 'DVA-60',
      parentTitle: 'Multi-agent parent',
      teamId: 'team-uuid',
      children,
    });

    // --- Step 1: checkProgress ---
    const progress = await checkProgress('DVA-60', { linearClient: client });

    assert.equal(progress.total, 4, '4 subtasks total');
    assert.equal(progress.completed, 2, '2 completed');
    assert.equal(progress.inProgress, 1, '1 in progress');
    assert.equal(progress.failed, 1, '1 canceled/failed');
    assert.equal(progress.todo, 0, '0 todo');
    assert.equal(progress.subtasks.length, 4, 'all 4 subtasks returned');

    // --- Step 2: findFailed ---
    const failed = findFailed(progress);
    assert.equal(failed.length, 1, '1 failed subtask found');
    assert.equal(failed[0].identifier, 'DVA-64', 'correct failed subtask identifier');

    // --- Step 3: formatProgress ---
    const report = formatProgress('DVA-60', progress);

    // Report contains all subtasks
    assert.ok(report.includes('DVA-61'), 'report includes DVA-61');
    assert.ok(report.includes('DVA-62'), 'report includes DVA-62');
    assert.ok(report.includes('DVA-63'), 'report includes DVA-63');
    assert.ok(report.includes('DVA-64'), 'report includes DVA-64');

    // Check for icons / markers for each state type
    assert.ok(report.includes('Done'), 'report includes Done status');
    assert.ok(report.includes('In Progress'), 'report includes In Progress status');
    assert.ok(report.includes('Canceled'), 'report includes Canceled status');

    // Progress summary line
    assert.ok(report.includes('2/4'), 'report includes 2/4 completion count');

    // Failure warning present
    assert.ok(report.includes('failed') || report.includes('recover'), 'report warns about failures');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Merge flow (no conflicts)
// ---------------------------------------------------------------------------

describe('merge flow with no conflicts', () => {
  it('chains discoverSubBranches → preflightCheck → mergeBranches and merges all 3 cleanly', () => {
    // 3 branches touching different files
    const branchFileMap = {
      'feature/DVA-60a-api-client': ['src/api.mjs', 'tests/api.test.mjs'],
      'feature/DVA-60b-db-schema': ['src/db.mjs', 'tests/db.test.mjs'],
      'feature/DVA-60c-ui-components': ['src/ui.mjs', 'tests/ui.test.mjs'],
    };

    const mergedCommands = [];
    const runGit = (cmd) => {
      mergedCommands.push(cmd);
      if (cmd.includes('branch -a')) {
        return [
          '  feature/DVA-60a-api-client',
          '  feature/DVA-60b-db-schema',
          '  feature/DVA-60c-ui-components',
          '  main',
        ].join('\n');
      }
      if (cmd.includes('merge-base')) return 'basesha';
      if (cmd.includes('diff --name-only')) {
        const branch = Object.keys(branchFileMap).find(b => cmd.includes(b));
        return branch ? branchFileMap[branch].join('\n') : '';
      }
      return '';
    };

    // --- Step 1: discoverSubBranches ---
    const branches = discoverSubBranches('DVA-60', { runGit });
    assert.equal(branches.length, 3, 'discovered 3 sub-branches');
    assert.ok(branches.includes('feature/DVA-60a-api-client'));
    assert.ok(branches.includes('feature/DVA-60b-db-schema'));
    assert.ok(branches.includes('feature/DVA-60c-ui-components'));

    // --- Step 2: preflightCheck ---
    const preflight = preflightCheck(branches, 'main', { runGit });
    assert.equal(preflight.clean, true, 'preflight is clean (no conflicts)');
    assert.equal(preflight.conflicts.length, 0, 'no conflicts detected');

    // --- Step 3: mergeBranches ---
    const mergeResult = mergeBranches('main', branches, { runGit });
    assert.equal(mergeResult.merged.length, 3, 'all 3 branches merged');
    assert.equal(mergeResult.failed.length, 0, 'no failed merges');
    assert.ok(mergeResult.merged.includes('feature/DVA-60a-api-client'));
    assert.ok(mergeResult.merged.includes('feature/DVA-60b-db-schema'));
    assert.ok(mergeResult.merged.includes('feature/DVA-60c-ui-components'));
  });
});

// ---------------------------------------------------------------------------
// Test 4: Merge flow (with conflicts)
// ---------------------------------------------------------------------------

describe('merge flow with conflicts', () => {
  it('chains discoverSubBranches → preflightCheck and identifies conflicting branches and files', () => {
    // 2 of 3 branches touch the same file
    const branchFileMap = {
      'feature/DVA-60a-api-client': ['src/shared-config.mjs', 'src/api.mjs'],
      'feature/DVA-60b-db-schema': ['src/shared-config.mjs', 'src/db.mjs'],
      'feature/DVA-60c-ui-components': ['src/ui.mjs', 'tests/ui.test.mjs'],
    };

    const runGit = (cmd) => {
      if (cmd.includes('branch -a')) {
        return [
          '  feature/DVA-60a-api-client',
          '  feature/DVA-60b-db-schema',
          '  feature/DVA-60c-ui-components',
          '  main',
        ].join('\n');
      }
      if (cmd.includes('merge-base')) return 'basesha';
      if (cmd.includes('diff --name-only')) {
        const branch = Object.keys(branchFileMap).find(b => cmd.includes(b));
        return branch ? branchFileMap[branch].join('\n') : '';
      }
      return '';
    };

    // --- Step 1: discoverSubBranches ---
    const branches = discoverSubBranches('DVA-60', { runGit });
    assert.equal(branches.length, 3, 'discovered 3 sub-branches');

    // --- Step 2: preflightCheck — should detect conflict ---
    const preflight = preflightCheck(branches, 'main', { runGit });
    assert.equal(preflight.clean, false, 'preflight is not clean (conflict exists)');
    assert.ok(preflight.conflicts.length > 0, 'at least one conflict detected');

    // The conflict should identify the two branches and the shared file
    const conflict = preflight.conflicts[0];
    const conflictBranches = [conflict.branchA, conflict.branchB];
    assert.ok(
      conflictBranches.includes('feature/DVA-60a-api-client'),
      'conflict identifies api-client branch',
    );
    assert.ok(
      conflictBranches.includes('feature/DVA-60b-db-schema'),
      'conflict identifies db-schema branch',
    );
    assert.ok(
      conflict.files.includes('src/shared-config.mjs'),
      'conflict identifies the shared file',
    );

    // The clean (ui-components) branch should NOT appear as conflicting with the others
    const uiConflicts = preflight.conflicts.filter(
      c => c.branchA === 'feature/DVA-60c-ui-components' ||
           c.branchB === 'feature/DVA-60c-ui-components',
    );
    assert.equal(uiConflicts.length, 0, 'ui-components branch has no conflicts');
  });
});

// ---------------------------------------------------------------------------
// Test 5: Recovery flow
// ---------------------------------------------------------------------------

describe('recovery flow', () => {
  it('chains findFailed → buildRecoveryPlan and produces a plan with correct actions and report', () => {
    // Progress object with one canceled subtask
    const progress = {
      total: 3,
      completed: 2,
      inProgress: 0,
      todo: 0,
      failed: 1,
      subtasks: [
        { id: 'c1', identifier: 'DVA-61', title: 'API client', stateName: 'Done', stateType: 'completed' },
        { id: 'c2', identifier: 'DVA-62', title: 'DB schema', stateName: 'Done', stateType: 'completed' },
        { id: 'c3', identifier: 'DVA-63', title: 'UI components', stateName: 'Canceled', stateType: 'canceled' },
      ],
    };

    // --- Step 1: findFailed ---
    const failed = findFailed(progress);
    assert.equal(failed.length, 1, '1 failed task found');
    assert.equal(failed[0].identifier, 'DVA-63', 'correct task identified as failed');

    // --- Step 2: buildRecoveryPlan ---
    const plan = buildRecoveryPlan('DVA-60', failed);

    assert.equal(plan.parentId, 'DVA-60', 'plan has correct parentId');
    assert.equal(plan.actions.length, 1, 'plan has 1 action');

    const action = plan.actions[0];
    assert.equal(action.issueId, 'DVA-63', 'action targets the failed task');
    assert.ok(action.options.includes('reassign'), 'action includes reassign option');
    assert.ok(action.options.includes('self-complete'), 'action includes self-complete option');
    assert.ok(action.options.includes('skip'), 'action includes skip option');

    // Report mentions the failed task
    assert.ok(plan.report.includes('DVA-63'), 'report mentions the failed task');
    assert.ok(plan.report.includes('UI components'), 'report mentions the failed task title');
    assert.ok(plan.report.includes('DVA-60'), 'report mentions the parent issue');
  });
});

// ---------------------------------------------------------------------------
// Test 6: Full lifecycle
// ---------------------------------------------------------------------------

describe('full lifecycle integration', () => {
  it('parse → validate → create sub-issues → create branches → check progress → preflight → merge', async () => {
    const PARENT_ID = 'DVA-60';
    const TEAM_ID = 'team-uuid';

    // ---- 1. Parse ----
    const rawDefs = [
      { title: 'API client', description: 'Build HTTP layer', branchSuffix: 'api-client' },
      { title: 'DB schema', description: 'Create tables', branchSuffix: 'db-schema' },
      { title: 'UI components', description: 'React components', branchSuffix: 'ui-components' },
    ];
    const parsed = parseSubtaskDefs(rawDefs);
    assert.equal(parsed.length, 3, 'parsed 3 defs');

    // ---- 2. Validate ----
    const validated = validateSubtaskDefs(parsed);
    assert.equal(validated.length, 3, 'validated 3 defs');

    // ---- 3. Create sub-issues (mock Linear) ----
    const createdInputs = [];
    const linearClient = {
      issue: async () => ({
        id: 'uuid-parent',
        identifier: PARENT_ID,
        title: 'Full lifecycle parent',
        team: Promise.resolve({ id: TEAM_ID }),
      }),
      createIssue: async (input) => {
        createdInputs.push(input);
        const idx = createdInputs.length;
        return {
          issue: Promise.resolve({
            id: `uuid-c${idx}`,
            identifier: `DVA-6${idx}`,
            url: `https://linear.app/test/issue/DVA-6${idx}`,
          }),
        };
      },
    };

    const subIssues = await createSubIssues(PARENT_ID, validated, { linearClient });
    assert.equal(subIssues.length, 3, 'created 3 sub-issues');
    const expectedBranches = [
      'feature/DVA-60a-api-client',
      'feature/DVA-60b-db-schema',
      'feature/DVA-60c-ui-components',
    ];
    for (let i = 0; i < 3; i++) {
      assert.equal(subIssues[i].branchName, expectedBranches[i], `branch name ${i} correct`);
    }

    // ---- 4. Create branches (mock git) ----
    const gitCommands = [];
    const branchGit = (cmd) => { gitCommands.push(cmd); return ''; };

    const createdBranches = createSubBranches('main', PARENT_ID, validated, { runGit: branchGit });
    assert.deepEqual(createdBranches, expectedBranches, 'git branches match expected names');
    assert.ok(gitCommands.some(c => c.includes('checkout -b feature/DVA-60a-api-client')), 'checkout -b for a');
    assert.ok(gitCommands.some(c => c.includes('checkout -b feature/DVA-60b-db-schema')), 'checkout -b for b');
    assert.ok(gitCommands.some(c => c.includes('checkout -b feature/DVA-60c-ui-components')), 'checkout -b for c');

    // ---- 5. Check progress (all completed, mock Linear) ----
    const completedChildren = expectedBranches.map((b, i) => ({
      id: `uuid-c${i + 1}`,
      identifier: `DVA-6${i + 1}`,
      title: validated[i].title,
      state: { name: 'Done', type: 'completed' },
    }));
    const completedClient = mockLinearClient({
      parentId: PARENT_ID,
      parentTitle: 'Full lifecycle parent',
      teamId: TEAM_ID,
      children: completedChildren,
    });
    const progress = await checkProgress(PARENT_ID, { linearClient: completedClient });
    assert.equal(progress.total, 3, 'total 3');
    assert.equal(progress.completed, 3, 'all 3 completed');
    assert.equal(progress.failed, 0, 'no failures');

    // ---- 6. Preflight (clean, mock git) ----
    const branchFileMap = {
      'feature/DVA-60a-api-client': ['src/api.mjs'],
      'feature/DVA-60b-db-schema': ['src/db.mjs'],
      'feature/DVA-60c-ui-components': ['src/ui.mjs'],
    };
    const preflightGit = (cmd) => {
      if (cmd.includes('branch -a')) {
        return expectedBranches.map(b => `  ${b}`).join('\n') + '\n  main';
      }
      if (cmd.includes('merge-base')) return 'abc123';
      if (cmd.includes('diff --name-only')) {
        const branch = Object.keys(branchFileMap).find(b => cmd.includes(b));
        return branch ? branchFileMap[branch].join('\n') : '';
      }
      return '';
    };

    const discoveredBranches = discoverSubBranches(PARENT_ID, { runGit: preflightGit });
    assert.equal(discoveredBranches.length, 3, 'discovered 3 sub-branches');

    const preflight = preflightCheck(discoveredBranches, 'main', { runGit: preflightGit });
    assert.equal(preflight.clean, true, 'preflight clean');
    assert.equal(preflight.conflicts.length, 0, 'no conflicts');

    // ---- 7. Merge — verify all 3 branches merged successfully ----
    const mergeGit = (cmd) => cmd; // just echo back; no-op checkout/merge
    const mergeResult = mergeBranches('main', discoveredBranches, { runGit: mergeGit });

    assert.equal(mergeResult.merged.length, 3, 'all 3 branches merged');
    assert.equal(mergeResult.failed.length, 0, 'no merge failures');

    // Unified result: all 3 expected branches are in merged list
    for (const branch of expectedBranches) {
      assert.ok(mergeResult.merged.includes(branch), `${branch} in merged list`);
    }
  });
});
