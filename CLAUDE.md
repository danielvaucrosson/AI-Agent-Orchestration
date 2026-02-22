# Project: AI Agent Workflow Sandbox

Tasks are managed in Linear and executed by AI agents via Claude Code. Work is delivered as pull requests for human review.

## Linear Integration

**Team:** Dvaucrosson (key: `DVA`)
**Statuses:** Backlog → Todo → In Progress → In Review → Done (also: Canceled, Duplicate)

### Workflow Protocol

When you receive a task referencing a Linear issue (e.g., DVA-5), or are asked to pick up work:

1. **Find the task.** Run:
   ```bash
   LINEAR_API_KEY="$LINEAR_API_KEY" node scripts/linear.mjs status DVA-<N> "In Progress"
   ```

2. **Post a comment** explaining what you plan to do:
   ```bash
   LINEAR_API_KEY="$LINEAR_API_KEY" node scripts/linear.mjs comment DVA-<N> "Starting work: <brief plan>"
   ```

3. **Create a branch** with the issue ID in the name:
   ```
   feature/DVA-<N>-short-description
   fix/DVA-<N>-short-description
   ```

4. **Do the work.** Post comments on Linear for significant milestones only — not every file edit. Good reasons to comment: encountering a blocker, making an architectural decision, completing a major step.

5. **Commit, push, and create a PR.** Include the issue ID in the PR title (e.g., `DVA-5: Add README`). The GitHub Action will automatically move the issue to "In Review" and link the PR.

6. **Post a completion comment** summarizing what was done:
   ```bash
   LINEAR_API_KEY="$LINEAR_API_KEY" node scripts/linear.mjs comment DVA-<N> "Work complete: <summary>"
   ```

### What the GitHub Action Handles (do NOT duplicate)

| Git Event       | Linear Update                              |
|-----------------|--------------------------------------------|
| Push to branch  | Issue → **In Progress** + commit link      |
| PR opened       | Issue → **In Review** + PR attached        |
| PR merged       | Issue → **Done**                           |

After pushing or opening a PR, the GitHub Action handles status transitions. Do not manually set "In Review" or "Done" after these events — it would be redundant.

### When to Manually Update Linear

- **Before first push:** Move to "In Progress" and comment your plan
- **During work (pre-push):** Comment on significant decisions or blockers
- **After finishing work (pre-push):** Comment a summary of what was accomplished
- Use `scripts/linear.mjs` CLI commands — these work reliably in all environments

### Available CLI Commands

```bash
# Test connection
LINEAR_API_KEY="$LINEAR_API_KEY" node scripts/linear.mjs test

# Update issue status
LINEAR_API_KEY="$LINEAR_API_KEY" node scripts/linear.mjs status DVA-1 "In Progress"

# Add a comment
LINEAR_API_KEY="$LINEAR_API_KEY" node scripts/linear.mjs comment DVA-1 "Starting work on this"

# Link a PR
LINEAR_API_KEY="$LINEAR_API_KEY" node scripts/linear.mjs link-pr DVA-1 https://github.com/danielvaucrosson/Test/pull/1

# List workflow states
LINEAR_API_KEY="$LINEAR_API_KEY" node scripts/linear.mjs states
```

## Environment

- `LINEAR_API_KEY` must be set as an environment variable
- Run `npm install` before using Linear scripts
- Node.js 20+ required
