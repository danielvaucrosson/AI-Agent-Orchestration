# Orchestration Decision Framework

How to choose the right level of agent orchestration for a given task. Default to the simplest effective approach; escalate only when needed.

## Escalation Ladder

### Level 0 — Just Do It

Single agent works through tasks sequentially. No orchestration overhead.

**When:** ≤3 related tasks, shared context, overlapping files, total work is < ~1 hour of agent time.

### Level 1 — Sequential Subagents (Superpowers SDD)

Controller dispatches one subagent at a time with two-stage review loops (spec compliance → code quality).

**When:** 3+ tasks from a plan, tasks touch overlapping files, you want review discipline, but the work is still one coherent feature.

**Why not Level 0:** Fresh context per task prevents confusion on longer work; review loops catch drift.

### Level 2 — Parallel Dispatch (Superpowers)

Multiple agents work concurrently on truly independent domains.

**When:** 2+ tasks that touch **completely different files/subsystems**, no shared state, and you'd benefit from speed.

**Why not Level 1:** Sequential execution is wasteful when tasks genuinely can't conflict.

### Level 3 — Multi-Agent Task Decomposition (DVA-18)

Lead agent decomposes a complex issue, creates Linear sub-issues, runs parallel branches, monitors progress, merges results.

**When:** Complex issue requiring autonomous decomposition, team visibility via Linear, multi-branch merging, and failure recovery.

**Why not Level 2:** You need external tracking, the decomposition itself is non-trivial, or multiple people need to see progress.

## Decision Test

Ask these three questions in order:

1. **Can one agent hold this in context and just do it?** → Level 0
2. **Do the tasks touch the same files?** → Yes: Level 1 (sequential). No: continue.
3. **Does the team need visibility, or is the decomposition itself complex?** → Yes: Level 3. No: Level 2.

## Guiding Principles

- **Most work stays at Level 0 or 1.** Parallel orchestration only pays off when tasks are genuinely independent.
- **Shared config, types, and integration points create subtle dependencies** that make sequential execution safer than it appears.
- **The biggest risk is over-orchestrating.** Parallel agents touching overlapping files create merge conflicts and duplicated work that cost more than sequential execution.
- **DVA-16 (Conflict Detection) mitigates parallel risk**, but the simplest mitigation is not parallelizing unless independence is clear-cut.

## Relationship Between Approaches

| Aspect | Level 1 (SDD) | Level 2 (Parallel) | Level 3 (DVA-18) |
|--------|---------------|--------------------|--------------------|
| Execution | Sequential | Concurrent | Concurrent |
| Task source | Pre-written plan | Controller identifies domains | Lead agent decomposes autonomously |
| Tracking | TodoWrite (in-session) | Agent return summaries | Linear sub-issues |
| Review | Two-stage per task | Post-merge integration test | Two-stage per sub-task |
| Branch strategy | Single worktree | Not specified | Per-subtask branches |
| Failure handling | Fix based on reviewer feedback | Review for conflicts | Lead reassigns or self-completes |

DVA-18 builds on superpowers patterns (especially SDD's review protocol) and adds Linear-native tracking, parallel branch execution, and autonomous decomposition.
