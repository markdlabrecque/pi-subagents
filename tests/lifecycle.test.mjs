import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const index = await readFile(path.join(root, "index.ts"), "utf8");
const guard = await readFile(path.join(root, "child-guard.ts"), "utf8");
const widgetLayout = await readFile(path.join(root, "widget-layout.ts"), "utf8");
const piCommand = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" }).stdout.trim();
if (!piCommand) throw new Error("Cannot locate the active Pi executable on PATH");
let piRoot = path.dirname(realpathSync(piCommand));
while (piRoot !== path.dirname(piRoot)) {
  const manifest = path.join(piRoot, "package.json");
  if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") break;
  piRoot = path.dirname(piRoot);
}
if (piRoot === path.dirname(piRoot)) throw new Error(`Cannot locate Pi package root from ${piCommand}`);
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
  for (const action of ["run", "list", "cancel", "closeAgent", "closeWorkflow"]) assert.match(index, new RegExp(`\\\"${action}\\\"`));
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

test("max-token resolution honors per-call, resumed, and profile precedence", () => {
  const { resolveMaxTokens, clampMaxTokens } = subagentModule;
  assert.equal(resolveMaxTokens({ perCall: 1024, existing: 2048, profile: 4096 }), 1024, "per-call wins");
  assert.equal(resolveMaxTokens({ existing: 2048, profile: 4096 }), 2048, "resumed workflow agent keeps its prior limit");
  assert.equal(resolveMaxTokens({ profile: 4096 }), 4096, "profile supplies the final default");
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

const agentProviders = Symbol.for("pi-subagents.agent-providers");

async function withAgentDiscovery(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-discovery-"));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  const priorRegistry = Object.getOwnPropertyDescriptor(globalThis, agentProviders);
  try {
    const userDir = path.join(dir, "user");
    const cwd = path.join(dir, "project");
    await mkdir(path.join(userDir, "agents"), { recursive: true });
    await mkdir(path.join(cwd, ".pi", "agents"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = userDir;
    globalThis[agentProviders] = new Map();
    const { discoverAgents } = await jiti.import(path.join(root, "agents.ts"));
    const profile = (name, overrides = {}) => ({
      name, description: "provider profile", systemPrompt: "Stage instructions.",
      source: "user", filePath: `/provider/${name}.md`, ...overrides,
    });
    const writeProfile = (source, name) => writeFile(
      path.join(source === "user" ? userDir : path.join(cwd, ".pi"), "agents", `${name}.md`),
      `---\nname: ${name}\ndescription: ${source} file profile\n---\n${source} instructions.`,
    );
    await run({ discover: scope => discoverAgents(cwd, scope), profile, writeProfile });
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    if (priorRegistry) Object.defineProperty(globalThis, agentProviders, priorRegistry);
    else delete globalThis[agentProviders];
    await rm(dir, { recursive: true, force: true });
  }
}

test("provider discovery includes live user profiles in user and both scopes", async () => {
  await withAgentDiscovery(async ({ discover, profile }) => {
    assert.deepEqual(discover("user").agents, []);
    const agent = profile("orchestration:test-writer", { tools: ["read", "edit"], model: "provider/model", thinking: "high", maxTokens: 4096 });
    let calls = 0;
    globalThis[agentProviders].set("orchestration", () => { calls++; return [agent]; });
    for (const scope of ["user", "both"]) assert.deepEqual(discover(scope).agents, [agent]);
    agent.systemPrompt = "Updated instructions.";
    assert.equal(discover("user").agents[0].systemPrompt, "Updated instructions.");
    assert.equal(calls, 3, "providers are evaluated on each discovery, not cached");
  });
});

test("file profiles retain user and project precedence over provider profiles", async () => {
  await withAgentDiscovery(async ({ discover, profile, writeProfile }) => {
    globalThis[agentProviders].set("stages", () => [profile("shared"), profile("provider-only")]);
    await writeProfile("user", "shared");
    await writeProfile("project", "shared");
    assert.equal(discover("user").agents.find(a => a.name === "shared").description, "user file profile");
    const both = discover("both").agents;
    assert.equal(both.find(a => a.name === "shared").source, "project");
    assert.equal(both.find(a => a.name === "shared").description, "project file profile");
    assert.equal(both.filter(a => a.name === "shared").length, 1);
    assert.equal(both.find(a => a.name === "provider-only").source, "user");
  });
});

test("project-only discovery never invokes user providers", async () => {
  await withAgentDiscovery(async ({ discover, writeProfile }) => {
    let calls = 0;
    globalThis[agentProviders].set("stages", () => { calls++; throw new Error("must not run"); });
    await writeProfile("user", "user-only");
    await writeProfile("project", "project-only");
    const result = discover("project");
    assert.deepEqual(result.agents.map(a => a.name), ["project-only"]);
    assert.ok(result.projectAgentsDir.endsWith(path.join(".pi", "agents")));
    assert.equal(calls, 0);
  });
});

test("provider discovery isolates failures and rejects malformed entries", async () => {
  await withAgentDiscovery(async ({ discover, profile, writeProfile }) => {
    await writeProfile("user", "file-only");
    for (const registry of [undefined, {}, []]) {
      globalThis[agentProviders] = registry;
      assert.deepEqual(discover("user").agents.map(a => a.name), ["file-only"]);
    }
    const throwingEntry = Object.defineProperty({}, "name", { get() { throw new Error("bad getter"); } });
    globalThis[agentProviders] = new Map([
      ["throws", () => { throw new Error("provider failed"); }],
      ["not-callable", 42],
      ["not-array", () => ({})],
      ["malformed", () => [null, 42, {}, throwingEntry,
        ...[ { name: "" }, { description: 42 }, { systemPrompt: null }, { filePath: null },
          { source: "project" }, { tools: "read" }, { tools: [42] }, { model: 42 },
          { thinking: "invalid" }, { maxTokens: -1 }, { maxTokens: 1.5 },
        ].map(overrides => profile("invalid", overrides)),
        profile("valid-after-invalid"),
      ]],
      ["healthy", () => [profile("healthy")]],
    ]);
    assert.deepEqual(discover("user").agents.map(a => a.name).sort(), ["file-only", "healthy", "valid-after-invalid"]);
  });
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
  assert.match(index, /const text = await closeWorkflow\(params\.workflowId\)/);
  assert.match(index, /workflowRuns\.has\(workflowRunId\)/);
  assert.match(index, /closingWorkflowRequests\.get\(workflowId\)/);
  assert.match(index, /await Promise\.all\(exits\);\s+workflow = await readWorkflow\(workflowId\)/s);
  assert.match(index, /closingAgents\.has\(ownerId\)/);
  assert.match(index, /await Promise\.all\(\[exit, run\]/);
  assert.match(index, /failed-\$\{Date\.now\(\)\}-\$\{safeId\(params\.workflowId!\)\}-\$\{safeId\(params\.agentId!\)\}/);
  assert.match(index, /await mutateWorkflow\(params\.workflowId!/);
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
  const workflowDir = path.resolve(root, "..", "..", "runtime", "subagent-workflows", workflowId);
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
    await writeFile(path.join(runDir, "coord"), "force mkdir failure");
    const pi = {
      events: { on() {} }, on() {}, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {},
      getThinkingLevel() { return "medium"; },
    };
    subagentModule.default(pi);
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

function loadWithFakePi() {
  const tools = new Map(); const commands = new Map(); const messages = []; const handlers = new Map();
  const pi = {
    events: { on() {} }, on(name, fn) { handlers.set(name, fn); }, registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    getThinkingLevel() { return "medium"; }, sendMessage(message, options) { messages.push({ message, options }); },
  };
  subagentModule.default(pi);
  return { subagent: tools.get("subagent"), command: commands.get("subagents"), messages, handlers };
}

test("background runs return at once and deliver the outcome as a follow-up turn", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-background-"));
  try {
    const { subagent, messages } = loadWithFakePi();
    const ctx = { cwd, hasUI: false, ui: { setWidget() {} }, modelRegistry: { find() { return undefined; } } };
    const started = await subagent.execute("bg", { agent: "no-such-agent", task: "x", background: true }, undefined, undefined, ctx);
    assert.match(started.content[0].text, /Started background subagent bg-1/);
    assert.equal(started.details.jobId, "bg-1");
    for (let i = 0; i < 50 && !messages.length; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(messages.length, 1);
    assert.match(messages[0].message.content, /\[bg-1\] no-such-agent finished[\s\S]*Unknown agents: no-such-agent/);
    assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
    const listed = await subagent.execute("list", { action: "list" }, undefined, undefined, ctx);
    assert.match(listed.content[0].text, /No background jobs\./);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("parallel and chain calls run as one background job each; cancel needs a live job", async () => {
  const { subagent, messages } = loadWithFakePi();
  const ctx = { cwd: os.tmpdir(), hasUI: false, ui: { setWidget() {} } };
  const parallel = await subagent.execute("bg", { tasks: [{ agent: "a", task: "t" }, { agent: "b", task: "t" }], background: true }, undefined, undefined, ctx);
  const chain = await subagent.execute("bg", { chain: [{ agent: "c", task: "t" }, { agent: "d", task: "{previous}" }], background: true }, undefined, undefined, ctx);
  assert.match(parallel.content[0].text, /bg-1 \(parallel: a, b\)/);
  assert.match(chain.content[0].text, /bg-2 \(chain: c → d\)/);
  for (let i = 0; i < 50 && messages.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(messages.length, 2, "each call reports once, not once per child");
  await assert.rejects(subagent.execute("c", { action: "cancel", jobId: "bg-9" }, undefined, undefined, ctx), /Unknown background job: bg-9/);
});

test("/subagents cancel reports unknown jobs and an empty queue", async () => {
  const { command } = loadWithFakePi();
  const notes = []; const ctx = { ui: { notify(text, type) { notes.push([type, text]); } } };
  await command.handler("cancel", ctx);
  await command.handler("bogus", ctx);
  assert.deepEqual(notes.map(([type]) => type), ["info", "warning"]);
  assert.match(notes[0][1], /No background subagents running/);
  assert.deepEqual(command.getArgumentCompletions("ca").map(i => i.value), ["cancel"]);
});

test("extensions load in Pi", { skip: spawnSync("sh", ["-lc", "command -v pi"]).status !== 0 }, () => {
  const extensions = [path.join(root, "index.ts")];
  for (const args of [extensions.flatMap(extension => ["-e", extension]), ["-e", extensions[0]]]) {
    const result = spawnSync("pi", ["--list-models", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
