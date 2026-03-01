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

7. **If the task is incomplete**, generate a handoff document before ending your session:
   - Write a handoff file to `.claude/handoffs/<ISSUE-ID>.md` following the template in `.claude/handoff-template.md`
   - Include: current state, files changed, decisions made, blockers, and next steps
   - Post the handoff summary as a Linear comment so the next agent can find it
   - The stop hook will remind you if you forget

8. **When resuming an issue**, check for an existing handoff first:
   - Read `.claude/handoffs/<ISSUE-ID>.md` if it exists
   - Acknowledge the prior session's state before continuing
   - After completing the task, clean up the handoff: `node scripts/handoff.mjs clean <ISSUE-ID>`

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

**Code scanner** (`scripts/scan.mjs`) — scans codebase for actionable issues:
```bash
node scripts/scan.mjs                        # Scan and print findings
node scripts/scan.mjs --json                 # Output as JSON
node scripts/scan.mjs create --dry-run       # Preview Linear issue creation
node scripts/scan.mjs create                 # Create issues (needs LINEAR_API_KEY)
```
Scans for: comment markers (TODO/FIXME/HACK/BUG/XXX), test coverage gaps, and anti-patterns.
Issues are created with the `auto-detected` label and deduplicated via content hashing.

**Handoff utility** (`scripts/handoff.mjs`) — no env vars needed:
```bash
node scripts/handoff.mjs check DVA-9        # Check if a handoff exists
node scripts/handoff.mjs read DVA-9         # Read an existing handoff
node scripts/handoff.mjs list               # List all active handoffs
node scripts/handoff.mjs clean DVA-9        # Remove handoff after completion
node scripts/handoff.mjs template           # Print the handoff template
```

**Task ordering** (`scripts/task-ordering.mjs`) — dependency-aware task selection:
```bash
node scripts/task-ordering.mjs next  --team DVA           # Pick the next unblocked task
node scripts/task-ordering.mjs order --team DVA           # Show all tasks in execution order
node scripts/task-ordering.mjs check DVA-18               # Check if a task is blocked
node scripts/task-ordering.mjs graph --team DVA           # Display the dependency graph
node scripts/task-ordering.mjs next  --project "Agent Orchestration" --json
```
Queries Linear for issues and their `blocks`/`blockedBy` relations, builds a dependency graph, detects circular dependencies, and recommends the optimal execution order respecting both dependencies and priority. Requires `LINEAR_API_KEY`.

### What the GitHub Action Handles (do NOT duplicate)

| Git Event           | Linear Update                              |
|---------------------|--------------------------------------------|
| Push to branch      | Issue → **In Progress** + commit link      |
| PR opened           | Issue → **In Review** + PR attached        |
| PR merged           | Issue → **Done**                           |
| PR review + label   | Collects feedback for agent processing     |
| `/agent fix` comment| Collects feedback for agent processing     |

After pushing or opening a PR, the GitHub Action handles status transitions. Do not manually set "In Review" or "Done" after these events — it would be redundant.

### When to Manually Update Linear

- **Before first push:** Move to "In Progress" and comment your plan
- **During work (pre-push):** Comment on significant decisions or blockers
- **After finishing work (pre-push):** Comment a summary of what was accomplished
- **On incomplete session exit:** Write a handoff document and post the summary to Linear

## PR Feedback Loop

When a reviewer leaves comments on an agent-created PR, the feedback can be automatically collected and structured for agent processing.

### Trigger Mechanisms

The `pr-feedback.yml` GitHub Action triggers when:
- A reviewer submits a review on a PR with the `agent-actionable` label
- Someone comments `/agent fix` on a PR

### CLI Utility

```bash
node scripts/pr-feedback.mjs collect --pr 7 --output /tmp/feedback.json   # Fetch review comments
node scripts/pr-feedback.mjs prompt  --input /tmp/feedback.json            # Generate agent prompt
node scripts/pr-feedback.mjs summary --input /tmp/feedback.json            # Show summary stats
node scripts/pr-feedback.mjs reply   --pr 7 --input /tmp/feedback.json     # Post replies
```

### How It Works

1. Reviewer leaves comments on a PR (either inline on code or general review comments)
2. Trigger fires: either via `agent-actionable` label + review, or `/agent fix` command
3. The action collects all unresolved review comments via GitHub API
4. Comments are categorized by priority (high/medium/low) and type (bug, security, change-request, suggestion, style)
5. A structured prompt is generated with file paths, line numbers, diff context, and reviewer feedback
6. The agent (when integrated) addresses each comment, commits fixes, and replies

### Safety

- **Opt-in only:** PRs must have the `agent-actionable` label or someone must comment `/agent fix`
- **No auto-responses:** The agent doesn't react to every comment
- **Non-actionable filtering:** LGTM, emoji reactions, and "resolved" markers are automatically skipped

## Environment

- Run `npm install` before using Linear CLI scripts
- `LINEAR_API_KEY` env var needed only for CLI fallback (not for MCP tools)
- Node.js 20+ required
