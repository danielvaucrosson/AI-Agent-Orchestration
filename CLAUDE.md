# Project: AI Agent Workflow Sandbox

Tasks are managed in Linear and executed by AI agents via Claude Code. Work is delivered as pull requests for human review.

## Linear Integration

**Team:** Dvaucrosson (key: `DVA`)
**Statuses:** Backlog → Todo → In Progress → In Review → Done (also: Canceled, Duplicate)

### Workflow Protocol

When you receive a task referencing a Linear issue (e.g., DVA-5), or are asked to pick up work:

1. **Move the issue to "In Progress".** Use the Linear MCP `update_issue` tool:
   - Set `id` to the issue identifier (e.g., `DVA-5`)
   - Set `state` to `"In Progress"`

   Fallback CLI: `LINEAR_API_KEY="$LINEAR_API_KEY" node scripts/linear.mjs status DVA-<N> "In Progress"`

2. **Post a comment** explaining what you plan to do. Use the Linear MCP `create_comment` tool:
   - Set `issueId` to the issue ID (use `get_issue` first to resolve the identifier to an ID)
   - Set `body` to your plan summary

   Fallback CLI: `LINEAR_API_KEY="$LINEAR_API_KEY" node scripts/linear.mjs comment DVA-<N> "Starting work: <brief plan>"`

3. **Create a branch** with the issue ID in the name:
   ```
   feature/DVA-<N>-short-description
   fix/DVA-<N>-short-description
   ```

4. **Do the work.** Post comments on Linear for significant milestones only — not every file edit. Good reasons to comment: encountering a blocker, making an architectural decision, completing a major step.

5. **Commit, push, and create a PR.** Include the issue ID in the PR title (e.g., `DVA-5: Add README`). The GitHub Action will automatically move the issue to "In Review" and link the PR.

6. **Post a completion comment** summarizing what was done using Linear MCP `create_comment` or the CLI fallback.

### Preferred Tools

**Use Linear MCP tools when available** (they are faster and don't need env vars):
- `get_issue` — fetch issue details by identifier (e.g., `DVA-5`)
- `update_issue` — change status, assignee, labels, etc.
- `create_comment` — post comments on issues
- `list_issues` — find tasks (filter by `team`, `label`, `state`)
- `list_issue_statuses` — see available workflow states

**Fall back to CLI** (`scripts/linear.mjs`) when MCP tools are unavailable:
```bash
node scripts/linear.mjs test                          # Test connection
node scripts/linear.mjs status DVA-1 "In Progress"   # Update status
node scripts/linear.mjs comment DVA-1 "Starting work" # Add comment
node scripts/linear.mjs link-pr DVA-1 <pr-url>        # Link a PR
node scripts/linear.mjs states                         # List states
```
CLI requires `LINEAR_API_KEY` environment variable.

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

## Environment

- Run `npm install` before using Linear CLI scripts
- `LINEAR_API_KEY` env var needed only for CLI fallback (not for MCP tools)
- Node.js 20+ required
