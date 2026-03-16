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
