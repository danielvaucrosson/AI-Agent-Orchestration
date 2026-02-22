# Test

A sandbox repository for validating AI agent workflows. Tasks are managed in Linear and executed by AI agents via Claude Code, with results delivered as pull requests for human review.

## Workflow

1. Create a well-defined issue in Linear
2. An AI agent picks up the task and moves it to **In Progress**
3. The agent works on a feature branch, adding comments as it goes
4. A pull request is opened and linked to the Linear issue
5. The issue moves to **In Review**
6. A human reviews, provides feedback, and merges

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and add your Linear API key
```

## Automatic Linear Sync (GitHub Action)

A GitHub Action (`.github/workflows/linear-sync.yml`) keeps Linear updated automatically based on git activity. No extra work is needed from the agent — just include the Linear issue ID somewhere in the branch name, PR title, or PR body (e.g. `feature/TES-42-add-widget`).

| Event | Linear Update |
|---|---|
| **Push to branch** | Issue → **In Progress**, comment with commit link |
| **PR opened** | Issue → **In Review**, PR attached |
| **PR merged** | Issue → **Done** |

### Setup

1. Go to **Settings → Secrets and variables → Actions** in your GitHub repo.
2. Add a repository secret called `LINEAR_API_KEY` with your Linear API key.
3. That's it — the workflow runs on every push and PR event.

To disable the sync without removing the workflow, set a repository variable `LINEAR_ENABLED` to `false`.

## Linear CLI (manual)

The agent can also use `scripts/linear.mjs` to update Linear manually.

```bash
# Test your connection
LINEAR_API_KEY=your_key node scripts/linear.mjs test

# Update issue status
LINEAR_API_KEY=your_key node scripts/linear.mjs status TES-1 "In Progress"

# Add a comment
LINEAR_API_KEY=your_key node scripts/linear.mjs comment TES-1 "Starting work"

# Link a pull request
LINEAR_API_KEY=your_key node scripts/linear.mjs link-pr TES-1 https://github.com/user/repo/pull/1

# List available workflow states
LINEAR_API_KEY=your_key node scripts/linear.mjs states
```

Set `LINEAR_API_KEY` in your environment to skip passing it each time.
