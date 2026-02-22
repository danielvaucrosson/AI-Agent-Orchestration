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

## Linear Integration

The agent uses `scripts/linear.mjs` to keep Linear in sync as it works.

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
