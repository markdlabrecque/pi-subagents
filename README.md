# Subagent extension

Delegates bounded tasks to isolated Pi subprocesses. Ordinary calls use a built-in general-purpose agent and need no profile files. Children inherit the parent's model, thinking level, working directory, context-file discovery, extensions and normal compaction behavior. Calls can override model, thinking, cwd, timeout and output limit.

## Usage

Ask naturally, for example:

- `Delegate the parser change to a subagent.`
- `Run two subagents in parallel: one for API routing and one for tests.`
- `Use a chain: investigate the code, then plan using {previous}.`

The parent model calls `subagent` in one of these modes:

```ts
{ task: "Implement ..." }
{ tasks: [{ task: "Find ..." }, { task: "Review ..." }] }
{ chain: [{ task: "Investigate ..." }, { task: "Plan from: {previous}" }] }

// Persistent role session
{ action: "run", lifecycle: "workflow", workflowId: "workflow-123", agentId: "implementer", task: "Implement ..." }
{ action: "run", lifecycle: "workflow", workflowId: "workflow-123", agentId: "reviewer", freshSession: true, task: "Review ..." }
{ action: "list", workflowId: "workflow-123" }
{ action: "closeAgent", workflowId: "workflow-123", agentId: "implementer" }
{ action: "closeWorkflow", workflowId: "workflow-123" }
```

### Background runs

Single, parallel (`tasks`), and chain calls accept `background: true`. The tool returns a job id at once, so the parent can keep working or answer the user. One job covers the whole call: cancelling it stops every child in the batch or chain, and once the last child ends, the combined result is posted to the session as a `subagent-background-result` follow-up message that wakes the parent.

```ts
{ task: "Review ...", background: true }   // -> "Started background subagent bg-1 ..."
{ tasks: [{ task: "..." }, { task: "..." }], background: true }   // one job, bg-2
{ action: "list" }                                            // shows running background jobs
{ action: "cancel", jobId: "bg-1" }                           // stops it; the cancel notice does not wake the parent
```

You can also manage them yourself without asking the agent: `/subagents` lists running jobs, `/subagents cancel` stops the only running job, and `/subagents cancel <jobId>` or `/subagents cancel all` picks which ones. Tab completes job ids.

Background runs need a long-lived session (interactive or RPC). In print mode (`-p`) Pi exits when the parent finishes its turn, which kills the child. Ending the session cancels all background jobs. The main agent's own edits are not covered by the file guard, so a background child and the parent can touch the same file.

Parallel mode is used only when the parent explicitly supplies `tasks`. Limits are 8 tasks, 4 concurrent tasks, 30 minutes per child, and 50 KB of model-visible output per child.

## Managed workflows: named profiles

This is a breaking tool-contract change. To retain named profiles, set `PI_SUBAGENT_PROFILES=1` in the launching process and relaunch Pi. Only the exact value `1` enables them; changing the environment after registration does not change the running session. Factory's owner must update and verify its launcher before Factory adopts this version. This extension does not change Factory.

In ordinary sessions, remove `agent`, `agentScope` and `confirmProjectAgents` from calls, including entries in `tasks` and `chain`. These legacy fields are rejected rather than ignored. For example, change `{ agent: "worker", task: "Implement ..." }` to `{ task: "Implement ..." }`. A workflow's `agentId` remains its stable role identifier, not a profile selector. Existing named-profile workflow sessions cannot be resumed as general-purpose: relaunch with profiles enabled or use a new workflow identity. You can still list or close them in ordinary mode. No profile files or workflow data need deletion.

In profile-enabled sessions, select exact names for every task:

```ts
{ agent: "worker", task: "Implement ..." }
{ lifecycle: "workflow", workflowId: "workflow-123", agentId: "implementer", agent: "worker", task: "Implement ..." }
```

Use the `list_agent_profiles` tool to see profiles currently discoverable by the extension, including their source and configuration. It accepts `agentScope: "user"` (default), `"project"`, or `"both"`; project-local profiles are listed but are still subject to confirmation when launched.

Profiles live in `~/.pi/agent/agents/*.md`.  Project profiles in `.pi/agents/*.md` are disabled by default and require `agentScope: "project"` or `"both"`; interactive runs ask for confirmation.

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

Omit `model` to inherit the parent's selected model. Thinking resolution is per-call override, then profile `thinking`, then parent level. A trusted workflow extension may inject a persisted role thinking as the per-call value for workflow-lifecycle dispatches when the caller did not explicitly provide `thinking`; this happens again on resumed jobs. Terminal calls are unchanged. `maxTokens` is an optional positive-integer output limit. Its resolution is per-call override, then a persisted workflow-agent limit on resume, then profile `maxTokens`, then a workflow role limit (`workflowMaxTokens`). Invalid values are ignored; effective limits are clamped to the selected model's configured `maxTokens`. Terminal calls without a per-call/profile limit do not receive a token override. Supported profile thinking values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; invalid thinking profiles are ignored. A tool-call `model` override has highest priority. Tool allowlists are configured per profile; omitting `tools` uses Pi's default active tools except `subagent`.

### Profiles from other extensions

An extension or Pi package can offer profiles without writing files into `~/.pi/agent/agents`. It registers a provider in a global map that every extension in the process shares, whatever its module root:

```ts
const key = Symbol.for("pi-subagents.agent-providers");
const providers = ((globalThis as any)[key] ??= new Map());
providers.set("my-package", () => [
  { name: "my-package:worker", description: "...", tools: ["read", "bash"], thinking: "medium", systemPrompt: "...", filePath: "/abs/worker.md" },
]);
```

Providers are called on every discovery, so edits to their sources apply to the next dispatch. Their profiles count as user scope; a file in `~/.pi/agent/agents` with the same name wins. Entries without `name`, `description` or `systemPrompt`, or with an invalid `thinking`, are skipped.

## Isolation and lifecycle

- Terminal lifecycle (the default) preserves the original one-job behavior.
- Workflow lifecycle persists metadata under `~/.pi/agent/runtime/subagent-workflows/` and resumes the same session for a stable `(workflowId, agentId)`, including its resolved output-token limit. `freshSession: true` starts a new context without deleting a running or retained session.
- Each child gets its own persisted session directory while running.
- Successful terminal run directories and sessions are deleted after all tasks finish.
- Failed run directories remain under the system temporary directory for 24 hours, and their paths are returned to the parent.
- `closeWorkflow` is the single cleanup action used by the `subagent` tool. Concurrent requests share one in-flight close. It aborts running children (including runs still preparing their first metadata write), waits for their exits, removes successful sessions and metadata, and retains only failed diagnostics for a fresh 24-hour window. Cleanup errors leave workflow metadata intact for recovery or retry. Parent cancellation propagates SIGTERM and then SIGKILL after five seconds without silently deleting resumable workflow state.
- `closeAgent` likewise waits for a running child, clears its active-widget entry, removes successful sessions, and retains aborted/failed agent diagnostics for 24 hours.
- A workflow agent rejects a concurrent run for the same stable `(workflowId, agentId)`. Workflow metadata updates are serialized across agents in the same workflow. This does not serialize their file changes.
- Chains stop at the first failed child.
- Child agents cannot invoke `subagent`.

## Version 1.0 breaking release notes

1.0 removes file ownership enforcement, preexisting-file protection, the mutation mutex, shell backups, auditing and restoration, mutation failure records and counters, and the per-turn bash limit. Children can edit the same file in successive stages and use normal shell tools without extension-managed coordination files. Nested delegation prevention, same-role workflow run exclusion, metadata synchronization, cancellation, cleanup and failed-run retention remain.

This extension does not automatically commit any child work, including Git tasks. Read-only and non-Git tasks need no commits. Stage commits require caller authorization, not merely a child dispatch. No package or release publication is part of this change.

### Migration to serial stage handoffs

Callers must manage serial writing stages in an isolated Git worktree. Run only one writing agent at a time, including shell commands and repairs. Parallel same-worktree mutation remains unsafe. Parallel read-only work is appropriate only when it cannot race with a writer. There is no single-writer enforcement and no sandbox: subprocess isolation separates sessions, not filesystem permissions. Git does not protect uncommitted, ignored, external or shared files.

Before each writing stage, inspect the branch, HEAD SHA and dirty status. Surface unexpected work before writing. Inherited partial work requires explicit authorization before continuing; do not assume that a prior dispatch authorized its adoption or removal.

For an authorized stage commit, explicitly stage only task-scoped files, for example `git add -- parser.ts tests/parser.test.mjs`, rather than staging the entire checkout. Hand off the commit SHA, changed scope, actual test commands and results, and outstanding work. Expected red tests are successful test-stage output when the caller authorized that stage; they are not a successful implementation handoff. Implementors may edit the same files in the next serial stage.

Read-only reviewers never commit. Repairs commit their fixes and report the new SHA. Authorized recoverable partial work may be saved as an explicitly incomplete checkpoint, but never presented as successful stage output. Failed stages report diagnostics and unresolved work without silently committing.

Keep intermediate commits through review. Compare the original test baseline, the test-stage changes and each implementation/repair stage diff so acceptance tests cannot be quietly weakened. After repairs or rebases, rerun the tests and bind review to the actual resulting SHA, not a superseded revision. Squash only the final PR after review, preserving intended changes and the recorded stage handoffs.

Workflow `list` details report cumulative active run time separately from persistent idle/waiting time, so between-dispatch waiting is never charged as active execution.

## UI

The `Agents` widget shows each active agent in a boxed card with its name, elapsed time, model/thinking level, current tool call and tool duration, context usage. While no tool is active, it shows `thinking...`. Cards are arranged horizontally across the available terminal width and wrap onto additional rows on narrower screens.
