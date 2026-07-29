import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRepoConfig,
  validateRepoConfig,
  detectCycles,
  buildMergeOrder,
  getWorkspaceRoot,
  getSessionPath,
  saveSession,
  loadSession,
  initWorkspace,
  buildPRDescription,
  createRepoPRs,
  checkRepoStatus,
  formatStatusReport,
  flagRelatedPRs,
  parseCLI,
} from '../scripts/cross-repo.mjs';

// ─── Test Fixtures ─────────────────────────────────────────────────────

function twoRepos() {
  return [
    { name: 'shared-lib', url: 'https://github.com/org/shared-lib', branch: 'feature/DVA-20-lib' },
    { name: 'consumer-app', url: 'https://github.com/org/consumer-app', branch: 'feature/DVA-20-app', dependsOn: ['shared-lib'] },
  ];
}

function threeRepos() {
  return [
    { name: 'core', url: 'https://github.com/org/core', branch: 'feature/DVA-20-core' },
    { name: 'api', url: 'https://github.com/org/api', branch: 'feature/DVA-20-api', dependsOn: ['core'] },
    { name: 'web', url: 'https://github.com/org/web', branch: 'feature/DVA-20-web', dependsOn: ['core', 'api'] },
  ];
}

function mockSession() {
  return {
    issueId: 'DVA-20',
    created: '2026-03-19T00:00:00.000Z',
    workspace: '/tmp/cross-repo/DVA-20',
    repos: [
      {
        name: 'shared-lib',
        url: 'https://github.com/org/shared-lib',
        branch: 'feature/DVA-20-lib',
        dependsOn: [],
        mergeOrder: 1,
        localPath: '/tmp/cross-repo/DVA-20/shared-lib',
        prUrl: 'https://github.com/org/shared-lib/pull/42',
        prNumber: 42,
        status: 'pr-created',
      },
      {
        name: 'consumer-app',
        url: 'https://github.com/org/consumer-app',
        branch: 'feature/DVA-20-app',
        dependsOn: ['shared-lib'],
        mergeOrder: 2,
        localPath: '/tmp/cross-repo/DVA-20/consumer-app',
        prUrl: 'https://github.com/org/consumer-app/pull/17',
        prNumber: 17,
        status: 'pr-created',
      },
    ],
  };
}

// ─── parseRepoConfig ───────────────────────────────────────────────────

describe('parseRepoConfig', () => {
  it('parses valid JSON string', () => {
    const input = JSON.stringify(twoRepos());
    const result = parseRepoConfig(input);
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'shared-lib');
  });

  it('accepts an array directly', () => {
    const result = parseRepoConfig(twoRepos());
    assert.equal(result.length, 2);
  });

  it('throws on invalid JSON string', () => {
    assert.throws(() => parseRepoConfig('not json'), { message: /could not parse JSON/i });
  });

  it('throws on non-array JSON', () => {
    assert.throws(() => parseRepoConfig('{"name":"x"}'), { message: /must be an array/i });
  });
});

// ─── validateRepoConfig ───────────────────────────────────────────────

describe('validateRepoConfig', () => {
  it('returns valid config unchanged', () => {
    const repos = twoRepos();
    const result = validateRepoConfig(repos);
    assert.deepEqual(result, repos);
  });

  it('throws if fewer than 2 repos', () => {
    const repos = [{ name: 'solo', url: 'https://x', branch: 'b' }];
    assert.throws(() => validateRepoConfig(repos), { message: /at least 2/i });
  });

  it('throws if name is missing', () => {
    const repos = [
      { url: 'https://x', branch: 'b' },
      { name: 'b', url: 'https://y', branch: 'c' },
    ];
    assert.throws(() => validateRepoConfig(repos), { message: /name.*required/i });
  });

  it('throws if url is missing', () => {
    const repos = [
      { name: 'a', branch: 'b' },
      { name: 'b', url: 'https://y', branch: 'c' },
    ];
    assert.throws(() => validateRepoConfig(repos), { message: /url.*required/i });
  });

  it('throws if branch is missing', () => {
    const repos = [
      { name: 'a', url: 'https://x' },
      { name: 'b', url: 'https://y', branch: 'c' },
    ];
    assert.throws(() => validateRepoConfig(repos), { message: /branch.*required/i });
  });

  it('throws on duplicate repo names', () => {
    const repos = [
      { name: 'same', url: 'https://x', branch: 'a' },
      { name: 'same', url: 'https://y', branch: 'b' },
    ];
    assert.throws(() => validateRepoConfig(repos), { message: /duplicate.*name/i });
  });

  it('throws on unknown dependency reference', () => {
    const repos = [
      { name: 'a', url: 'https://x', branch: 'b', dependsOn: ['nonexistent'] },
      { name: 'b', url: 'https://y', branch: 'c' },
    ];
    assert.throws(() => validateRepoConfig(repos), { message: /unknown dependency/i });
  });

  it('throws on self-dependency', () => {
    const repos = [
      { name: 'a', url: 'https://x', branch: 'b', dependsOn: ['a'] },
      { name: 'b', url: 'https://y', branch: 'c' },
    ];
    assert.throws(() => validateRepoConfig(repos), { message: /cannot depend on itself/i });
  });

  it('throws on circular dependency', () => {
    const repos = [
      { name: 'a', url: 'https://x', branch: 'b', dependsOn: ['b'] },
      { name: 'b', url: 'https://y', branch: 'c', dependsOn: ['a'] },
    ];
    assert.throws(() => validateRepoConfig(repos), { message: /cycle/i });
  });
});

// ─── detectCycles ──────────────────────────────────────────────────────

describe('detectCycles', () => {
  it('returns empty array when no cycles', () => {
    const result = detectCycles(twoRepos());
    assert.equal(result.length, 0);
  });

  it('detects a simple two-node cycle', () => {
    const repos = [
      { name: 'a', dependsOn: ['b'] },
      { name: 'b', dependsOn: ['a'] },
    ];
    const result = detectCycles(repos);
    assert.ok(result.length > 0);
  });

  it('detects a three-node cycle', () => {
    const repos = [
      { name: 'a', dependsOn: ['b'] },
      { name: 'b', dependsOn: ['c'] },
      { name: 'c', dependsOn: ['a'] },
    ];
    const result = detectCycles(repos);
    assert.ok(result.length > 0);
  });

  it('handles repos with no dependencies', () => {
    const repos = [
      { name: 'a' },
      { name: 'b' },
    ];
    const result = detectCycles(repos);
    assert.equal(result.length, 0);
  });
});

// ─── buildMergeOrder ───────────────────────────────────────────────────

describe('buildMergeOrder', () => {
  it('puts upstream repos first', () => {
    const order = buildMergeOrder(twoRepos());
    assert.equal(order[0].name, 'shared-lib');
    assert.equal(order[0].mergeOrder, 1);
    assert.equal(order[1].name, 'consumer-app');
    assert.equal(order[1].mergeOrder, 2);
  });

  it('handles a three-level dependency chain', () => {
    const order = buildMergeOrder(threeRepos());
    const names = order.map(o => o.name);
    assert.equal(names[0], 'core');
    assert.ok(names.indexOf('api') < names.indexOf('web'));
  });

  it('assigns sequential merge order numbers', () => {
    const order = buildMergeOrder(threeRepos());
    assert.deepEqual(order.map(o => o.mergeOrder), [1, 2, 3]);
  });

  it('uses alphabetical order for repos at the same level', () => {
    const repos = [
      { name: 'zebra', url: 'z', branch: 'z' },
      { name: 'alpha', url: 'a', branch: 'a' },
    ];
    const order = buildMergeOrder(repos);
    assert.equal(order[0].name, 'alpha');
    assert.equal(order[1].name, 'zebra');
  });
});

// ─── Session Management ────────────────────────────────────────────────

describe('getWorkspaceRoot', () => {
  it('returns path relative to cwd', () => {
    const root = getWorkspaceRoot({ cwd: '/project' });
    assert.ok(root.includes('.cross-repo-workspace'));
  });
});

describe('getSessionPath', () => {
  it('returns path to session.json inside issue directory', () => {
    const path = getSessionPath('DVA-20', { cwd: '/project' });
    assert.ok(path.includes('DVA-20'));
    assert.ok(path.includes('session.json'));
  });
});

describe('saveSession / loadSession', () => {
  it('round-trips session data through save and load', () => {
    const stored = {};
    const deps = {
      cwd: '/project',
      writeFile: (path, data) => { stored.path = path; stored.data = data; },
      readFile: () => stored.data,
      mkdir: () => {},
      exists: () => true,
    };

    const config = { issueId: 'DVA-20', repos: [] };
    saveSession('DVA-20', config, deps);

    const loaded = loadSession('DVA-20', deps);
    assert.deepEqual(loaded, config);
  });

  it('throws when session does not exist', () => {
    const deps = {
      cwd: '/project',
      exists: () => false,
      readFile: () => { throw new Error('not found'); },
    };
    assert.throws(() => loadSession('DVA-99', deps), { message: /no cross-repo session/i });
  });
});

// ─── initWorkspace ─────────────────────────────────────────────────────

describe('initWorkspace', () => {
  it('clones repos and creates branches', () => {
    const commands = [];
    const savedSession = {};
    const deps = {
      cwd: '/project',
      runShell: (cmd) => { commands.push(cmd); return ''; },
      mkdir: () => {},
      exists: () => false,
      saveSession: (id, config) => { savedSession.id = id; savedSession.config = config; },
    };

    const repos = twoRepos();
    const session = initWorkspace('DVA-20', repos, deps);

    assert.equal(session.issueId, 'DVA-20');
    assert.equal(session.repos.length, 2);
    assert.ok(commands.some(c => c.includes('git clone')));
    assert.ok(commands.some(c => c.includes('checkout -b')));
    assert.equal(session.repos[0].mergeOrder, 1);
    assert.equal(session.repos[1].mergeOrder, 2);
    assert.equal(session.repos[0].status, 'initialized');
  });

  it('throws if session already exists', () => {
    let callCount = 0;
    const deps = {
      cwd: '/project',
      runShell: () => '',
      mkdir: () => {},
      exists: (path) => {
        // Return true for session.json check
        if (path.includes('session.json')) return true;
        return false;
      },
      saveSession: () => {},
    };

    assert.throws(
      () => initWorkspace('DVA-20', twoRepos(), deps),
      { message: /session already exists/i }
    );
  });

  it('assigns merge order based on dependency graph', () => {
    const deps = {
      cwd: '/project',
      runShell: () => '',
      mkdir: () => {},
      exists: () => false,
      saveSession: () => {},
    };

    const session = initWorkspace('DVA-20', threeRepos(), deps);
    const core = session.repos.find(r => r.name === 'core');
    const api = session.repos.find(r => r.name === 'api');
    const web = session.repos.find(r => r.name === 'web');

    assert.ok(core.mergeOrder < api.mergeOrder);
    assert.ok(api.mergeOrder < web.mergeOrder);
  });
});

// ─── buildPRDescription ────────────────────────────────────────────────

describe('buildPRDescription', () => {
  it('includes cross-repo header with issue ID', () => {
    const session = mockSession();
    const desc = buildPRDescription(session.repos[0], session);
    assert.ok(desc.includes('DVA-20'));
    assert.ok(desc.includes('Cross-Repo Change'));
  });

  it('lists related PRs with links', () => {
    const session = mockSession();
    const desc = buildPRDescription(session.repos[0], session);
    assert.ok(desc.includes('consumer-app'));
    assert.ok(desc.includes('pull/17'));
  });

  it('marks dependency relationships', () => {
    const session = mockSession();
    const desc = buildPRDescription(session.repos[1], session);
    assert.ok(desc.includes('dependency'));
    assert.ok(desc.includes('shared-lib'));
  });

  it('includes merge order for all repos', () => {
    const session = mockSession();
    const desc = buildPRDescription(session.repos[0], session);
    assert.ok(desc.includes('Merge Order'));
    assert.ok(desc.includes('1.'));
    assert.ok(desc.includes('2.'));
  });

  it('marks the current PR in the merge order', () => {
    const session = mockSession();
    const desc = buildPRDescription(session.repos[0], session);
    assert.ok(desc.includes('this PR'));
  });

  it('shows "not yet created" for PRs without URLs', () => {
    const session = mockSession();
    session.repos[1].prUrl = null;
    const desc = buildPRDescription(session.repos[0], session);
    assert.ok(desc.includes('not yet created'));
  });
});

// ─── createRepoPRs ─────────────────────────────────────────────────────

describe('createRepoPRs', () => {
  it('pushes branches and creates PRs for all repos', async () => {
    const commands = [];
    const session = mockSession();
    session.repos[0].prUrl = null;
    session.repos[0].prNumber = null;
    session.repos[1].prUrl = null;
    session.repos[1].prNumber = null;
    session.repos[0].status = 'initialized';
    session.repos[1].status = 'initialized';

    const deps = {
      runShell: (cmd) => {
        commands.push(cmd);
        if (cmd.includes('gh pr create')) {
          const name = cmd.includes('shared-lib') ? 'shared-lib' : 'consumer-app';
          return `https://github.com/org/${name}/pull/99`;
        }
        return '';
      },
      saveSession: () => {},
    };

    const { results } = await createRepoPRs(session, deps);

    assert.equal(results.length, 2);
    assert.ok(commands.some(c => c.includes('git push -u origin')));
    assert.ok(commands.some(c => c.includes('gh pr create')));
    assert.ok(results[0].prUrl.includes('/pull/'));
  });

  it('posts summary to Linear when linearComment is provided', async () => {
    const comments = [];
    const session = mockSession();
    session.repos[0].prUrl = null;
    session.repos[0].prNumber = null;
    session.repos[1].prUrl = null;
    session.repos[1].prNumber = null;

    const deps = {
      runShell: (cmd) => {
        if (cmd.includes('gh pr create')) return 'https://github.com/org/repo/pull/1';
        return '';
      },
      saveSession: () => {},
      linearComment: async (issueId, body) => { comments.push({ issueId, body }); },
    };

    await createRepoPRs(session, deps);

    assert.equal(comments.length, 1);
    assert.equal(comments[0].issueId, 'DVA-20');
    assert.ok(comments[0].body.includes('Cross-repo PRs created'));
  });
});

// ─── checkRepoStatus ───────────────────────────────────────────────────

describe('checkRepoStatus', () => {
  it('returns status for all repos', () => {
    const deps = {
      runShell: (cmd) => {
        if (cmd.includes('rev-parse')) return 'abc123';
        if (cmd.includes('status --porcelain')) return '';
        if (cmd.includes('log')) return 'abc Fix\ndef Update';
        return '';
      },
    };

    const status = checkRepoStatus(mockSession(), deps);

    assert.equal(status.issueId, 'DVA-20');
    assert.equal(status.totalRepos, 2);
    assert.equal(status.withPRs, 2);
    assert.equal(status.repos[0].commitCount, 2);
    assert.equal(status.repos[0].branchExists, true);
  });

  it('handles non-existent branches gracefully', () => {
    const deps = {
      runShell: (cmd) => {
        if (cmd.includes('rev-parse')) throw new Error('unknown revision');
        return '';
      },
    };

    const status = checkRepoStatus(mockSession(), deps);
    assert.equal(status.repos[0].branchExists, false);
    assert.equal(status.repos[0].commitCount, 0);
  });
});

// ─── formatStatusReport ────────────────────────────────────────────────

describe('formatStatusReport', () => {
  it('formats a readable table with merge order', () => {
    const status = {
      issueId: 'DVA-20',
      workspace: '/tmp/ws',
      totalRepos: 2,
      withPRs: 2,
      withChanges: 1,
      repos: [
        { name: 'lib', branch: 'b1', branchExists: true, hasChanges: false, commitCount: 3, prUrl: 'url1', prNumber: 1, mergeOrder: 1, dependsOn: [], status: 'pr-created' },
        { name: 'app', branch: 'b2', branchExists: true, hasChanges: true, commitCount: 1, prUrl: 'url2', prNumber: 2, mergeOrder: 2, dependsOn: ['lib'], status: 'pr-created' },
      ],
    };

    const report = formatStatusReport(status);
    assert.ok(report.includes('DVA-20'));
    assert.ok(report.includes('lib'));
    assert.ok(report.includes('app'));
    assert.ok(report.includes('Repos: 2'));
  });
});

// ─── flagRelatedPRs ────────────────────────────────────────────────────

describe('flagRelatedPRs', () => {
  it('flags downstream repos when upstream fails', async () => {
    const comments = [];
    const deps = {
      runShell: (cmd) => { comments.push(cmd); return ''; },
    };

    const session = mockSession();
    const { flagged, message } = await flagRelatedPRs(session, 'shared-lib', deps);

    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].name, 'consumer-app');
    assert.equal(flagged[0].relationship, 'depends on');
    assert.ok(message.includes('1 related PR'));
  });

  it('flags upstream repos when downstream fails', async () => {
    const deps = {
      runShell: () => '',
    };

    const session = mockSession();
    const { flagged } = await flagRelatedPRs(session, 'consumer-app', deps);

    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].name, 'shared-lib');
    assert.equal(flagged[0].relationship, 'is a dependency of');
  });

  it('throws when repo name not found', async () => {
    await assert.rejects(
      () => flagRelatedPRs(mockSession(), 'nonexistent'),
      { message: /not found in session/i }
    );
  });

  it('skips repos without PRs', async () => {
    const session = mockSession();
    session.repos[1].prUrl = null;
    session.repos[1].prNumber = null;

    const deps = { runShell: () => '' };
    const { flagged } = await flagRelatedPRs(session, 'shared-lib', deps);

    assert.equal(flagged.length, 0);
  });

  it('posts summary to Linear when linearComment is provided', async () => {
    const linearComments = [];
    const deps = {
      runShell: () => '',
      linearComment: async (id, body) => { linearComments.push({ id, body }); },
    };

    const session = mockSession();
    await flagRelatedPRs(session, 'shared-lib', deps);

    assert.equal(linearComments.length, 1);
    assert.ok(linearComments[0].body.includes('shared-lib'));
    assert.ok(linearComments[0].body.includes('consumer-app'));
  });
});

// ─── parseCLI ──────────────────────────────────────────────────────────

describe('parseCLI', () => {
  it('parses init command with repos JSON', () => {
    const result = parseCLI(['init', 'DVA-20', JSON.stringify(twoRepos())]);
    assert.equal(result.command, 'init');
    assert.equal(result.issueId, 'DVA-20');
    assert.equal(result.repos.length, 2);
  });

  it('parses status command', () => {
    const result = parseCLI(['status', 'DVA-20']);
    assert.equal(result.command, 'status');
    assert.equal(result.issueId, 'DVA-20');
  });

  it('parses create-prs command', () => {
    const result = parseCLI(['create-prs', 'DVA-20']);
    assert.equal(result.command, 'create-prs');
    assert.equal(result.issueId, 'DVA-20');
  });

  it('parses merge-order command', () => {
    const result = parseCLI(['merge-order', 'DVA-20']);
    assert.equal(result.command, 'merge-order');
  });

  it('parses flag command with repo name', () => {
    const result = parseCLI(['flag', 'DVA-20', 'shared-lib']);
    assert.equal(result.command, 'flag');
    assert.equal(result.repoName, 'shared-lib');
  });

  it('throws on unknown command', () => {
    assert.throws(() => parseCLI(['unknown']), { message: /unknown command/i });
  });

  it('throws on missing issue ID', () => {
    assert.throws(() => parseCLI(['status']), { message: /issue ID required/i });
  });

  it('throws on missing repo name for flag command', () => {
    assert.throws(() => parseCLI(['flag', 'DVA-20']), { message: /repo name required/i });
  });

  it('throws on missing repos JSON for init command', () => {
    assert.throws(() => parseCLI(['init', 'DVA-20']), { message: /repo configuration JSON required/i });
  });
});
