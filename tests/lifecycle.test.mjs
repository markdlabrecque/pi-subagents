import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const inheritedChildEnv = Object.fromEntries(["PI_SUBAGENT_CHILD", "PI_WORKFLOW_ID", "PI_WORKFLOW_ROLE"].map(key => [key, process.env[key]]));
for (const key of Object.keys(inheritedChildEnv)) delete process.env[key];
test.after(() => { for (const [key, value] of Object.entries(inheritedChildEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
const root = path.resolve(import.meta.dirname, "..");
const index = await readFile(path.join(root, "index.ts"), "utf8");
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

function registerProfiles(pi) {
  const prior = process.env.PI_SUBAGENT_PROFILES;
  process.env.PI_SUBAGENT_PROFILES = "1";
  try { subagentModule.default(pi); } finally {
    if (prior === undefined) delete process.env.PI_SUBAGENT_PROFILES; else process.env.PI_SUBAGENT_PROFILES = prior;
  }
}

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

test("tool schemas preserve scope, thinking, and maxTokens validation", async () => {
  const { Check } = await import(piRequire.resolve("typebox/value"));
  const tools = new Map();
  registerProfiles({ events: { on() {} }, on() {}, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); } });
  const params = tools.get("subagent").parameters;
  const profiles = tools.get("list_agent_profiles").parameters;
  for (const scope of ["user", "project", "both"]) {
    assert.equal(Check(params, { agentScope: scope }), true);
    assert.equal(Check(profiles, { agentScope: scope }), true);
  }
  for (const scope of ["invalid", 1, null, {}]) {
    assert.equal(Check(params, { agentScope: scope }), false);
    assert.equal(Check(profiles, { agentScope: scope }), false);
  }
  assert.equal(Check(params, {}), true);
  assert.equal(Check(profiles, {}), true);
  assert.equal(params.properties.agentScope.default, "user");
  assert.equal(profiles.properties.agentScope.default, "user");
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "invalid", 1, null]) {
    const valid = typeof thinking === "string" && thinking !== "invalid";
    assert.equal(Check(params, { thinking }), valid);
    for (const mode of ["tasks", "chain"]) {
      assert.equal(Check(params, { [mode]: [{ agent: "worker", task: "work", thinking }] }), valid);
    }
  }
  for (const maxTokens of [1, 4096, 0, -1, 1.5, "4096", null]) {
    const valid = Number.isInteger(maxTokens) && maxTokens > 0;
    assert.equal(Check(params, { maxTokens }), valid);
    for (const mode of ["tasks", "chain"]) {
      assert.equal(Check(params, { [mode]: [{ agent: "worker", task: "work", maxTokens }] }), valid);
    }
  }
  for (const schema of [params.properties.agentScope, params.properties.thinking, params.properties.action, params.properties.lifecycle]) {
    assert.equal(schema.type, "string");
    assert.ok(Array.isArray(schema.enum), "retain provider-compatible string enums");
  }
});

test("profile listing and management return complete tool results", async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-tool-results-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tools = new Map();
  registerProfiles({ events: { on() {} }, on() {}, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); } });
  const ctx = { cwd, hasUI: false };
  const listed = await tools.get("list_agent_profiles").execute("profiles", { agentScope: "project" }, undefined, undefined, ctx);
  assert.ok(Object.hasOwn(listed, "details"), "Pi requires a details field even without structured data");
  assert.deepEqual(listed.content, [{ type: "text", text: "No agent profiles found.\nProject agents directory: none" }]);
  const closed = await tools.get("subagent").execute("close", { action: "closeWorkflow", workflowId: "issue-6-nonexistent" }, undefined, undefined, ctx);
  assert.equal(closed.content[0].type, "text");
  assert.equal(closed.details.mode, "management");
});

test("profile maxTokens handles absent and invalid numeric values", async t => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-profile-token-boundaries-"));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(async () => {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });
  await mkdir(path.join(agentDir, "agents"));
  const cases = [undefined, "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", "1", "4096"];
  for (const [i, value] of cases.entries()) {
    await writeFile(path.join(agentDir, "agents", `${i}.md`), `---\nname: case-${i}\ndescription: boundary test\n${value === undefined ? "" : `maxTokens: ${value}\n`}---\nwork`);
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { discoverAgents } = await jiti.import(path.join(root, "agents.ts"));
  const profiles = discoverAgents(agentDir, "user").agents;
  for (const [i, value] of cases.entries()) {
    const profile = profiles.find(profile => profile.name === `case-${i}`);
    assert.ok(profile);
    assert.equal(profile.maxTokens, value === "1" ? 1 : value === "4096" ? 4096 : undefined);
  }
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
    const agent = profile("my-extension:worker", { tools: ["read", "edit"], model: "provider/model", thinking: "high", maxTokens: 4096 });
    let calls = 0;
    globalThis[agentProviders].set("my-extension", () => { calls++; return [agent]; });
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
      events: { on() {} }, on() {}, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {},
      getThinkingLevel() { return "medium"; },
    };
    const childFlag = process.env.PI_SUBAGENT_CHILD;
    delete process.env.PI_SUBAGENT_CHILD;
    try { registerProfiles(pi); } finally { if (childFlag !== undefined) process.env.PI_SUBAGENT_CHILD = childFlag; }
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
  registerProfiles(pi);
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
const role = process.env.PI_WORKFLOW_ROLE;
const finish = () => console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:role === 'auditor' ? 'stub audit complete' : 'stub review complete'}],model:'stub-model',provider:'stub-provider',usage:{input:0,output:5,cacheRead:10,cost:{total:0}},stopReason:'stop'}}));
if (role) {
  fs.writeFileSync(path.join(process.cwd(), 'ready-' + role), 'ready');
  const deadline = Date.now() + 5000;
  const timer = setInterval(() => {
    if (['reviewer', 'auditor'].every(id => fs.existsSync(path.join(process.cwd(), 'ready-' + id)))) { clearInterval(timer); finish(); }
    else if (Date.now() > deadline) { console.error('distinct workflow roles did not overlap'); process.exit(8); }
  }, 10);
} else setTimeout(finish, 200);
`);
  process.argv[1] = script;
  const tools = new Map();
  const childFlag = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  const metricsEvents = [];
  let deliverBackground;
  const backgroundDone = new Promise(resolve => { deliverBackground = resolve; });
  try { registerProfiles({ events: { on() {}, emit(name, data) { metricsEvents.push({ name, data }); } }, on() {},
    sendMessage() { deliverBackground(); }, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, getThinkingLevel() { return "medium"; } }); }
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
  const sibling = execute({ lifecycle: "workflow", workflowId, agentId: "auditor", task: "read-only audit" });
  await assert.rejects(execute({ lifecycle: "workflow", workflowId, agentId: "reviewer" }), /already running or closing/);
  const [workflow, audit] = await Promise.all([pending, sibling]);
  assert.equal(git("rev-parse", "HEAD"), baseline, "read-only dispatch must not commit arbitrary child output");
  assert.equal(workflow.details.results[0].status, "done");
  const record = JSON.parse(await readFile(path.join(workflowDir, "workflow.json"), "utf8"));
  assert.equal(record.agents.reviewer.lastResult, "stub review complete");
  assert.equal(record.agents.reviewer.status, "done");
  assert.ok(record.agents.reviewer.activeRunMs >= 0);
  assert.equal(audit.details.results[0].status, "done", "distinct roles must dispatch concurrently");
  assert.deepEqual(Object.keys(record.agents).sort(), ["auditor", "reviewer"], "serialized metadata updates must preserve both roles");
  for (const [agentId, result, task, output] of [
    ["reviewer", workflow.details.results[0], "read-only review", "stub review complete"],
    ["auditor", audit.details.results[0], "read-only audit", "stub audit complete"],
  ]) {
    const agent = record.agents[agentId];
    assert.equal(agent.workflowId, workflowId);
    assert.equal(agent.agentId, agentId);
    assert.equal(agent.ownerId, `${workflowId}:${agentId}`);
    assert.equal(agent.status, "done");
    assert.equal(agent.lastTask, task);
    assert.equal(agent.lastResult, output);
    assert.equal(agent.sessionDir, result.sessionDir);
    assert.ok(agent.activeRunMs >= 0);
    assert.ok(Number.isFinite(Date.parse(agent.lastEndedAt)));
    assert.ok((await stat(agent.sessionDir)).isDirectory());
  }
  assert.notEqual(record.agents.reviewer.sessionDir, record.agents.auditor.sessionDir);
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
  const background = await execute({ background: true });
  assert.equal(background.details.results.length, 0, "launch acknowledgments do not contain completed usage");
  await backgroundDone;
  const starts = metricsEvents.filter(e => e.name === "subagents:metrics-start/v1");
  const ends = metricsEvents.filter(e => e.name === "subagents:metrics-end/v1");
  assert.equal(starts.length, 6); assert.equal(ends.length, 6);
  assert.equal(new Set(ends.map(e => e.data.runId)).size, 6);
  assert.deepEqual(new Set(ends.map(e => e.data.outcome)), new Set(["done", "failed", "aborted"]));
  for (const { data } of ends) {
    assert.equal(data.parentToolCallId, "stub"); assert.ok(data.elapsedMs >= 0);
    assert.ok(starts.some(e => e.data.runId === data.runId));
    if (data.outcome === "done") {
      assert.equal(data.usage.input, 0); assert.equal(data.usage.output, 5); assert.equal(data.usage.cacheRead, 10);
      assert.equal(data.usage.cacheWrite, null); assert.equal(data.usage.cost, 0);
    }
  }
  assert.doesNotMatch(JSON.stringify(metricsEvents), /stub review complete|read-only review|stub failure diagnostics/);
  // Fail the second registry write: setup succeeds, but final persistence fails
  // after the subprocess has already reported a successful assistant response.
  const mutableFS = (await import("node:fs")).default.promises;
  const originalWrite = mutableFS.writeFile;
  let registryWrites = 0;
  mutableFS.writeFile = async function(target, ...args) {
    if (String(target).startsWith(`${workflowDir}${path.sep}`) && String(target).endsWith(".tmp") && ++registryWrites === 2) {
      throw new Error("forced final registry write failure");
    }
    return originalWrite.call(this, target, ...args);
  };
  try {
    await assert.rejects(execute({ lifecycle: "workflow", workflowId, agentId: "reviewer" }), /forced final registry write failure/);
  } finally { mutableFS.writeFile = originalWrite; }
  const finalCompletion = metricsEvents.filter(e => e.name === "subagents:metrics-end/v1").at(-1).data;
  assert.equal(finalCompletion.outcome, "failed", "post-execution finalization must not emit a successful child outcome");
  assert.equal(finalCompletion.usage.output, 5, "observed usage survives finalization failure");
  const failedRecord = JSON.parse(await readFile(path.join(workflowDir, "workflow.json"), "utf8"));
  assert.equal(failedRecord.agents.reviewer.status, "failed");
});

test("child metrics are exactly once, preserve missing fields, and isolate listener errors", () => {
  const events = [];
  const meter = subagentModule.createChildMetrics((name, data) => events.push({ name, data }), "call_123|fc_456", 2);
  meter.observe({ role: "assistant", provider: "stub", usage: { input: 0, output: 5, cost: { total: 0 } } });
  meter.observe({ role: "assistant", usage: { output: 7, cacheRead: 0 } });
  meter.finish({ status: "done", agent: "worker", modelUsed: "model" });
  meter.finish({ status: "failed", agent: "worker" });
  assert.equal(events.length, 2);
  assert.equal(events[0].data.parentToolCallId, "call_123|fc_456");
  assert.equal(events[1].data.parentToolCallId, "call_123|fc_456");
  assert.equal(events[1].data.usage.input, null); assert.equal(events[1].data.usage.output, 12);
  assert.equal(events[1].data.usage.cost, null); assert.equal(events[1].data.taskIndex, 2);
  const broken = subagentModule.createChildMetrics(() => { throw new Error("listener failed"); });
  assert.doesNotThrow(() => broken.finish({ status: "done", agent: "worker" }));
});

test("profile mode is captured at registration and defaults to task-only", async () => {
  const prior = process.env.PI_SUBAGENT_PROFILES;
  const { Check } = await import(piRequire.resolve("typebox/value"));
  try {
    for (const value of [undefined, "", "0", "true", "1"]) {
      if (value === undefined) delete process.env.PI_SUBAGENT_PROFILES; else process.env.PI_SUBAGENT_PROFILES = value;
      const tools = new Map();
      subagentModule.default({ events: { on() {} }, on() {}, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); } });
      assert.equal(tools.has("list_agent_profiles"), value === "1");
      const tool = tools.get("subagent");
      assert.match(tool.description, value === "1" ? /exact named profile/ : /built-in general-purpose/);
      assert.equal(tool.parameters.properties.tasks.items.required.includes("agent"), value === "1");
      if (value !== "1") {
        process.env.PI_SUBAGENT_PROFILES = "1";
        assert.equal(Check(tool.parameters, { task: "x", agentScope: "x" }), true);
        assert.equal(Check(tool.parameters, { task: "x", confirmProjectAgents: "invalid" }), true);
        for (const fields of [{ agent: "general" }, { agent: "" }, { agentScope: "user" }, { agentScope: "x" }, { confirmProjectAgents: false }, { confirmProjectAgents: "invalid" }, { tasks: [{ task: "x", agent: "worker" }] }, { chain: [{ task: "x", agent: "" }] }]) {
          await assert.rejects(tool.execute("x", { task: "x", background: true, ...fields }, undefined, undefined, { cwd: os.tmpdir() }), /Named profiles are disabled/);
        }
      }
    }
  } finally { if (prior === undefined) delete process.env.PI_SUBAGENT_PROFILES; else process.env.PI_SUBAGENT_PROFILES = prior; }
});

test("built-in dispatch runs all modes and preserves workflow identity", async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-general-stub-"));
  const childCwd = path.join(cwd, "child");
  const workflowId = `general-${process.pid}-${Date.now()}`;
  const workflowDir = path.join(testAgentDir, "runtime", "subagent-workflows", workflowId);
  const runDir = path.join(os.tmpdir(), "pi-subagents", `workflow-${workflowId}`);
  const priorScript = process.argv[1], priorProfiles = process.env.PI_SUBAGENT_PROFILES, priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  const priorRegistry = Object.getOwnPropertyDescriptor(globalThis, agentProviders);
  t.after(async () => {
    process.argv[1] = priorScript;
    if (priorProfiles === undefined) delete process.env.PI_SUBAGENT_PROFILES; else process.env.PI_SUBAGENT_PROFILES = priorProfiles;
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(path.join(testAgentDir, "agents", "general.md"), { force: true });
    if (priorRegistry) Object.defineProperty(globalThis, agentProviders, priorRegistry); else delete globalThis[agentProviders];
    await rm(cwd, { recursive: true, force: true }); await rm(workflowDir, { recursive: true, force: true }); await rm(runDir, { recursive: true, force: true });
  });
  await mkdir(path.join(cwd, ".pi", "agents"), { recursive: true });
  await mkdir(path.join(testAgentDir, "agents"), { recursive: true });
  await mkdir(childCwd);
  const conflicting = "---\nname: general\ndescription: conflicting\nmodel: bad/model\ntools: read\nmaxTokens: 7\n---\nwrong prompt";
  await writeFile(path.join(cwd, ".pi", "agents", "general.md"), conflicting);
  await writeFile(path.join(testAgentDir, "agents", "general.md"), conflicting);
  process.env.PI_CODING_AGENT_DIR = testAgentDir;
  let providerCalls = 0;
  globalThis[agentProviders] = new Map([["throws", () => { providerCalls++; throw Error("must not run"); }]]);
  const script = path.join(cwd, "stub.cjs");
  await writeFile(script, `const fs=require('fs'),path=require('path'); const a=process.argv.slice(2); fs.appendFileSync(path.join(process.cwd(),'calls'),JSON.stringify({args:a,env:process.env.PI_SUBAGENT_MAX_TOKENS,prompt:fs.readFileSync(a[a.indexOf('--append-system-prompt')+1],'utf8')})+'\\n'); const dir=a[a.indexOf('--session-dir')+1]; fs.writeFileSync(path.join(dir,'session.jsonl'),'stub'); setTimeout(()=>console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'stub output'}],model:'stub',usage:{},stopReason:'stop'}})),80);`);
  process.argv[1] = script; delete process.env.PI_SUBAGENT_PROFILES;
  const tools = new Map(), messages = [], events = [];
  subagentModule.default({ events: { emit(name, data) { events.push({ name, data }); } }, on() {}, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); }, getThinkingLevel() { return "high"; }, sendMessage(message) { messages.push(message); } });
  const ctx = { cwd, hasUI: false, ui: {}, model: { provider: "parent", id: "model", maxTokens: 100 }, modelRegistry: { find() { return { maxTokens: 100 }; } } };
  const execute = params => tools.get("subagent").execute("test", { cwd: childCwd, ...params }, undefined, undefined, ctx);
  assert.equal((await execute({ task: "single", maxTokens: 200 })).details.results[0].agent, "general");
  assert.equal((await execute({ tasks: [{ task: "a", cwd: childCwd }, { task: "b", cwd: childCwd, model: "override/model", thinking: "low" }] })).details.results.length, 2);
  const chain = await execute({ chain: [{ task: "first", cwd: childCwd }, { task: "next {previous}", cwd: childCwd }] });
  assert.equal(chain.details.results[1].task, "next stub output");
  const bg = await execute({ task: "background", background: true });
  assert.match(bg.content[0].text, /general/);
  for (let i = 0; i < 100 && !messages.length; i++) await new Promise(r => setTimeout(r, 10));
  assert.match(messages[0].content, /general finished/);
  const params = { lifecycle: "workflow", workflowId, agentId: "role", task: "work" };
  const pending = execute(params);
  await assert.rejects(execute(params), /already running/);
  await pending; await execute(params); await execute({ ...params, freshSession: true });
  const recordPath = path.join(workflowDir, "workflow.json");
  let record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.equal(record.agents.role.profile, "general");
  assert.equal(record.agents.role.builtin, true);
  assert.equal(record.agents.role.cwd, childCwd);
  assert.ok(!(await readdir(record.agents.role.sessionDir)).includes(".builtin-general"));
  await rm(record.agents.role.sessionDir, { recursive: true, force: true });
  await execute(params);
  let calls = (await readFile(path.join(childCwd, "calls"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(!calls.at(-1).args.includes("--session"), "missing session directory starts without --session");
  record = JSON.parse(await readFile(recordPath, "utf8"));
  await rm(record.agents.role.sessionDir, { recursive: true, force: true });
  await execute({ ...params, freshSession: true });
  calls = (await readFile(path.join(childCwd, "calls"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(!calls.at(-1).args.includes("--session"));
  record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.ok(!(await readdir(record.agents.role.sessionDir)).includes(".builtin-general"));
  const timed = await execute({ task: "timeout", timeoutMinutes: 0.0001 });
  assert.equal(timed.details.results[0].status, "failed");
  assert.match(timed.details.results[0].reason, /Timed out/);
  await rm(path.dirname(timed.details.results[0].sessionDir), { recursive: true, force: true });
  calls = (await readFile(path.join(childCwd, "calls"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls[0].env, "100"); assert.ok(calls[0].args.includes("parent/model")); assert.ok(calls[0].args.includes("high"));
  assert.ok(calls.some(c => c.args.includes("override/model") && c.args.includes("low")));
  assert.ok(calls.some(c => c.args.includes("--session")));
  for (const call of calls) {
    assert.ok(!call.args.includes("--tools")); assert.ok(!call.args.includes("bad/model"));
    assert.doesNotMatch(call.prompt, /wrong prompt/); assert.notEqual(call.env, "7");
  }
  await assert.rejects(stat(path.join(cwd, "calls")), { code: "ENOENT" });
  assert.equal(providerCalls, 0); assert.ok(events.some(e => e.data.agent === "general"));
  const builtinBefore = await readFile(recordPath, "utf8");
  const namedTools = new Map();
  registerProfiles({ events: { emit() {} }, on() {}, registerCommand() {}, registerTool(tool) { namedTools.set(tool.name, tool); }, getThinkingLevel() { return "high"; } });
  const namedTool = namedTools.get("subagent");
  await assert.rejects(namedTool.execute("builtin", { ...params, cwd: childCwd, agent: "general" }, undefined, undefined, ctx), /cannot change profile/);
  assert.equal(await readFile(recordPath, "utf8"), builtinBefore);
  delete record.agents.role.builtin;
  await writeFile(recordPath, JSON.stringify(record));
  const generalBefore = await readFile(recordPath, "utf8");
  await assert.rejects(execute(params), /Cannot resume a named-profile workflow/);
  assert.equal(await readFile(recordPath, "utf8"), generalBefore);
  record.agents.role.profile = "other"; await writeFile(recordPath, JSON.stringify(record));
  const before = await readFile(recordPath, "utf8");
  await assert.rejects(execute(params), /PI_SUBAGENT_PROFILES=1 or use a new workflow identity/);
  assert.equal(await readFile(recordPath, "utf8"), before);
  globalThis[agentProviders].set("named", () => [{ name: "other", description: "test", systemPrompt: "named prompt", model: "named/model", thinking: "low", tools: ["read"], maxTokens: 40 }]);
  await assert.rejects(namedTool.execute("missing", { task: "x" }, undefined, undefined, ctx), /requires an agent name/);
  await assert.rejects(namedTool.execute("unknown", { agent: "Other", task: "x" }, undefined, undefined, ctx), /Unknown agents: Other/);
  let approvals = 0;
  const untrusted = { ...ctx, hasUI: true, ui: { setWidget() {}, async confirm() { approvals++; return false; } } };
  await assert.rejects(namedTool.execute("project", { agent: "general", agentScope: "project", task: "x" }, undefined, undefined, untrusted), /not approved/);
  assert.equal(approvals, 1);
  const named = await namedTool.execute("named", { ...params, cwd: childCwd, agent: "other" }, undefined, undefined, ctx);
  assert.equal(named.details.results[0].status, "done");
  const lastCall = (await readFile(path.join(childCwd, "calls"), "utf8")).trim().split("\n").map(JSON.parse).at(-1);
  assert.ok(lastCall.args.includes("named/model")); assert.ok(lastCall.args.includes("low")); assert.ok(lastCall.args.includes("read")); assert.equal(lastCall.env, "40");
  await execute({ action: "closeWorkflow", workflowId });
});

test("extensions load in Pi", { skip: spawnSync("sh", ["-lc", "command -v pi"]).status !== 0 }, () => {
  const extensions = [path.join(root, "index.ts")];
  for (const args of [extensions.flatMap(extension => ["-e", extension])]) {
    const result = spawnSync("pi", ["--list-models", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});
