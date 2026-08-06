import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const developmentRoot = path.resolve(root, "..", "development-workflow");
const index = await readFile(path.join(root, "index.ts"), "utf8");
const development = await readFile(path.join(developmentRoot, "index.ts"), "utf8");
const guard = await readFile(path.join(root, "child-guard.ts"), "utf8");
const widgetLayout = await readFile(path.join(root, "widget-layout.ts"), "utf8");
const globalNodeModules = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const piRoot = path.join(globalNodeModules, "@earendil-works", "pi-coding-agent");
const piRequire = createRequire(path.join(piRoot, "package.json"));
const createJiti = piRequire("jiti");
const nodeModules = path.join(piRoot, "node_modules");
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
  "@earendil-works/pi-ai": path.join(nodeModules, "@earendil-works", "pi-ai", "dist", "compat.js"),
  "@earendil-works/pi-tui": path.join(nodeModules, "@earendil-works", "pi-tui", "dist", "index.js"),
  typebox: piRequire.resolve("typebox"),
} });
const subagentModule = await jiti.import(path.join(root, "index.ts"));
const childGuardModule = await jiti.import(path.join(root, "child-guard.ts"));
const maxTokensOverride = await jiti.import(path.join(root, "max-tokens-override.ts"));

test("terminal API remains present and workflow API is additive", () => {
  for (const field of ["agent:", "task:", "tasks:", "chain:"]) assert.match(index, new RegExp(field));
  for (const action of ["run", "list", "closeAgent", "closeWorkflow"]) assert.match(index, new RegExp(`\\\"${action}\\\"`));
  assert.match(index, /workflowLifecycle \? .* : `\$\{runId\}-\$\{index \+ 1\}`/);
});

test("active agents use a responsive horizontal boxed-card widget", () => {
  assert.match(index, /setWidget\("subagents", \(_tui, theme\) =>/);
  assert.match(index, /renderAgentGrid\(cards, width/);
  assert.match(widgetLayout, /MIN_CARD_WIDTH/);
  assert.match(widgetLayout, /widthsForRow/);
  assert.match(widgetLayout, /join\(" "\.repeat\(GAP\)\)/);
  for (const border of ["┌", "┐", "└", "┘", "│"]) assert.ok(widgetLayout.includes(border));
  assert.match(widgetLayout, /truncateToWidth\(joined, width, ""\)/);
  assert.match(index, /currentToolStartedAt = Date\.now\(\)/);
  assert.match(index, /currentToolElapsed:/);
  assert.match(widgetLayout, /waiting for tool/);
  assert.doesNotMatch(widgetLayout, /card\.task/);
});

test("workflow owner and session handles are stable", () => {
  assert.match(index, /safeId\(params\.workflowId!\).*safeId\(params\.agentId!\)/);
  assert.match(index, /existing\?\.sessionFile/);
  assert.match(index, /args\.push\("--session", existing\.sessionFile\)/);
  assert.match(index, /PI_SUBAGENT_ID: id/);
});

test("max-token resolution honors per-call, resumed, profile, and workflow-role precedence", () => {
  const { resolveMaxTokens, clampMaxTokens } = subagentModule;
  assert.equal(resolveMaxTokens({ perCall: 1024, existing: 2048, profile: 4096, workflowRole: 8192 }), 1024, "per-call wins");
  assert.equal(resolveMaxTokens({ existing: 2048, profile: 4096, workflowRole: 8192 }), 2048, "resumed workflow agent keeps its prior limit");
  assert.equal(resolveMaxTokens({ profile: 4096, workflowRole: 8192 }), 4096, "profile overrides workflow role default");
  assert.equal(resolveMaxTokens({ workflowRole: 8192 }), 8192, "workflow role supplies the final default");
  assert.equal(resolveMaxTokens({ perCall: -1, profile: 4096 }), 4096, "invalid override is ignored");
  assert.equal(clampMaxTokens(65536, 32768), 32768, "limit never exceeds selected model maximum");
  assert.equal(clampMaxTokens(4096, undefined), 4096);
  assert.equal(clampMaxTokens(0, 32768), undefined);
});

test("profile maxTokens accepts only positive integers", async () => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-agent-profile-"));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(path.join(agentDir, "agents"));
    await writeFile(path.join(agentDir, "agents", "valid.md"), "---\nname: valid\ndescription: valid profile\nmaxTokens: 4096\n---\nvalid");
    await writeFile(path.join(agentDir, "agents", "invalid.md"), "---\nname: invalid\ndescription: invalid profile\nmaxTokens: -1\n---\ninvalid");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const agentsModule = await jiti.import(path.join(root, "agents.ts"));
    const profiles = agentsModule.discoverAgents(agentDir, "user").agents;
    assert.equal(profiles.find(profile => profile.name === "valid")?.maxTokens, 4096);
    assert.equal(profiles.find(profile => profile.name === "invalid")?.maxTokens, undefined);
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("child max-token override clamps runtime models and terminal calls stay unchanged without a limit", () => {
  const model = { maxTokens: 32768 };
  assert.equal(maxTokensOverride.applyMaxTokens(model, 65536), 32768);
  assert.equal(model.maxTokens, 32768);
  assert.equal(maxTokensOverride.applyMaxTokens(model, -1), undefined);
  assert.match(index, /if \(maxTokens !== undefined\) args\.push\("--extension", MAX_TOKENS_OVERRIDE\)/);
  assert.match(index, /if \(maxTokens !== undefined\) env\.PI_SUBAGENT_MAX_TOKENS = String\(maxTokens\)/);
  assert.equal(subagentModule.resolveMaxTokens({}), undefined, "terminal calls without a profile or per-call limit preserve model defaults");
});

test("cleanup and failure retention are explicit", () => {
  assert.match(index, /FAILED_RETENTION_MS = 24 \* 60 \* 60_000/);
  assert.match(index, /failed-\$\{Date\.now\(\)\}/);
  assert.match(index, /children.*SIGTERM/s);
  assert.match(index, /SIGKILL/);
  assert.match(index, /const closeWorkflow = \(workflowId: string\): Promise<string> =>/);
  assert.match(index, /await Promise\.all\(exits\)/);
  assert.match(index, /filter\(a => a\.status === "done"\).*fs\.promises\.rm/s);
  assert.match(index, /await fs\.promises\.utimes\(retained, new Date\(\), new Date\(\)\)/);
  assert.match(index, /pi\.events\.on\("subagent:request"/);
  assert.match(index, /const text = await closeWorkflow\(params\.workflowId\)/);
  assert.match(index, /workflowRuns\.has\(workflowRunId\)/);
  assert.match(index, /closingWorkflowRequests\.get\(workflowId\)/);
  assert.match(index, /await Promise\.all\(exits\);\s+workflow = await readWorkflow\(workflowId\)/s);
  assert.match(index, /closingAgents\.has\(ownerId\)/);
  assert.match(index, /await Promise\.all\(\[exit, run\]/);
  assert.match(index, /failed-\$\{Date\.now\(\)\}-\$\{safeId\(params\.workflowId!\)\}-\$\{safeId\(params\.agentId!\)\}/);
  assert.match(index, /await mutateWorkflow\(params\.workflowId!/);
});

test("development workflow has no widget or subagent widget telemetry", () => {
  assert.doesNotMatch(development, /setWidget\("development-workflow"/);
  assert.doesNotMatch(development, /development-workflow:agent/);
  assert.doesNotMatch(index, /development-workflow:agent/);
  assert.match(index, /setWidget\("subagents", \(_tui, theme\) =>/);
});

test("workflow mode is process-local rather than session-file handed off", async () => {
  const threadMode = await readFile(path.join(developmentRoot, "thread-mode.ts"), "utf8");
  assert.match(threadMode, /Symbol\.for\("development-workflow\.enabled\.v2"\)/);
  assert.match(threadMode, /LEGACY_WORKFLOW_MODE_KEY/);
  assert.match(threadMode, /return root\[WORKFLOW_MODE_KEY\] \?\?= false/);
  assert.match(development, /workflowModeEnabled\(\)/);
  assert.doesNotMatch(development, /WeakMap|pendingReplacement|SessionManager\.open|pi\.appendEntry|previousSessionFile|THREAD_MODE_ENTRY/);
  assert.match(development, /const workflowActive = \(\): boolean => workflowModeEnabled\(\) \|\| foregroundActivated \|\| pendingForegroundActivation \|\| preflightForegroundActivation \|\| isWorkflowChildSession\(\)/);
  assert.match(development, /pi\.setActiveTools\(workflowActive\(\) \? \[\.\.\.new Set\(\[\.\.\.active, "development_workflow"\]\)\] : active\.filter\(name => name !== "development_workflow"\)\)/);
  assert.match(development, /setStatus\("development-workflow", undefined\)/);
  assert.match(development, /hasWorkflowTrigger\(event\.text \?\? ""\)/);
  assert.match(development, /const activeForPrompt = workflowActive\(\)/);
  assert.match(development, /if \(!activeForPrompt\) return undefined/);
  assert.match(development, /return \{ systemPrompt:/);
  // Disabled foreground calls are blocked, while persistent workflow children retain
  // access to record their own stage results.
  assert.match(development, /pi\.on\("tool_call", async \(event, ctx\) => \{.*if \(event\.toolName === "development_workflow"\) \{/s);
  assert.match(development, /if \(workflowActive\(\)\) return undefined/);
  assert.match(development, /childWorkflowAccessError/);
  assert.match(development, /if \(!workflowActive\(\)\) throw new Error\("Development workflow is inactive/);
  for (const command of ["workflow-enable", "workflow-disable"]) assert.match(development, new RegExp(`registerCommand\\("${command}"`));
});

test("development workflow coordinates the subagent close action before state removal", () => {
  assert.match(development, /pi\.events\.emit\("subagent:request", request\)/);
  assert.match(development, /const text = await requestSubagentClose\(pi, state\.id\);\s+await retireState\(state\.id\);/s);
  assert.match(development, /const MAX_TRACKED_COMPLETION_TOOL_CALLS = 256/);
  assert.match(development, /pi\.on\("tool_result", \(event: any\) => \{.*if \(event\.toolName === "development_workflow" && event\.input\?\.action === "complete" && !event\.isError\) trackCompletionToolCall/s);
  assert.match(development, /while \(completionToolCalls\.size >= MAX_TRACKED_COMPLETION_TOOL_CALLS\)/);
  assert.match(development, /pi\.on\("agent_end", \(\) => \{\s+completionToolCalls\.clear\(\)/);
  assert.match(development, /pi\.on\("session_shutdown", event => \{.*completionToolCalls\.clear\(\)/s);
  assert.match(development, /message\?\.role !== "toolResult" \|\| !completionToolCalls\.delete\(message\.toolCallId\)/);
  assert.match(development, /message\.toolName !== "development_workflow".*state\?\.stage !== "completed"/s);
  assert.match(development, /setTimeout\(\(\) => \{\s+void closeCompletedAfterForegroundResult/s);
  assert.doesNotMatch(development, /pi\.on\("message_end", async/);
  assert.match(development, /if \(currentId === state\.id\) \{\s+const next = \(await listStates\(\)\)\.filter\(candidate => !\["completed", "blocked", "aborted"\]\.includes\(candidate\.stage\)\)\.sort\(\(a, b\) => b\.updatedAt\.localeCompare\(a\.updatedAt\)\)\[0\];\s+currentId = next\?\.id;/s);
  assert.match(development, /void closeCompletedAfterForegroundResult\(state\.id\)/);
  assert.doesNotMatch(development, /Also call subagent closeWorkflow/);
});

test("guard blocks cross-owner edits and restores shell mutations", () => {
  assert.match(guard, /owner && owner !== id/);
  assert.match(guard, /await restore\(file/);
  assert.match(guard, /Shell lock violation/);
  assert.match(guard, /registry\.owners\[file\] = id!/);
});

test("bash auditing ignores unchanged preexisting dirty files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-guard-audit-"));
  const file = path.join(dir, "already-dirty.txt");
  try {
    const original = Buffer.from("user change\n");
    await writeFile(file, original);
    const registry = { owners: { [file]: "preexisting" }, roots: [dir] };
    const violations = await childGuardModule.auditProtectedMutations(
      registry,
      new Map([[file, original]]),
      "workflow:test-agent",
    );
    assert.deepEqual(violations, []);
    assert.equal(registry.owners[file], "preexisting");
    assert.equal(await readFile(file, "utf8"), "user change\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bash auditing lets the active agent claim a changed preexisting file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-guard-audit-"));
  const file = path.join(dir, "already-dirty.txt");
  try {
    const original = Buffer.from("user change\n");
    await writeFile(file, "agent update\n");
    const registry = { owners: { [file]: "preexisting" }, roots: [dir] };
    const violations = await childGuardModule.auditProtectedMutations(
      registry,
      new Map([[file, original]]),
      "workflow:test-agent",
    );
    assert.deepEqual(violations, []);
    assert.equal(registry.owners[file], "workflow:test-agent");
    assert.equal(await readFile(file, "utf8"), "agent update\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bash auditing still restores files owned by another agent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-guard-audit-"));
  const file = path.join(dir, "foreign.txt");
  try {
    const original = Buffer.from("other agent's work\n");
    await writeFile(file, "unauthorized update\n");
    const registry = { owners: { [file]: "workflow:other-agent" }, roots: [dir] };
    const violations = await childGuardModule.auditProtectedMutations(
      registry,
      new Map([[file, original]]),
      "workflow:test-agent",
    );
    assert.deepEqual(violations, [`${file} (owned by workflow:other-agent)`]);
    assert.equal(registry.owners[file], "workflow:other-agent");
    assert.equal(await readFile(file, "utf8"), "other agent's work\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mutation lock reclaims dead owners without disturbing live or replacement locks", () => {
  assert.match(guard, /process\.kill\(pid, 0\)/);
  assert.match(guard, /!processIsAlive\(owner\.pid\)/);
  assert.match(guard, /owner\?\.token !== token/);
  assert.match(guard, /return async \(\) => \{ await removeOwnedMutex\(token\); \}/);
  assert.match(guard, /await fs\.promises\.link\(temp, mutexPath\)/);
});

test("mutation lock waiting is bounded and abortable", () => {
  assert.match(guard, /PI_SUBAGENT_MUTEX_WAIT_MS/);
  assert.match(guard, /Timed out after.*waiting for the mutation lock/);
  assert.match(guard, /signal\?\.addEventListener\("abort"/);
  assert.match(guard, /Aborted while waiting for the mutation lock/);
});

test("mutex ownership is atomically published and contention is abortable", async () => {
  const coord = await mkdtemp(path.join(os.tmpdir(), "pi-mutex-test-"));
  process.env.PI_SUBAGENT_ID = "test-agent";
  process.env.PI_SUBAGENT_COORD_DIR = coord;
  process.env.PI_SUBAGENT_MUTEX_WAIT_MS = "2000";
  const mutex = path.join(coord, "mutation.mutex");
  try {
    const { acquireMutationLock } = await import(`../child-guard.ts?test=${Date.now()}`);
    const release = await acquireMutationLock();
    const owner = JSON.parse(await readFile(mutex, "utf8"));
    assert.equal(owner.pid, process.pid);
    const controller = new AbortController();
    const blocked = acquireMutationLock(controller.signal);
    controller.abort();
    await assert.rejects(blocked, /Aborted while waiting/);
    await release();
    await assert.rejects(stat(mutex), { code: "ENOENT" });
  } finally {
    await rm(coord, { recursive: true, force: true });
    delete process.env.PI_SUBAGENT_ID;
    delete process.env.PI_SUBAGENT_COORD_DIR;
    delete process.env.PI_SUBAGENT_MUTEX_WAIT_MS;
  }
});

test("extensions load in Pi", { skip: spawnSync("sh", ["-lc", "command -v pi"]).status !== 0 }, () => {
  const extensions = [path.join(root, "index.ts"), path.join(developmentRoot, "index.ts")];
  for (const args of [extensions.flatMap(extension => ["-e", extension]), ["-e", extensions[0]], ["-e", extensions[1]]]) {
    const result = spawnSync("pi", ["--list-models", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
