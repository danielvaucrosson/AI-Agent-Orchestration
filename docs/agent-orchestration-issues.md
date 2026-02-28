# Agent Orchestration — Linear Issue Specs

> **Project:** Agent Orchestration *(new — create in Linear before adding issues)*
> **Team:** Dvaucrosson (DVA)
> **Default Status:** Backlog

---

## Proposed Labels

Create these labels in Linear before assigning them to issues:

| Label              | Color (suggestion) | Purpose                              |
|--------------------|-------------------|---------------------------------------|
| `orchestration`    | Blue              | Multi-agent coordination              |
| `quality`          | Green             | Guardrails, review, safety            |
| `automation`       | Orange            | Workflow automation                   |
| `observability`    | Purple            | Metrics, dashboards, learning         |
| `infrastructure`   | Gray              | Foundational / platform capabilities  |

---

## Tier 1 — High Impact, Low Complexity (Start Here)

---

### Issue 1: Agent Handoff Protocol

| Field       | Value                              |
|-------------|-------------------------------------|
| **Title**   | Agent Handoff Protocol              |
| **Priority**| High                                |
| **Labels**  | `orchestration`, `infrastructure`   |
| **Project** | Agent Orchestration                 |
| **Status**  | Backlog                             |

**Description:**

Define a structured mechanism for one agent session to hand off incomplete work to the next, ensuring continuity across sessions.

**Requirements:**
- Design a handoff format that captures: decisions made, blockers encountered, files touched, current status, and next steps
- Store handoff context in a discoverable location (`.claude/handoff.md` and/or as a structured Linear comment)
- Include a template or schema so handoffs are consistent
- Agent should auto-generate a handoff document when a session ends without completing the task
- Next agent picking up the issue should read the handoff before starting work

**Acceptance Criteria:**
- [ ] Handoff schema/template defined
- [ ] Agent writes handoff on incomplete session exit
- [ ] Agent reads and acknowledges prior handoff when resuming an issue
- [ ] Handoff includes: files changed, decisions made, blockers, next steps
- [ ] Tested with a two-session task (agent 1 starts, agent 2 finishes)

---

### Issue 2: Automatic Issue Creation from Code Analysis

| Field       | Value                                       |
|-------------|----------------------------------------------|
| **Title**   | Automatic Issue Creation from Code Analysis   |
| **Priority**| High                                          |
| **Labels**  | `automation`                                  |
| **Project** | Agent Orchestration                           |
| **Status**  | Backlog                                       |

**Description:**

Build an agent capability that scans the codebase for actionable items (TODOs, FIXMEs, bugs, test gaps, security issues) and creates corresponding Linear issues automatically.

**Requirements:**
- Scan all source files for `TODO`, `FIXME`, `HACK`, `BUG`, and `XXX` comments
- Detect test coverage gaps (source files without corresponding test files)
- Detect known anti-patterns or issues (e.g., the deliberate off-by-one bug in `math-utils.mjs`)
- Deduplicate: don't create an issue if one already exists for the same item (match by file + line or content hash)
- Created issues should include: file path, line number, surrounding context, and a suggested fix if obvious
- Add label `auto-detected` to distinguish from human-created issues

**Acceptance Criteria:**
- [ ] Script or agent command that scans codebase and reports findings
- [ ] Findings are created as Linear issues in Backlog
- [ ] Deduplication prevents repeat issues on subsequent runs
- [ ] Each issue includes file location and context
- [ ] Tested against current codebase (should find the `math-utils.mjs` bug and any TODOs)

---

### Issue 3: Agent Audit Trail

| Field       | Value                          |
|-------------|--------------------------------|
| **Title**   | Agent Audit Trail              |
| **Priority**| High                           |
| **Labels**  | `observability`, `quality`     |
| **Project** | Agent Orchestration            |
| **Status**  | Backlog                        |

**Description:**

Log every significant agent action during a task session in a structured format, enabling reviewers to understand the agent's reasoning and catch issues.

**Requirements:**
- Capture: files read, files edited (with diffs), commands run, Linear API calls, decisions made, errors encountered
- Output as a structured format (JSON or Markdown) attached to the PR as a comment or committed as an artifact
- Include timestamps and action categories
- Keep the log concise — summarize repetitive actions (e.g., "read 12 test files" rather than listing each)
- Provide a human-readable summary at the top with key stats (files changed, tests run, time elapsed)

**Acceptance Criteria:**
- [ ] Agent sessions produce a structured audit log
- [ ] Log is attached to the PR (as a comment or artifact file)
- [ ] Log includes all significant actions with timestamps
- [ ] Summary section provides quick overview
- [ ] Reviewers can trace the agent's decision-making process

---

## Tier 2 — High Impact, Medium Complexity

---

### Issue 4: PR Feedback Loop — Auto-address Review Comments

| Field       | Value                                          |
|-------------|------------------------------------------------|
| **Title**   | PR Feedback Loop — Auto-address Review Comments |
| **Priority**| Medium                                          |
| **Labels**  | `automation`                                    |
| **Project** | Agent Orchestration                             |
| **Status**  | Backlog                                         |

**Description:**

When a reviewer leaves comments on an agent-created PR, automatically trigger an agent to address the feedback, push updates, and reply to each comment.

**Requirements:**
- New GitHub Action trigger on `pull_request_review` and `issue_comment` events
- Agent reads all unresolved review comments and the overall review
- Agent makes requested changes, commits, and pushes to the same branch
- Agent replies to each review comment explaining what was done (or why it wasn't done)
- Safety: require a specific label (e.g., `agent-actionable`) or command (e.g., `/agent fix`) to trigger — don't auto-respond to every comment
- Handle edge cases: conflicting reviewer feedback, out-of-scope requests, comments on deleted lines

**Acceptance Criteria:**
- [ ] GitHub Action triggers agent on review comments with appropriate guard
- [ ] Agent addresses each review comment individually
- [ ] Agent pushes fix commits to the PR branch
- [ ] Agent replies to comments with explanation of changes
- [ ] Manual trigger mechanism prevents unwanted auto-responses

---

### Issue 5: Pre-PR Review Agent

| Field       | Value                    |
|-------------|--------------------------|
| **Title**   | Pre-PR Review Agent      |
| **Priority**| Medium                   |
| **Labels**  | `quality`                |
| **Project** | Agent Orchestration      |
| **Status**  | Backlog                  |

**Description:**

Before opening a PR, run a second agent pass that acts as an internal reviewer — checking code quality, test coverage, security, and project conventions. Gate PR creation on passing this review.

**Requirements:**
- Define quality gates: tests pass, no lint errors, no security issues (basic OWASP checks), follows project conventions from CLAUDE.md
- Run as a separate agent invocation or a pre-PR hook
- Produce a review report (pass/fail per gate with details)
- If any gate fails, post findings as a Linear comment and block PR creation
- If all gates pass, include the review report in the PR description
- Allow override with a flag for urgent fixes

**Acceptance Criteria:**
- [ ] Quality gates defined and documented
- [ ] Review agent runs before PR creation
- [ ] Report generated with pass/fail per gate
- [ ] PR blocked on failure with actionable feedback
- [ ] Override mechanism exists for urgent cases
- [ ] Review report included in successful PRs

---

### Issue 6: Dependency-Aware Task Ordering

| Field       | Value                            |
|-------------|----------------------------------|
| **Title**   | Dependency-Aware Task Ordering   |
| **Priority**| Medium                           |
| **Labels**  | `orchestration`                  |
| **Project** | Agent Orchestration              |
| **Status**  | Backlog                          |

**Description:**

Before starting work on an issue, the agent should check Linear for blocking relations and dependencies. If dependencies aren't resolved, skip to the next available task or report the blocker.

**Requirements:**
- Query Linear relations API to check for `blocks`/`blocked by` relationships
- If issue is blocked, post a comment explaining the blocker and skip to the next prioritized task
- Build a simple dependency graph for the agent's task queue
- Handle circular dependencies gracefully (detect and flag them)
- Respect priority ordering among unblocked tasks

**Acceptance Criteria:**
- [ ] Agent checks for blockers before starting an issue
- [ ] Blocked issues are skipped with a comment explaining why
- [ ] Agent picks the next highest-priority unblocked issue
- [ ] Circular dependencies are detected and flagged
- [ ] Tested with a chain of dependent issues

---

## Tier 3 — Medium Impact, Medium Complexity

---

### Issue 7: Auto-Triage Incoming Issues

| Field       | Value                        |
|-------------|------------------------------|
| **Title**   | Auto-Triage Incoming Issues  |
| **Priority**| Low                          |
| **Labels**  | `automation`                 |
| **Project** | Agent Orchestration          |
| **Status**  | Backlog                      |

**Description:**

An agent periodically scans Linear's Backlog, analyzes each issue for complexity and scope, and adds labels and metadata to help with prioritization.

**Requirements:**
- Scan all Backlog issues that lack size/complexity labels
- Analyze each issue: estimate files affected, lines of change, test impact
- Apply size labels: `size:small` (< 50 lines), `size:medium` (50-200 lines), `size:large` (> 200 lines)
- Flag issues that need clarification with a `needs-clarification` label and a comment asking specific questions
- Suggest priority based on issue type (bug > feature > chore) and impact
- Run as an on-demand script or scheduled task

**Acceptance Criteria:**
- [ ] Agent scans Backlog issues and applies size labels
- [ ] Unclear issues flagged with `needs-clarification` and a comment
- [ ] Priority suggestions added as comments (not overriding human-set priorities)
- [ ] Idempotent: re-running doesn't duplicate labels or comments
- [ ] Tested with a mix of clear and ambiguous issues

---

### Issue 8: Conflict Detection Between Concurrent Agents

| Field       | Value                                          |
|-------------|------------------------------------------------|
| **Title**   | Conflict Detection Between Concurrent Agents   |
| **Priority**| Low                                             |
| **Labels**  | `orchestration`, `quality`                      |
| **Project** | Agent Orchestration                             |
| **Status**  | Backlog                                         |

**Description:**

When multiple agents work on related branches simultaneously, detect potential merge conflicts early and warn before they become costly to resolve.

**Requirements:**
- GitHub Action or pre-push hook that compares touched files across all active `feature/*` and `fix/*` branches
- If two in-progress branches modify the same files, post a warning as a Linear comment on both issues
- Include details: which files overlap, which branches, who is working on what
- Severity levels: `info` (same directory), `warning` (same file), `critical` (same function/lines)
- Optional: suggest coordination (e.g., "consider rebasing DVA-5 before pushing DVA-7")

**Acceptance Criteria:**
- [ ] Active branch comparison detects file-level overlaps
- [ ] Warnings posted to relevant Linear issues
- [ ] Severity levels correctly categorized
- [ ] Works as a GitHub Action or local hook
- [ ] Tested with two branches modifying the same file

---

### Issue 9: Rollback Orchestration

| Field       | Value                          |
|-------------|--------------------------------|
| **Title**   | Rollback Orchestration         |
| **Priority**| Low                            |
| **Labels**  | `quality`, `automation`        |
| **Project** | Agent Orchestration            |
| **Status**  | Backlog                        |

**Description:**

If a merged PR causes test failures on `main`, automatically create a revert PR, move the original Linear issue back to "In Progress", and notify stakeholders.

**Requirements:**
- Monitor `main` branch CI status after merges
- If tests fail, identify the most recent merge commit as the likely culprit
- Auto-create a revert PR with a clear title (e.g., "Revert DVA-5: [original title]")
- Move the original Linear issue from "Done" back to "In Progress"
- Post a Linear comment with failure details, logs, and the revert PR link
- Don't auto-merge the revert — require human approval
- Handle edge cases: multiple merges in quick succession, flaky tests

**Acceptance Criteria:**
- [ ] CI failure on main triggers rollback investigation
- [ ] Revert PR created automatically with proper title and context
- [ ] Linear issue moved back to "In Progress" with failure details
- [ ] Revert PR requires human approval to merge
- [ ] Flaky test detection prevents unnecessary reverts

---

## Tier 4 — High Impact, High Complexity (Ambitious)

---

### Issue 10: Multi-Agent Task Decomposition

| Field       | Value                                    |
|-------------|------------------------------------------|
| **Title**   | Multi-Agent Task Decomposition           |
| **Priority**| Low                                       |
| **Labels**  | `orchestration`, `infrastructure`         |
| **Project** | Agent Orchestration                       |
| **Status**  | Backlog                                   |

**Description:**

A "lead" agent receives a complex issue, breaks it into sub-tasks in Linear, then spawns child agents to work on each sub-task in parallel. The lead agent monitors progress and merges results.

**Dependencies:** Agent Handoff Protocol (#1), Conflict Detection (#8)

**Requirements:**
- Lead agent analyzes a complex issue and decomposes it into independent sub-tasks
- Sub-tasks created as Linear sub-issues linked to the parent
- Each sub-task gets its own branch (e.g., `feature/DVA-10a-subtask-1`, `feature/DVA-10b-subtask-2`)
- Lead agent monitors child progress via Linear status
- When all sub-tasks are done, lead agent merges branches and creates a unified PR
- Handle failures: if one child fails, the lead agent can reassign or complete the sub-task itself

**Acceptance Criteria:**
- [ ] Lead agent decomposes issue into sub-tasks in Linear
- [ ] Sub-tasks executed in parallel on separate branches
- [ ] Lead agent monitors and coordinates progress
- [ ] Results merged into a single PR
- [ ] Failure recovery: lead handles failed sub-tasks
- [ ] Tested with a task that has 3+ independent sub-tasks

---

### Issue 11: Scheduled Agent Runs — Cron-Based Task Pickup

| Field       | Value                                          |
|-------------|------------------------------------------------|
| **Title**   | Scheduled Agent Runs — Cron-Based Task Pickup  |
| **Priority**| Low                                             |
| **Labels**  | `automation`, `infrastructure`                  |
| **Project** | Agent Orchestration                             |
| **Status**  | Backlog                                         |

**Description:**

A GitHub Action runs on a schedule, checks Linear for "Todo" issues, and triggers an agent to autonomously pick up and complete the highest-priority task.

**Requirements:**
- GitHub Action with `schedule` trigger (e.g., daily or every 6 hours)
- Query Linear for highest-priority "Todo" issue in team DVA
- Invoke Claude Code agent to pick up and work on the issue
- Agent follows full workflow: move to "In Progress", create branch, do work, open PR
- Rate limiting: max N issues per day to prevent runaway costs
- Kill switch: repository variable `AGENT_AUTOPILOT=false` disables scheduled runs
- Notification: post to a configurable channel (Linear comment, GitHub issue) when an agent starts/finishes

**Acceptance Criteria:**
- [ ] Scheduled GitHub Action runs on cron
- [ ] Picks highest-priority "Todo" issue from Linear
- [ ] Agent completes full workflow autonomously
- [ ] Rate limiting prevents excessive runs
- [ ] Kill switch immediately disables autopilot
- [ ] Notifications sent on agent start/finish

---

### Issue 12: Cross-Repo Orchestration

| Field       | Value                                    |
|-------------|------------------------------------------|
| **Title**   | Cross-Repo Orchestration                 |
| **Priority**| Low                                       |
| **Labels**  | `orchestration`, `infrastructure`         |
| **Project** | Agent Orchestration                       |
| **Status**  | Backlog                                   |

**Description:**

Extend the agent workflow to coordinate changes across multiple repositories, linking multiple PRs to a single Linear issue for atomic feature delivery.

**Dependencies:** Conflict Detection (#8), Rollback Orchestration (#9)

**Requirements:**
- Agent can clone/checkout multiple repos in a single session
- Changes in each repo get their own branch and PR
- All PRs linked to the same Linear issue
- Coordination: agent understands inter-repo dependencies (e.g., API change in repo A requires client update in repo B)
- Merge ordering: document or enforce which PR should merge first
- Rollback: if one PR fails review, flag the related PRs

**Acceptance Criteria:**
- [ ] Agent can work across 2+ repositories in one session
- [ ] Separate PRs created per repo, all linked to one Linear issue
- [ ] Inter-repo dependencies documented in PR descriptions
- [ ] Merge ordering guidance provided
- [ ] Tested with a two-repo change (e.g., shared lib + consumer)

---

## Tier 5 — Long-Term / Research

---

### Issue 13: Agent Performance Dashboard

| Field       | Value                          |
|-------------|--------------------------------|
| **Title**   | Agent Performance Dashboard    |
| **Priority**| None                           |
| **Labels**  | `observability`                |
| **Project** | Agent Orchestration            |
| **Status**  | Backlog                        |

**Description:**

Track and visualize agent performance metrics across sessions: time to completion, commit count, test pass rate, PR review iterations, and lines changed.

**Dependencies:** Agent Audit Trail (#3)

**Requirements:**
- Define key metrics: cycle time (issue created -> PR merged), commit count, test results, lines changed, review rounds
- Collect metrics from Git history, GitHub API, and Linear API
- Store metrics in a lightweight format (JSON file or SQLite)
- Generate a dashboard (simple HTML page or Markdown report)
- Trend analysis: show improvement or regression over time

**Acceptance Criteria:**
- [ ] Metrics defined and documented
- [ ] Data collection from Git, GitHub, and Linear
- [ ] Dashboard renders key metrics with trends
- [ ] Updated automatically after each agent session or on demand
- [ ] Tested with data from 5+ completed agent tasks

---

### Issue 14: Failure Pattern Detection

| Field       | Value                          |
|-------------|--------------------------------|
| **Title**   | Failure Pattern Detection      |
| **Priority**| None                           |
| **Labels**  | `observability`                |
| **Project** | Agent Orchestration            |
| **Status**  | Backlog                        |

**Description:**

Analyze historical agent sessions to identify recurring failure patterns and generate actionable insights for improving agent instructions and workflow configuration.

**Dependencies:** Agent Audit Trail (#3), Agent Performance Dashboard (#13)

**Requirements:**
- Parse audit trails from completed agent sessions
- Categorize failures: test failures, lint errors, merge conflicts, Linear API errors, timeout, wrong approach
- Identify patterns: which types of issues cause most failures, which files are most error-prone, which steps take longest
- Generate a report with recommendations (e.g., "agents fail 40% of the time on issues touching auth.mjs — consider adding more context to CLAUDE.md")
- Optionally: auto-update CLAUDE.md with learned best practices

**Acceptance Criteria:**
- [ ] Failure categories defined and documented
- [ ] Historical session data parsed and categorized
- [ ] Pattern detection identifies top 3 failure modes
- [ ] Report includes actionable recommendations
- [ ] Tested with data from 10+ agent sessions (can use synthetic data initially)

---

## Summary Table

| # | Title | Priority | Labels | Tier | Dependencies |
|---|-------|----------|--------|------|--------------|
| 1 | Agent Handoff Protocol | High | `orchestration`, `infrastructure` | 1 | — |
| 2 | Automatic Issue Creation from Code Analysis | High | `automation` | 1 | — |
| 3 | Agent Audit Trail | High | `observability`, `quality` | 1 | — |
| 4 | PR Feedback Loop | Medium | `automation` | 2 | — |
| 5 | Pre-PR Review Agent | Medium | `quality` | 2 | — |
| 6 | Dependency-Aware Task Ordering | Medium | `orchestration` | 2 | — |
| 7 | Auto-Triage Incoming Issues | Low | `automation` | 3 | — |
| 8 | Conflict Detection Between Concurrent Agents | Low | `orchestration`, `quality` | 3 | — |
| 9 | Rollback Orchestration | Low | `quality`, `automation` | 3 | — |
| 10 | Multi-Agent Task Decomposition | Low | `orchestration`, `infrastructure` | 4 | #1, #8 |
| 11 | Scheduled Agent Runs | Low | `automation`, `infrastructure` | 4 | — |
| 12 | Cross-Repo Orchestration | Low | `orchestration`, `infrastructure` | 4 | #8, #9 |
| 13 | Agent Performance Dashboard | None | `observability` | 5 | #3 |
| 14 | Failure Pattern Detection | None | `observability` | 5 | #3, #13 |
