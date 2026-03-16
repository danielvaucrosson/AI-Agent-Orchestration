import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSubtaskDefs,
  validateSubtaskDefs,
  buildBranchName,
  createSubIssues,
  createSubBranches,
  discoverSubBranches,
  checkProgress,
  isAllComplete,
  findFailed,
  formatProgress,
  preflightCheck,
  mergeBranches,
  buildRecoveryPlan,
  parseCLI,
} from '../scripts/orchestrator.mjs';

describe('parseSubtaskDefs', () => {
  it('parses valid JSON array of subtask definitions', () => {
    const input = JSON.stringify([
      { title: 'Implement API client', description: 'Build the HTTP layer', branchSuffix: 'api-client' },
      { title: 'Add database schema', description: 'Create tables', branchSuffix: 'db-schema' },
    ]);
    const result = parseSubtaskDefs(input);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, 'Implement API client');
    assert.equal(result[1].branchSuffix, 'db-schema');
  });

  it('accepts an array directly (not just string)', () => {
    const input = [
      { title: 'Task A', description: 'Desc A', branchSuffix: 'task-a' },
    ];
    const result = parseSubtaskDefs(input);
    assert.equal(result.length, 1);
  });

  it('throws on invalid JSON string', () => {
    assert.throws(() => parseSubtaskDefs('not json'), { message: /invalid subtask definitions/i });
  });

  it('throws on non-array input', () => {
    assert.throws(() => parseSubtaskDefs('{"title":"x"}'), { message: /must be an array/i });
  });
});

describe('validateSubtaskDefs', () => {
  it('returns valid defs unchanged', () => {
    const defs = [
      { title: 'Task A', description: 'Desc', branchSuffix: 'task-a' },
      { title: 'Task B', description: 'Desc B', branchSuffix: 'task-b' },
    ];
    const result = validateSubtaskDefs(defs);
    assert.deepEqual(result, defs);
  });

  it('throws if a def is missing title', () => {
    const defs = [{ description: 'Desc', branchSuffix: 'x' }, { description: 'Desc2', branchSuffix: 'y' }];
    assert.throws(() => validateSubtaskDefs(defs), { message: /title.*required/i });
  });

  it('throws if a def is missing description', () => {
    const defs = [{ title: 'Task', branchSuffix: 'x' }, { title: 'Task2', branchSuffix: 'y' }];
    assert.throws(() => validateSubtaskDefs(defs), { message: /description.*required/i });
  });

  it('throws if a def is missing branchSuffix', () => {
    const defs = [{ title: 'Task', description: 'Desc' }, { title: 'Task2', description: 'Desc2' }];
    assert.throws(() => validateSubtaskDefs(defs), { message: /branchSuffix.*required/i });
  });

  it('throws if fewer than 2 subtasks', () => {
    const defs = [{ title: 'Solo', description: 'Only one', branchSuffix: 'solo' }];
    assert.throws(() => validateSubtaskDefs(defs), { message: /at least 2/i });
  });

  it('throws on duplicate branchSuffix values', () => {
    const defs = [
      { title: 'A', description: 'D', branchSuffix: 'same' },
      { title: 'B', description: 'D', branchSuffix: 'same' },
    ];
    assert.throws(() => validateSubtaskDefs(defs), { message: /duplicate.*branchSuffix/i });
  });

  it('preserves optional labels array', () => {
    const defs = [
      { title: 'A', description: 'D', branchSuffix: 'a', labels: ['infra'] },
      { title: 'B', description: 'D', branchSuffix: 'b' },
    ];
    const result = validateSubtaskDefs(defs);
    assert.deepEqual(result[0].labels, ['infra']);
    assert.equal(result[1].labels, undefined);
  });
});

describe('buildBranchName', () => {
  it('builds branch name from parent issue ID and suffix', () => {
    const result = buildBranchName('DVA-18', 'api-client');
    assert.equal(result, 'feature/DVA-18a-api-client');
  });

  it('assigns sequential letters for each subtask index', () => {
    assert.equal(buildBranchName('DVA-18', 'first', 0), 'feature/DVA-18a-first');
    assert.equal(buildBranchName('DVA-18', 'second', 1), 'feature/DVA-18b-second');
    assert.equal(buildBranchName('DVA-18', 'third', 2), 'feature/DVA-18c-third');
  });

  it('preserves the case of the issue ID', () => {
    assert.equal(buildBranchName('DVA-18', 'task', 0), 'feature/DVA-18a-task');
  });

  it('sanitizes suffix (replaces spaces and special chars)', () => {
    assert.equal(buildBranchName('DVA-18', 'my cool task!', 0), 'feature/DVA-18a-my-cool-task-');
  });
});

describe('createSubIssues', () => {
  it('creates sub-issues linked to parent via parentId', async () => {
    const created = [];
    const mockDeps = {
      linearClient: {
        issue: async (id) => ({
          id: 'uuid-parent',
          identifier: 'DVA-18',
          title: 'Parent Issue',
          team: Promise.resolve({ id: 'team-uuid' }),
        }),
        createIssue: async (input) => {
          created.push(input);
          return {
            issue: Promise.resolve({
              id: `uuid-child-${created.length}`,
              identifier: `DVA-18-sub${created.length}`,
              url: `https://linear.app/test/issue/DVA-18-sub${created.length}`,
            }),
          };
        },
      },
    };

    const subtasks = [
      { title: 'Sub A', description: 'Desc A', branchSuffix: 'sub-a' },
      { title: 'Sub B', description: 'Desc B', branchSuffix: 'sub-b', labels: ['infra'] },
    ];

    const result = await createSubIssues('DVA-18', subtasks, mockDeps);

    assert.equal(result.length, 2);
    assert.equal(created[0].parentId, 'uuid-parent');
    assert.equal(created[0].teamId, 'team-uuid');
    assert.equal(created[0].title, 'Sub A');
    assert.ok(created[0].description.includes('Desc A'));
    assert.equal(created[1].parentId, 'uuid-parent');
  });

  it('includes parent reference in sub-issue description', async () => {
    const created = [];
    const mockDeps = {
      linearClient: {
        issue: async () => ({
          id: 'uuid-p', identifier: 'DVA-18', title: 'Parent', team: Promise.resolve({ id: 't' }),
        }),
        createIssue: async (input) => {
          created.push(input);
          return { issue: Promise.resolve({ id: 'c1', identifier: 'DVA-X', url: 'url' }) };
        },
      },
    };

    await createSubIssues('DVA-18', [
      { title: 'A', description: 'Do A', branchSuffix: 'a' },
      { title: 'B', description: 'Do B', branchSuffix: 'b' },
    ], mockDeps);

    assert.ok(created[0].description.includes('DVA-18'));
    assert.ok(created[0].description.includes('Parent'));
  });

  it('returns created issue metadata', async () => {
    const mockDeps = {
      linearClient: {
        issue: async () => ({ id: 'p', identifier: 'DVA-18', title: 'P', team: Promise.resolve({ id: 't' }) }),
        createIssue: async () => ({
          issue: Promise.resolve({ id: 'c1', identifier: 'DVA-99', url: 'https://example.com' }),
        }),
      },
    };

    const result = await createSubIssues('DVA-18', [
      { title: 'A', description: 'D', branchSuffix: 'a' },
      { title: 'B', description: 'D', branchSuffix: 'b' },
    ], mockDeps);

    assert.equal(result[0].identifier, 'DVA-99');
    assert.equal(result[0].url, 'https://example.com');
    assert.equal(result[0].branchName, 'feature/DVA-18a-a');
  });
});

describe('createSubBranches', () => {
  it('creates a git branch for each subtask from the base branch', () => {
    const commands = [];
    const mockDeps = {
      runGit: (cmd) => { commands.push(cmd); return ''; },
    };

    const subtasks = [
      { title: 'A', description: 'D', branchSuffix: 'api' },
      { title: 'B', description: 'D', branchSuffix: 'db' },
    ];

    const result = createSubBranches('main', 'DVA-18', subtasks, mockDeps);

    assert.equal(result.length, 2);
    assert.equal(result[0], 'feature/DVA-18a-api');
    assert.equal(result[1], 'feature/DVA-18b-db');
    assert.ok(commands.some(c => c.includes('checkout -b feature/DVA-18a-api')));
    assert.ok(commands.some(c => c.includes('checkout -b feature/DVA-18b-db')));
    // Should return to base branch after creating all
    assert.equal(commands[commands.length - 1], 'checkout main');
  });
});

describe('discoverSubBranches', () => {
  it('finds branches matching the parent issue pattern', () => {
    const mockDeps = {
      runGit: (cmd) => {
        if (cmd.includes('branch -a')) {
          return [
            '  origin/feature/DVA-18a-api',
            '  origin/feature/DVA-18b-db',
            '  origin/feature/DVA-19-unrelated',
            '  origin/main',
          ].join('\n');
        }
        return '';
      },
    };

    const result = discoverSubBranches('DVA-18', mockDeps);
    assert.equal(result.length, 2);
    assert.ok(result.includes('feature/DVA-18a-api'));
    assert.ok(result.includes('feature/DVA-18b-db'));
  });

  it('returns empty array when no sub-branches exist', () => {
    const mockDeps = {
      runGit: () => '  origin/main\n  origin/feature/DVA-19-other',
    };
    const result = discoverSubBranches('DVA-18', mockDeps);
    assert.equal(result.length, 0);
  });

  it('does not match issues with longer numeric suffixes (e.g., DVA-180)', () => {
    const mockDeps = {
      runGit: () => [
        '  origin/feature/DVA-18a-api',
        '  origin/feature/DVA-180a-something',
        '  origin/feature/DVA-181b-other',
      ].join('\n'),
    };
    const result = discoverSubBranches('DVA-18', mockDeps);
    assert.equal(result.length, 1);
    assert.equal(result[0], 'feature/DVA-18a-api');
  });
});

describe('checkProgress', () => {
  it('fetches sub-issue statuses for a parent issue', async () => {
    const mockDeps = {
      linearClient: {
        issue: async (id) => ({
          id: 'uuid-parent',
          identifier: 'DVA-18',
          children: async () => ({
            nodes: [
              { id: 'c1', identifier: 'DVA-20', title: 'Sub A', state: { name: 'Done', type: 'completed' } },
              { id: 'c2', identifier: 'DVA-21', title: 'Sub B', state: { name: 'In Progress', type: 'started' } },
              { id: 'c3', identifier: 'DVA-22', title: 'Sub C', state: { name: 'Todo', type: 'unstarted' } },
            ],
          }),
        }),
      },
    };

    const progress = await checkProgress('DVA-18', mockDeps);
    assert.equal(progress.total, 3);
    assert.equal(progress.completed, 1);
    assert.equal(progress.inProgress, 1);
    assert.equal(progress.todo, 1);
    assert.equal(progress.failed, 0);
    assert.equal(progress.subtasks.length, 3);
  });
});

describe('isAllComplete', () => {
  it('returns true when all subtasks are completed', () => {
    assert.equal(isAllComplete({ total: 3, completed: 3 }), true);
  });

  it('returns false when some subtasks remain', () => {
    assert.equal(isAllComplete({ total: 3, completed: 2 }), false);
  });
});

describe('findFailed', () => {
  it('returns subtasks with canceled status', () => {
    const progress = {
      subtasks: [
        { identifier: 'DVA-20', title: 'A', stateType: 'completed' },
        { identifier: 'DVA-21', title: 'B', stateType: 'canceled' },
      ],
    };
    const failed = findFailed(progress);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].identifier, 'DVA-21');
  });

  it('returns empty array when nothing failed', () => {
    const progress = {
      subtasks: [
        { identifier: 'DVA-20', stateType: 'completed' },
        { identifier: 'DVA-21', stateType: 'started' },
      ],
    };
    assert.equal(findFailed(progress).length, 0);
  });
});

describe('formatProgress', () => {
  it('formats a readable progress report', () => {
    const progress = {
      total: 3,
      completed: 1,
      inProgress: 1,
      todo: 1,
      failed: 0,
      subtasks: [
        { identifier: 'DVA-20', title: 'Sub A', stateName: 'Done', stateType: 'completed' },
        { identifier: 'DVA-21', title: 'Sub B', stateName: 'In Progress', stateType: 'started' },
        { identifier: 'DVA-22', title: 'Sub C', stateName: 'Todo', stateType: 'unstarted' },
      ],
    };
    const report = formatProgress('DVA-18', progress);
    assert.ok(report.includes('DVA-18'));
    assert.ok(report.includes('1/3'));
    assert.ok(report.includes('DVA-20'));
    assert.ok(report.includes('Done'));
  });
});

describe('preflightCheck', () => {
  it('returns clean when no conflicts between sub-branches', () => {
    const mockDeps = {
      runGit: (cmd) => {
        if (cmd.includes('merge-tree')) return '';
        if (cmd.includes('merge-base')) return 'abc123';
        return '';
      },
    };

    const result = preflightCheck(['feature/DVA-18a-api', 'feature/DVA-18b-db'], 'main', mockDeps);
    assert.equal(result.clean, true);
    assert.equal(result.conflicts.length, 0);
  });

  it('detects conflicts between sub-branches', () => {
    const mockDeps = {
      runGit: (cmd) => {
        if (cmd.includes('merge-base')) return 'abc123';
        if (cmd.includes('diff') && cmd.includes('--name-only')) {
          return 'src/shared.mjs';
        }
        return '';
      },
    };

    const result = preflightCheck(['feature/DVA-18a-api', 'feature/DVA-18b-db'], 'main', mockDeps);
    assert.ok(result.conflicts.length > 0 || result.warnings.length > 0);
  });
});

describe('mergeBranches', () => {
  it('merges each sub-branch into target with --no-ff', () => {
    const commands = [];
    const mockDeps = {
      runGit: (cmd) => { commands.push(cmd); return ''; },
    };

    mergeBranches('feature/DVA-18-main', ['feature/DVA-18a-api', 'feature/DVA-18b-db'], mockDeps);

    assert.ok(commands.some(c => c.includes('checkout feature/DVA-18-main')));
    assert.ok(commands.some(c => c.includes('merge --no-ff feature/DVA-18a-api')));
    assert.ok(commands.some(c => c.includes('merge --no-ff feature/DVA-18b-db')));
  });

  it('returns list of merged branches', () => {
    const mockDeps = { runGit: () => '' };
    const result = mergeBranches('main', ['feature/DVA-18a-api', 'feature/DVA-18b-db'], mockDeps);
    assert.deepEqual(result.merged, ['feature/DVA-18a-api', 'feature/DVA-18b-db']);
  });
});

describe('buildRecoveryPlan', () => {
  it('suggests reassignment for failed subtasks', () => {
    const failed = [
      { identifier: 'DVA-21', title: 'Build DB schema', stateName: 'Canceled' },
    ];
    const plan = buildRecoveryPlan('DVA-18', failed);

    assert.equal(plan.parentId, 'DVA-18');
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0].issueId, 'DVA-21');
    assert.ok(plan.actions[0].options.includes('reassign'));
    assert.ok(plan.actions[0].options.includes('self-complete'));
  });

  it('generates a formatted recovery report', () => {
    const failed = [
      { identifier: 'DVA-21', title: 'DB', stateName: 'Canceled' },
      { identifier: 'DVA-22', title: 'API', stateName: 'Canceled' },
    ];
    const plan = buildRecoveryPlan('DVA-18', failed);
    assert.ok(plan.report.includes('DVA-21'));
    assert.ok(plan.report.includes('DVA-22'));
    assert.ok(plan.report.includes('2 failed'));
  });

  it('returns empty plan when no failures', () => {
    const plan = buildRecoveryPlan('DVA-18', []);
    assert.equal(plan.actions.length, 0);
    assert.ok(plan.report.includes('No failures'));
  });
});
