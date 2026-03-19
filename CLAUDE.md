# Project: AI Agent Workflow Sandbox

Tasks are managed in Linear and executed by AI agents via Claude Code. Work is delivered as pull requests for human review.

## Linear Integration

**Team:** Dvaucrosson (key: `DVA`)
**Statuses:** Backlog → Todo → In Progress → In Review → Done (also: Canceled, Duplicate)

### Workflow Protocol

When you receive a task referencing a Linear issue (e.g., DVA-5), or are asked to pick up work:

0. **Ensure a Linear issue exists.** If you're fixing a bug or making a change that doesn't have a Linear issue yet, create one first using the Linear MCP `save_issue` tool. Use the `Bug` label for bugs and appropriate labels for other work. Unless specified otherwise, add all new issues to the **Agent Orchestration** project. All changes must be tracked in Linear.

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

5. **Run the pre-PR review** before creating a pull request:
   ```bash
   node scripts/pre-pr-review.mjs
   ```
   This runs 5 quality gates (tests, security, conventions, code quality, diff size). If any gate fails, fix the issues before proceeding. The PreToolUse hook will block `gh pr create` if no recent review has passed.

6. **Commit, push, and create a PR.** Include the issue ID in the PR title (e.g., `DVA-5: Add README`). The GitHub Action will automatically move the issue to "In Review" and link the PR.

7. **Post a completion comment** summarizing what was done using Linear MCP `create_comment` or the CLI fallback.

8. **If the task is incomplete**, generate a handoff document before ending your session:
   - Write a handoff file to `.claude/handoffs/<ISSUE-ID>.md` following the template in `.claude/handoff-template.md`
   - Include: current state, files changed, decisions made, blockers, and next steps
   - Post the handoff summary as a Linear comment so the next agent can find it
   - The stop hook will remind you if you forget

9. **When resuming an issue**, check for an existing handoff first:
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

**Audit trail** (`scripts/audit.mjs`) — auto-populated by hooks, no env vars needed:
```bash
node scripts/audit.mjs init                           # Start a new audit session
node scripts/audit.mjs log decision "Chose X over Y"  # Add manual log entry
node scripts/audit.mjs summary                        # Print session stats
node scripts/audit.mjs export                         # Export full trail as Markdown
node scripts/audit.mjs attach 5                       # Post trail as PR #5 comment
node scripts/audit.mjs clear                          # Remove session log
```

**Handoff utility** (`scripts/handoff.mjs`) — no env vars needed:
```bash
node scripts/handoff.mjs check DVA-9        # Check if a handoff exists
node scripts/handoff.mjs read DVA-9         # Read an existing handoff
node scripts/handoff.mjs list               # List all active handoffs
node scripts/handoff.mjs clean DVA-9        # Remove handoff after completion
node scripts/handoff.mjs template           # Print the handoff template
```

**Auto-triage** (`scripts/auto-triage.mjs`) — size estimation and issue triage:
```bash
node scripts/auto-triage.mjs scan                    # Preview triage results
node scripts/auto-triage.mjs scan --json             # JSON output
node scripts/auto-triage.mjs triage --dry-run        # Preview changes
node scripts/auto-triage.mjs triage                  # Apply labels + comments
node scripts/auto-triage.mjs triage --team DVA       # Specify team
```
Scans Backlog issues for size/complexity signals and applies labels. Idempotent — skips already-triaged issues.

| Label | Scope |
|-------|-------|
| `size:small` | < 50 estimated lines of change |
| `size:medium` | 50-200 estimated lines of change |
| `size:large` | > 200 estimated lines of change |
| `needs-clarification` | Issue lacks detail for implementation |

Requires `LINEAR_API_KEY`.

**Task ordering** (`scripts/task-ordering.mjs`) — dependency-aware task selection:
```bash
node scripts/pre-pr-review.mjs                    # Run all 5 gates
node scripts/pre-pr-review.mjs --gate security     # Run a single gate
node scripts/pre-pr-review.mjs --json              # Output JSON results
node scripts/pre-pr-review.mjs --report report.md  # Write Markdown report
node scripts/pre-pr-review.mjs --force             # Always exit 0
node scripts/pre-pr-review.mjs --help              # Show usage
```

**Quality gates:**
| Gate          | Checks                                           |
|---------------|--------------------------------------------------|
| `tests`       | Runs `npm test` and verifies all tests pass      |
| `security`    | Scans for hardcoded secrets, tokens, unsafe APIs |
| `conventions` | Branch naming, test coverage, script docs        |
| `codeQuality` | TODO markers, console.log, empty catch blocks    |
| `diffSize`    | Warns on large diffs (>1000 lines)               |

**PreToolUse hook** (`.claude/hooks/pre-pr-check.mjs`):
- Automatically intercepts `gh pr create` commands
- Blocks PR creation if no review has passed in the last 30 minutes
- Bypass with `--force` or `--skip-review` flag on the `gh pr create` command

### What the GitHub Action Handles (do NOT duplicate)

| Git Event           | Linear Update                              |
|---------------------|--------------------------------------------|
| Branch created      | Issue → **In Progress**                    |
| Push to branch      | Commit link posted                         |
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

## Audit Trail

Agent sessions are automatically logged by `PreToolUse` and `PostToolUse` hooks. The raw log is stored at `.claude/audit/current.jsonl` (gitignored). Key points:

- **Automatic:** Tool invocations are captured automatically — no manual action needed
- **Manual entries:** Use `node scripts/audit.mjs log <category> <message>` to log decisions, blockers, or architectural notes that hooks can't capture
- **Export:** Run `node scripts/audit.mjs export` to generate a Markdown summary
- **PR attachment:** Run `node scripts/audit.mjs attach <pr-number>` after creating a PR to post the audit trail as a collapsible comment
- **Session lifecycle:** Logs are cleared when you run `init` or `clear`. The stop hook will remind you to export before finishing.

## Orchestration

Before choosing how to execute multi-step work, consult `docs/superpowers/orchestration-decision-framework.md`. Default to the simplest approach (Level 0: just do it) and only escalate when tasks are genuinely independent or require team visibility.

**Orchestrator** (`scripts/orchestrator.mjs`) — multi-agent task decomposition:
```bash
node scripts/orchestrator.mjs create-subtasks DVA-18 '[...]'  # Create sub-issues + branches
node scripts/orchestrator.mjs status DVA-18                    # Check sub-task progress
node scripts/orchestrator.mjs merge DVA-18 --into main         # Merge completed branches
node scripts/orchestrator.mjs recover DVA-18                   # Recovery plan for failures
```

The lead agent can also use Linear MCP tools directly for sub-issue creation and monitoring.

**Review protocol:** Each sub-task must pass a two-stage review before its branch is merged:
1. **Spec compliance** — does the implementation match requirements?
2. **Code quality** — is the code well-structured, tested, and maintainable?

Worker agents should run `node scripts/pre-pr-review.mjs` on their sub-task branch before marking the sub-issue as Done.

## Environment

- Run `npm install` before using Linear CLI scripts
- `LINEAR_API_KEY` env var needed only for CLI fallback (not for MCP tools)
- Node.js 20+ required
