# Subagent extension

Delegates bounded tasks to isolated Pi subprocesses. Child agents inherit the parent's current model, thinking level, working directory, context-file discovery, extensions, and normal compaction behavior unless an agent profile or tool call overrides the model.

## Usage

Ask naturally, for example:

- `Use the worker subagent to implement the parser change.`
- `Run two scouts in parallel: one for API routing and one for tests.`
- `Use a chain: scout the code, then have planner create a plan using {previous}.`

The parent model calls `subagent` in one of these modes:

```ts
{ agent: "worker", task: "Implement ..." }
{ tasks: [{ agent: "scout", task: "Find ..." }, { agent: "reviewer", task: "Review ..." }] }
{ chain: [{ agent: "scout", task: "Investigate ..." }, { agent: "planner", task: "Plan from: {previous}" }] }

// Persistent role session
{ action: "run", lifecycle: "workflow", workflowId: "workflow-123", agentId: "implementer", agent: "implementer", task: "Implement ..." }
{ action: "run", lifecycle: "workflow", workflowId: "workflow-123", agentId: "reviewer", agent: "reviewer", freshSession: true, task: "Review ..." }
{ action: "list", workflowId: "workflow-123" }
{ action: "closeAgent", workflowId: "workflow-123", agentId: "implementer" }
{ action: "closeWorkflow", workflowId: "workflow-123" }
```

Parallel mode is used only when the parent explicitly supplies `tasks`. Limits are 8 tasks, 4 concurrent tasks, 30 minutes per child, and 50 KB of model-visible output per child.

## Agent profiles

Profiles live in `~/.pi/agent/agents/*.md`. Project profiles in `.pi/agents/*.md` are disabled by default and require `agentScope: "project"` or `"both"`; interactive runs ask for confirmation.

```markdown
---
name: worker
description: General implementation agent
tools: read, grep, find, ls, bash, edit, write
model: optional-provider/optional-model
thinking: medium
maxTokens: 16384
---

Agent-specific system instructions.
```

Omit `model` to inherit the parent's selected model. Thinking resolution is per-call override, then profile `thinking`, then parent level. Development-workflow injects its validated persisted role thinking as the per-call value only for workflow-lifecycle dispatches when the caller did not explicitly provide `thinking`; this happens again on resumed jobs. Terminal calls are unchanged. `maxTokens` is an optional positive-integer output limit. Its resolution is per-call override, then a persisted workflow-agent limit on resume, then profile `maxTokens`, then the development-workflow role limit. Invalid values are ignored; effective limits are clamped to the selected model's configured `maxTokens`. Terminal calls without a per-call/profile limit do not receive a token override. Supported profile thinking values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; invalid thinking profiles are ignored. A tool-call `model` override has highest priority. Tool allowlists are configured per profile; omitting `tools` uses Pi's default active tools except `subagent`.

### Profiles versus development-workflow roles

A profile selects a prompt and tools; it does not create a development-workflow authority role. Development-workflow lifecycle calls accept only exact `agentId` values `planner`, `implementer`, `test-writer`, `reviewer`, and `reporter`. Spelling variants such as `test_writer` and semantic aliases such as `auditor` are not normalized or inferred.

Use auxiliary profiles through an ordinary terminal dispatch instead:

```ts
{ agent: "researcher", task: "Investigate ..." }
```

Omit `lifecycle`, `workflowId`, and `agentId`; never invent a workflow role for an auxiliary profile.

## Isolation and lifecycle

- Terminal lifecycle (the default) preserves the original one-job behavior.
- Workflow lifecycle persists metadata under `~/.pi/agent/runtime/subagent-workflows/` and resumes the same session for a stable `(workflowId, agentId)`, including its resolved output-token limit. `freshSession: true` starts a new context without deleting a running or retained session.
- Each child gets its own persisted session directory while running.
- Successful terminal run directories and sessions are deleted after all tasks finish.
- Failed run directories remain under the system temporary directory for 24 hours, and their paths are returned to the parent.
- `closeWorkflow` is the single cleanup action used by both the `subagent` tool and trusted inter-extension requests. Concurrent requests share one in-flight close. It aborts running children (including runs still preparing their first registry write), waits for their exits, removes successful sessions and metadata, and retains only failed diagnostics for a fresh 24-hour window. Cleanup errors leave workflow metadata intact for recovery or retry. Parent cancellation propagates SIGTERM and then SIGKILL after five seconds without silently deleting resumable workflow state.
- `closeAgent` likewise waits for a running child, clears its active-widget entry, removes successful sessions, and retains aborted/failed agent diagnostics for 24 hours.
- A workflow agent rejects a concurrent run for the same stable `(workflowId, agentId)`. Workflow registry and ownership-registry updates are serialized across agents in the same workflow.
- Chains stop at the first failed child.
- Child agents cannot invoke `subagent`.

## File safety

The parent initializes a cross-process ownership registry. Files already dirty in Git are protected as `preexisting`. `edit` and `write` acquire an atomic mutation mutex and claim their canonical target path. The owning child may continue editing its claimed files; other children are blocked.

A child may issue at most one `bash` call per assistant turn; a same-turn sibling is immediately blocked with combine-commands guidance rather than waiting for the mutation mutex. `read`, `grep`, and `find` remain parallel-safe. All permitted child `bash` calls are serialized. Before shell execution, files owned by other agents are backed up. After execution, Git status and protected-file contents are checked. Newly changed files are claimed by that child; unauthorized changes are restored and reported as lock violations. Non-Git paths use canonical runtime ownership where a target is known.

This is deliberately conservative and reduces mutation parallelism. Commands that modify files outside Git and outside already known protected paths cannot always be discovered by Git status; agent prompts instruct children to use `edit`/`write` and honor lock failures.

Workflow `list` details report cumulative active run time separately from persistent idle/waiting time, so between-dispatch waiting is never charged as active execution.

## UI

The `Agents` widget shows each active agent in a boxed card with its name, elapsed time, model/thinking level, current tool call and tool duration, context usage, and lock count. While no tool is active, it shows `waiting for tool`. Cards are arranged horizontally across the available terminal width and wrap onto additional rows on narrower screens.
