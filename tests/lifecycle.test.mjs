import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const index = await readFile(path.join(root, "index.ts"), "utf8");
const guard = await readFile(path.join(root, "child-guard.ts"), "utf8");
const widgetLayout = await readFile(path.join(root, "widget-layout.ts"), "utf8");
const globalNodeModules = spawnSync("npm", ["root", "-g"], { encoding: "utf8" }).stdout.trim();
const localPiRoot = path.join(os.homedir(), ".local", "lib", "node_modules", "@earendil-works", "pi-coding-agent");
const piRoot = await stat(path.join(localPiRoot, "package.json")).then(() => localPiRoot, () => path.join(globalNodeModules, "@earendil-works", "pi-coding-agent"));
const piRequire = createRequire(path.join(piRoot, "package.json"));
const createJiti = piRequire("jiti");
const nodeModules = path.join(piRoot, "node_modules");
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
  "@earendil-works/pi-ai": path.join(nodeModules, "@earendil-works", "pi-ai", "dist", "compat.js"),
  "@earendil-works/pi-tui": path.join(nodeModules, "@earendil-works", "pi-tui", "dist", "index.js"),
  typebox: piRequire.resolve("typebox"),
} });
const testAgentDir = await mkdtemp(path.join(os.tmpdir(), "pi-test-agent-runtime-"));
const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = testAgentDir;
const subagentModule = await jiti.import(path.join(root, "index.ts"));
if (inheritedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = inheritedAgentDir;
test.after(() => rm(testAgentDir, { recursive: true, force: true }));
const childGuardModule = await jiti.import(path.join(root, "child-guard.ts"));

async function hookFixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-unguarded-child-"));
  const coord = path.join(cwd, "coord");
  await mkdir(coord);
  const saved = { PI_SUBAGENT_ID: process.env.PI_SUBAGENT_ID, PI_SUBAGENT_COORD_DIR: process.env.PI_SUBAGENT_COORD_DIR, PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD };
  Object.assign(process.env, { PI_SUBAGENT_ID: "stage-two", PI_SUBAGENT_COORD_DIR: coord, PI_SUBAGENT_CHILD: "1" });
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(cwd, { recursive: true, force: true });
  });
  const hooks = new Map();
  const fresh = createJiti(import.meta.url, { moduleCache: false });
  (await fresh.import(path.join(root, "child-guard.ts"))).default({ on(name, handler) { hooks.set(name, handler); } });
  const call = async (toolName, input, toolCallId) => hooks.get("tool_call")?.({ toolName, input, toolCallId }, { cwd });
  const result = async (toolName, toolCallId) => hooks.get("tool_result")?.({ toolName, toolCallId, content: [{ type: "text", text: "ok" }], isError: false }, { cwd });
  return { cwd, coord, call, result };
}

for (const toolName of ["edit", "write"]) {
  for (const owner of ["preexisting", "stage-one"]) {
    test(`child ${toolName} permits formerly ${owner} files`, async t => {
      const f = await hookFixture(t);
      const file = path.join(f.cwd, "shared.txt");
      await writeFile(file, "prior stage\n");
      await writeFile(path.join(f.coord, "registry.json"), JSON.stringify({ roots: [f.cwd], owners: { [file]: owner } }));
      const decision = await f.call(toolName, { path: file }, "direct");
      assert.notEqual(decision?.block, true, decision?.reason);
      await writeFile(file, "next stage\n");
      assert.notEqual((await f.result(toolName, "direct"))?.isError, true);
      assert.equal(await readFile(file, "utf8"), "next stage\n");
    });
  }
}

test("child shell modifications are not restored or reported as lock failures", async t => {
  const f = await hookFixture(t);
  const file = path.join(f.cwd, "shared.txt");
  await writeFile(file, "prior stage\n");
  await writeFile(path.join(f.coord, "registry.json"), JSON.stringify({ roots: [f.cwd], owners: { [file]: "stage-one" } }));
  assert.notEqual((await f.call("bash", { command: "stub mutation" }, "shell"))?.block, true);
  const shell = spawnSync("sh", ["-c", 'printf "next stage\\n" > shared.txt'], { cwd: f.cwd });
  assert.equal(shell.status, 0);
  const result = await f.result("bash", "shell");
  assert.equal(await readFile(file, "utf8"), "next stage\n", "shell output must survive tool_result");
  assert.notEqual(result?.isError, true);
});

test("child permits multiple bash calls in one turn without coordination files", async t => {
  const f = await hookFixture(t);
  await writeFile(path.join(f.coord, "registry.json"), JSON.stringify({ roots: [f.cwd], owners: {} }));
  assert.notEqual((await f.call("bash", { command: "true" }, "first"))?.block, true);
  // Sibling calls must not wait on a mutation mutex held by the first call.
  const sibling = await f.call("bash", { command: "true" }, "second");
  await f.result("bash", "first");
  assert.notEqual(sibling?.block, true, sibling?.reason);
  await f.result("bash", "second");
  assert.notEqual((await f.call("bash", { command: "true" }, "third"))?.block, true);
  await f.result("bash", "third");
  await assert.rejects(stat(path.join(f.coord, "mutation.mutex")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(f.coord, "failure-stage-two.txt")), { code: "ENOENT" });
});

test("nested delegation remains blocked without ownership coordination", async t => {
  const f = await hookFixture(t);
  await rm(f.coord, { recursive: true });
  const decision = await f.call("subagent", { agent: "worker", task: "nested" }, "nested");
  assert.equal(decision?.block, true);
  assert.match(decision.reason, /sub.?subagents|nested|cannot delegate/i);
});
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
  assert.match(widgetLayout, /thinking\.\.\./);
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

test("agent widget has no development-workflow telemetry", () => {
  assert.doesNotMatch(index, /development-workflow:agent/);
  assert.match(index, /setWidget\("subagents", \(_tui, theme\) =>/);
});

test("other extensions offer profiles through the global provider map", async () => {
  const agentsModule = await jiti.import(path.join(root, "agents.ts"));
  const key = Symbol.for("pi-subagents.agent-providers");
  const saved = globalThis[key];
  try {
    globalThis[key] = new Map([
      ["ok", () => [{ name: "ext:worker", description: "d", tools: ["read", "bash"], thinking: "high", systemPrompt: "Do it.", filePath: "/x/worker.md" }]],
      ["bad-thinking", () => [{ name: "ext:bad", description: "d", thinking: "huge", systemPrompt: "x" }]],
      ["throws", () => { throw new Error("boom"); }],
      ["not-a-list", () => "nope"],
    ]);
    const { agents } = agentsModule.discoverAgents(os.tmpdir(), "user");
    const worker = agents.find(a => a.name === "ext:worker");
    assert.ok(worker);
    assert.deepEqual(worker.tools, ["read", "bash"]);
    assert.equal(worker.thinking, "high");
    assert.equal(worker.source, "user");
    assert.equal(worker.systemPrompt, "Do it.");
    assert.equal(agents.find(a => a.name === "ext:bad"), undefined);
    assert.doesNotMatch(await readFile(path.join(root, "agents.ts"), "utf8"), /development-workflow/);
  } finally {
    if (saved === undefined) delete globalThis[key]; else globalThis[key] = saved;
  }
});

test("guard blocks cross-owner edits and restores shell mutations", { skip: "Retired in 1.0: caller manages serial writing stages" }, () => {
  assert.match(guard, /owner && owner !== id/);
  assert.match(guard, /await restore\(file/);
  assert.match(guard, /Shell lock violation/);
  assert.match(guard, /registry\.owners\[file\] = id!/);
});

test("bash auditing ignores unchanged preexisting dirty files", { skip: "Retired in 1.0: no shell auditing" }, async () => {
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

test("bash auditing lets the active agent claim a changed preexisting file", { skip: "Retired in 1.0: no file claims" }, async () => {
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

test("bash auditing still restores files owned by another agent", { skip: "Retired in 1.0: no shell restore" }, async () => {
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

test("mutation lock reclaims dead owners without disturbing live or replacement locks", { skip: "Retired in 1.0: no mutation mutex" }, () => {
  assert.match(guard, /process\.kill\(pid, 0\)/);
  assert.match(guard, /!processIsAlive\(owner\.pid\)/);
  assert.match(guard, /owner\?\.token !== token/);
  assert.match(guard, /return async \(\) => \{ await removeOwnedMutex\(token\); \}/);
  assert.match(guard, /await fs\.promises\.link\(temp, mutexPath\)/);
});

test("mutation lock waiting is bounded and abortable", { skip: "Retired in 1.0: no mutation mutex" }, () => {
  assert.match(guard, /PI_SUBAGENT_MUTEX_WAIT_MS/);
  assert.match(guard, /Timed out after.*waiting for the mutation lock/);
  assert.match(guard, /signal\?\.addEventListener\("abort"/);
  assert.match(guard, /Aborted while waiting for the mutation lock/);
});

test("mutex ownership is atomically published and contention is abortable", { skip: "Retired in 1.0: no mutation mutex" }, async () => {
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

test("exceptional workflow timing distinguishes pre-persist and resumed attempts", () => {
  const endedAt = Date.parse("2026-08-13T12:00:10.000Z");
  const startedAt = endedAt - 4_000;
  const lastEndedAt = new Date(startedAt - 6_000).toISOString();
  const beforePersist = { activeRunMs: 1_000, idleWaitingMs: 2_000, lastEndedAt };
  assert.equal(subagentModule.settleExceptionalWorkflowTiming(beforePersist, startedAt, endedAt, false), true);
  assert.deepEqual(beforePersist, { activeRunMs: 5_000, idleWaitingMs: 8_000, lastEndedAt });

  const resumed = { activeRunMs: 1_000, idleWaitingMs: 8_000, lastEndedAt };
  assert.equal(subagentModule.settleExceptionalWorkflowTiming(resumed, startedAt, endedAt, true), true);
  assert.deepEqual(resumed, { activeRunMs: 5_000, idleWaitingMs: 8_000, lastEndedAt }, "a persisted resume already charged its idle interval");
  assert.equal(subagentModule.settleExceptionalWorkflowTiming(resumed, undefined, endedAt, false), false, "setup failures before a run starts do not invent active timing");
});

test("workflow setup failures retain their original error", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-setup-failure-"));
  const workflowId = `setup-failure-${process.pid}-${Date.now()}`;
  const runDir = path.join(os.tmpdir(), "pi-subagents", `workflow-${workflowId}`);
  const workflowDir = path.join(testAgentDir, "runtime", "subagent-workflows", workflowId);
  const tools = new Map();
  try {
    await mkdir(path.join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(path.join(cwd, ".pi", "agents", "researcher.md"), "---\nname: researcher\ndescription: test profile\n---\nResearch only.\n");
    await mkdir(workflowDir, { recursive: true });
    const priorEnd = "2026-08-13T12:00:00.000Z";
    await writeFile(path.join(workflowDir, "workflow.json"), JSON.stringify({
      workflowId, runDir, createdAt: priorEnd, updatedAt: priorEnd,
      agents: { researcher: { workflowId, agentId: "researcher", profile: "researcher", sessionDir: path.join(runDir, "session-researcher"), status: "done", thinking: "medium", cwd, createdAt: priorEnd, updatedAt: priorEnd, ownerId: `${workflowId}:researcher`, activeRunMs: 10, idleWaitingMs: 20, lastEndedAt: priorEnd, reason: "prior result" } },
    }));
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "session-researcher"), "force lifecycle session mkdir failure");
    const pi = {
      events: { on() {} }, on() {}, registerTool(tool) { tools.set(tool.name, tool); },
      getThinkingLevel() { return "medium"; },
    };
    const childFlag = process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_CHILD;
    try { subagentModule.default(pi); } finally { if (childFlag !== undefined) process.env.PI_SUBAGENT_CHILD = childFlag; }
    const ctx = { cwd, hasUI: false, ui: { setWidget() {} }, modelRegistry: { find() { return undefined; } } };
    const error = await tools.get("subagent").execute("setup", {
      action: "run", lifecycle: "workflow", workflowId, agentId: "researcher", agent: "researcher", task: "research", agentScope: "project", confirmProjectAgents: false,
    }, undefined, undefined, ctx).then(() => undefined, failure => failure);
    assert.equal(error?.code, "EEXIST");
    assert.doesNotMatch(String(error?.message), /workflowStartedAt|not defined/);
    const retained = JSON.parse(await readFile(path.join(workflowDir, "workflow.json"), "utf8"));
    assert.equal(retained.agents.researcher.reason, "prior result");
    assert.equal(retained.agents.researcher.activeRunMs, 10);
    assert.equal(retained.agents.researcher.idleWaitingMs, 20);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
    await rm(workflowDir, { recursive: true, force: true });
  }
});

test("stub dispatch retains workflow exclusion and metadata without automatic commits", async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-dispatch-stub-"));
  const workflowId = `stub-${process.pid}-${Date.now()}`;
  const workflowDir = path.join(testAgentDir, "runtime", "subagent-workflows", workflowId);
  const runDir = path.join(os.tmpdir(), "pi-subagents", `workflow-${workflowId}`);
  const priorScript = process.argv[1];
  t.after(async () => {
    process.argv[1] = priorScript;
    await rm(cwd, { recursive: true, force: true });
    await rm(workflowDir, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });
  await mkdir(path.join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: readonly stub\ntools: read\n---\nReview only.\n");
  const script = path.join(cwd, "stub.cjs");
  await writeFile(script, `const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const prompt = fs.readFileSync(args[args.indexOf('--append-system-prompt') + 1], 'utf8');
fs.writeFileSync(path.join(process.cwd(), 'observed.json'), JSON.stringify({ args, prompt }));
if (args.at(-1).includes('fail fixture')) { console.error('stub failure diagnostics'); process.exit(7); }
setTimeout(() => { console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'stub review complete'}],stopReason:'stop'}})); }, 200);
`);
  process.argv[1] = script;
  const tools = new Map();
  const childFlag = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  try { subagentModule.default({ events: { on() {} }, on() {}, registerTool(tool) { tools.set(tool.name, tool); }, getThinkingLevel() { return "medium"; } }); }
  finally { if (childFlag !== undefined) process.env.PI_SUBAGENT_CHILD = childFlag; }
  const ctx = { cwd, hasUI: false, ui: { setWidget() {} }, modelRegistry: { find() {} } };
  const execute = (params, signal) => tools.get("subagent").execute("stub", { agent: "reviewer", task: "read-only review", agentScope: "project", confirmProjectAgents: false, ...params }, signal, undefined, ctx);
  const terminal = await execute({});
  assert.equal(terminal.details.results[0].status, "done");
  await assert.rejects(stat(path.join(cwd, ".git")), { code: "ENOENT" });
  await assert.rejects(stat(path.dirname(terminal.details.results[0].sessionDir)), { code: "ENOENT" });
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  git("add", ".pi/agents/reviewer.md"); git("commit", "-m", "Read-only baseline");
  const baseline = git("rev-parse", "HEAD");
  const pending = execute({ lifecycle: "workflow", workflowId, agentId: "reviewer" });
  await assert.rejects(execute({ lifecycle: "workflow", workflowId, agentId: "reviewer" }), /already running or closing/);
  const workflow = await pending;
  assert.equal(git("rev-parse", "HEAD"), baseline, "read-only dispatch must not commit arbitrary child output");
  assert.equal(workflow.details.results[0].status, "done");
  const record = JSON.parse(await readFile(path.join(workflowDir, "workflow.json"), "utf8"));
  assert.equal(record.agents.reviewer.lastResult, "stub review complete");
  assert.equal(record.agents.reviewer.status, "done");
  assert.ok(record.agents.reviewer.activeRunMs >= 0);
  await execute({ action: "closeWorkflow", workflowId });
  await assert.rejects(stat(workflowDir), { code: "ENOENT" });
  const failure = (await execute({ task: "fail fixture" })).details.results[0];
  t.after(() => rm(path.dirname(failure.sessionDir), { recursive: true, force: true }));
  assert.equal(failure.status, "failed");
  assert.equal(failure.exitCode, 7);
  assert.match(failure.reason, /stub failure diagnostics/);
  assert.ok((await stat(failure.sessionDir)).isDirectory(), "failed diagnostics are retained");
  const controller = new AbortController();
  const cancellation = execute({}, controller.signal);
  setTimeout(() => controller.abort(), 50);
  const aborted = (await cancellation).details.results[0];
  t.after(() => rm(path.dirname(aborted.sessionDir), { recursive: true, force: true }));
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.reason, "Aborted by parent");
  assert.ok((await stat(aborted.sessionDir)).isDirectory());
  const observed = JSON.parse(await readFile(path.join(cwd, "observed.json"), "utf8"));
  assert.doesNotMatch(observed.prompt, /file.lock|ownership|mutation mutex/i);
  assert.equal("lockCount" in workflow.details.results[0], false, "no lock counters in observable results");
});

test("extensions load in Pi", { skip: spawnSync("sh", ["-lc", "command -v pi"]).status !== 0 }, () => {
  const extensions = [path.join(root, "index.ts")];
  for (const args of [extensions.flatMap(extension => ["-e", extension])]) {
    const result = spawnSync("pi", ["--list-models", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
