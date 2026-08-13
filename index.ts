import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig, type AgentScope } from "./agents.ts";
import { renderAgentGrid, type AgentCard } from "./widget-layout.ts";

const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const OUTPUT_CAP = 50 * 1024;
const FAILED_RETENTION_MS = 24 * 60 * 60_000;
const CHILD_GUARD = path.join(import.meta.dirname, "child-guard.ts");
const MAX_TOKENS_OVERRIDE = path.join(import.meta.dirname, "max-tokens-override.ts");
const RUN_ROOT = path.join(os.tmpdir(), "pi-subagents");
const WORKFLOW_ROOT = path.join(getAgentDir(), "runtime", "subagent-workflows");
const workflowMutations = new Map<string, Promise<void>>();
async function mutateWorkflow<T>(workflowId: string, operation: () => Promise<T>): Promise<T> {
  const prior = workflowMutations.get(workflowId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const queued = prior.then(() => current);
  workflowMutations.set(workflowId, queued);
  await prior;
  try { return await operation(); }
  finally {
    release();
    if (workflowMutations.get(workflowId) === queued) workflowMutations.delete(workflowId);
  }
}

type Status = "queued" | "running" | "done" | "failed" | "aborted";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
interface TaskSpec { agent: string; task: string; cwd?: string; model?: string; thinking?: ThinkingLevel; maxTokens?: number; workflowId?: string; agentId?: string; }

export function normalizeMaxTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Per-call wins; resumed workflow settings remain stable ahead of profile/role defaults. */
export function resolveMaxTokens(input: { perCall?: unknown; existing?: unknown; profile?: unknown; workflowRole?: unknown }): number | undefined {
  return normalizeMaxTokens(input.perCall)
    ?? normalizeMaxTokens(input.existing)
    ?? normalizeMaxTokens(input.profile)
    ?? normalizeMaxTokens(input.workflowRole);
}

export function clampMaxTokens(maxTokens: unknown, modelMaxTokens: unknown): number | undefined {
  const requested = normalizeMaxTokens(maxTokens);
  if (requested === undefined) return undefined;
  const modelLimit = normalizeMaxTokens(modelMaxTokens);
  return modelLimit === undefined ? requested : Math.min(requested, modelLimit);
}
function modelMaxTokens(ctx: ExtensionContext, selectedModel?: string): number | undefined {
  const slash = selectedModel?.indexOf("/") ?? -1;
  if (slash > 0) return normalizeMaxTokens(ctx.modelRegistry.find(selectedModel!.slice(0, slash), selectedModel!.slice(slash + 1))?.maxTokens);
  return normalizeMaxTokens(ctx.model?.maxTokens);
}
/** Settle a failed attempt without charging its pre-start idle interval twice. */
export function settleExceptionalWorkflowTiming(record: { activeRunMs?: number; idleWaitingMs?: number; lastEndedAt?: string }, startedAt: number | undefined, endedAt: number, attemptPersisted: boolean): boolean {
  if (startedAt === undefined) return false;
  if (!attemptPersisted && record.lastEndedAt) record.idleWaitingMs = (record.idleWaitingMs ?? 0) + Math.max(0, startedAt - Date.parse(record.lastEndedAt));
  record.activeRunMs = (record.activeRunMs ?? 0) + Math.max(0, endedAt - startedAt);
  return true;
}
interface ActiveTask extends TaskSpec {
  id: string; status: Status; startedAt?: number; currentTool?: string; currentToolStartedAt?: number; modelUsed?: string; thinkingUsed?: ThinkingLevel;
  maxTokens?: number; contextTokens: number; lockCount: number; output?: string; reason?: string; sessionDir?: string;
}
interface RunResult extends ActiveTask { exitCode: number; usage: { input: number; output: number; cost: number; turns: number }; }
interface Details { mode: "single" | "parallel" | "chain" | "workflow" | "management"; results: RunResult[]; workflows?: WorkflowRecord[]; }
interface WorkflowAgentRecord {
  workflowId: string; agentId: string; profile: string; sessionDir: string; sessionFile?: string;
  status: Status; model?: string; thinking: ThinkingLevel; maxTokens?: number; cwd: string; createdAt: string; updatedAt: string;
  ownerId: string; lastTask?: string; lastResult?: string; reason?: string;
  /** Cumulative child execution only; idle time between workflow dispatches is separate. */
  activeRunMs?: number; idleWaitingMs?: number; lastEndedAt?: string;
}
interface WorkflowRecord { workflowId: string; runDir: string; agents: Record<string, WorkflowAgentRecord>; createdAt: string; updatedAt: string; }
interface CloseWorkflowRequest {
  action: "closeWorkflow"; workflowId: string; accept: () => void; resolve: (text: string) => void; reject: (error: unknown) => void;
}
const safeId = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_");
const workflowDir = (workflowId: string) => path.join(WORKFLOW_ROOT, safeId(workflowId));
const workflowRecordPath = (workflowId: string) => path.join(workflowDir(workflowId), "workflow.json");
async function readWorkflow(workflowId: string): Promise<WorkflowRecord | undefined> {
  try { return JSON.parse(await fs.promises.readFile(workflowRecordPath(workflowId), "utf8")); } catch { return undefined; }
}
async function writeWorkflow(record: WorkflowRecord): Promise<void> {
  const dir = workflowDir(record.workflowId); await fs.promises.mkdir(dir, { recursive: true });
  record.updatedAt = new Date().toISOString(); const target = workflowRecordPath(record.workflowId); const temp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(record, null, 2)); await fs.promises.rename(temp, target);
}
async function listWorkflows(workflowId?: string): Promise<WorkflowRecord[]> {
  if (workflowId) { const one = await readWorkflow(workflowId); return one ? [one] : []; }
  await fs.promises.mkdir(WORKFLOW_ROOT, { recursive: true });
  const records = await Promise.all((await fs.promises.readdir(WORKFLOW_ROOT)).map(readWorkflow));
  return records.filter((r): r is WorkflowRecord => Boolean(r));
}

const TaskSchema = Type.Object({
  agent: Type.String({ description: "Agent profile name" }),
  task: Type.String({ description: "Specific delegated instruction" }),
  cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the parent cwd" })),
  model: Type.Optional(Type.String({ description: "Optional model override" })),
  thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Optional thinking-level override" })),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Optional maximum output tokens override" })),
});
const Params = Type.Object({
  action: Type.Optional(StringEnum(["run", "list", "closeAgent", "closeWorkflow"] as const, { default: "run" })),
  lifecycle: Type.Optional(StringEnum(["terminal", "workflow"] as const, { default: "terminal" })),
  workflowId: Type.Optional(Type.String({ description: "Stable workflow identifier for workflow lifecycle" })),
  agentId: Type.Optional(Type.String({ description: "Stable role identifier for workflow lifecycle" })),
  agent: Type.Optional(Type.String()), task: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()),
  model: Type.Optional(Type.String({ description: "Optional model override for single mode" })),
  thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Optional thinking-level override for single mode" })),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Optional maximum output tokens override" })),
  freshSession: Type.Optional(Type.Boolean({ description: "Start a fresh workflow child context instead of resuming its prior session" })),
  // Set only by development-workflow from its persisted role configuration.
  workflowMaxTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Internal workflow role output-token limit" })),
  tasks: Type.Optional(Type.Array(TaskSchema, { maxItems: MAX_TASKS })),
  chain: Type.Optional(Type.Array(TaskSchema, { maxItems: MAX_TASKS })),
  agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, { default: "user" })),
  confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
  timeoutMinutes: Type.Optional(Type.Number({ minimum: 1, default: 30 })),
});

function trimOutput(text: string): string {
  if (Buffer.byteLength(text) <= OUTPUT_CAP) return text;
  let value = text.slice(0, OUTPUT_CAP);
  while (Buffer.byteLength(value) > OUTPUT_CAP) value = value.slice(0, -1);
  return `${value}\n\n[Output truncated to 50 KB]`;
}
function finalText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const text = m.content?.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
    if (text) return text;
  }
  return "";
}
async function withConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); }
  }));
  return out;
}
async function removeOldFailedRuns(): Promise<void> {
  await fs.promises.mkdir(RUN_ROOT, { recursive: true });
  const persistent = new Set((await listWorkflows()).map(w => path.resolve(w.runDir)));
  for (const name of await fs.promises.readdir(RUN_ROOT).catch(() => [] as string[])) {
    const p = path.join(RUN_ROOT, name); if (persistent.has(path.resolve(p))) continue;
    const stat = await fs.promises.stat(p).catch(() => undefined);
    if (stat && Date.now() - stat.mtimeMs > FAILED_RETENTION_MS) await fs.promises.rm(p, { recursive: true, force: true });
  }
}
async function gitDirty(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    const p = spawn("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let s = ""; p.stdout.on("data", d => s += d); p.on("close", code => {
      if (code !== 0) return resolve([]);
      const files: string[] = [];
      for (const entry of s.split("\0").filter(Boolean)) {
        const raw = entry.slice(3); const target = raw.includes(" -> ") ? raw.split(" -> ").pop()! : raw;
        files.push(path.resolve(cwd, target));
      }
      resolve(files);
    });
  });
}
function piInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  return { command: "pi", args };
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_CHILD === "1") return;
  const active = new Map<string, ActiveTask>();
  const children = new Map<string, ReturnType<typeof spawn>>();
  const childExits = new Map<string, Promise<void>>();
  const workflowRuns = new Map<string, Promise<void>>();
  const closingWorkflows = new Set<string>();
  const closingAgents = new Set<string>();
  const closingWorkflowRequests = new Map<string, Promise<string>>();
  let widgetCtx: ExtensionContext | undefined;
  const updateWidget = () => {
    if (!widgetCtx?.hasUI) return;
    const rows = [...active.values()].filter(a => a.status === "queued" || a.status === "running");
    if (!rows.length) return widgetCtx.ui.setWidget("subagents", undefined);
    widgetCtx.ui.setWidget("subagents", (_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        const cards: AgentCard[] = rows.slice(0, 8).map(a => ({
          agent: a.agent,
          elapsed: a.startedAt ? `${Math.floor((Date.now() - a.startedAt) / 1000)}s` : "queued",
          model: a.modelUsed ?? a.model ?? "inherited",
          thinking: a.thinkingUsed ?? "inherited",
          currentTool: a.currentTool,
          currentToolElapsed: a.currentToolStartedAt ? `${Math.floor((Date.now() - a.currentToolStartedAt) / 1000)}s` : undefined,
          contextTokens: a.contextTokens,
          lockCount: a.lockCount,
        }));
        const title = truncateToWidth(theme.fg("muted", `Agents (${rows.length} active)`), Math.max(0, width), "");
        const grid = renderAgentGrid(cards, width, {
          border: text => theme.fg("borderMuted", text),
          title: text => theme.fg("text", theme.bold(text)),
          muted: text => theme.fg("muted", text),
          accent: text => theme.fg("accent", text),
        });
        return width > 0 ? [title, ...grid] : [];
      },
    }));
  };
  pi.on("session_start", async (_e, ctx) => { widgetCtx = ctx; await removeOldFailedRuns(); updateWidget(); });
  pi.on("session_shutdown", () => {
    for (const [id, child] of children) { const task = active.get(id); if (task) task.status = "aborted"; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }
    active.clear(); widgetCtx = undefined;
  });

  // Keep cleanup policy in one action implementation so tools and other extensions cannot diverge.
  const closeWorkflow = (workflowId: string): Promise<string> => {
    const inFlight = closingWorkflowRequests.get(workflowId); if (inFlight) return inFlight;
    const closing = (async () => {
      closingWorkflows.add(workflowId);
      try {
        // A run may be preparing before its first registry write. Mark it closing and await
        // every reserved run before deciding whether workflow metadata exists.
        let workflow = await readWorkflow(workflowId);
        const exits: Promise<void>[] = [];
        const stop = (ownerId: string) => {
          const task = active.get(ownerId);
          if (task) { task.status = "aborted"; task.reason = "Workflow closed"; active.delete(ownerId); }
          const child = children.get(ownerId);
          if (child) { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }
          const exit = childExits.get(ownerId); if (exit) exits.push(exit);
        };
        for (const agent of Object.values(workflow?.agents ?? {})) stop(agent.ownerId);
        for (const ownerId of children.keys()) if (ownerId.startsWith(`${safeId(workflowId)}:`)) stop(ownerId);
        updateWidget();
        exits.push(...[...workflowRuns.entries()].filter(([id]) => id.startsWith(`${safeId(workflowId)}:`)).map(([, run]) => run));
        await Promise.all(exits);
        workflow = await readWorkflow(workflowId);
        if (!workflow) return `Workflow ${workflowId} is already closed`;
        return await mutateWorkflow(workflowId, async () => {
          const current = await readWorkflow(workflowId);
          if (!current) return `Workflow ${workflowId} is already closed`;
          const failedAgents = Object.values(current.agents).filter(a => a.status === "failed" || a.status === "aborted");
          // Successful child sessions never accompany retained failed diagnostics.
          await Promise.all(Object.values(current.agents).filter(a => a.status === "done").map(a => fs.promises.rm(a.sessionDir, { recursive: true, force: true })));
          if (!failedAgents.length) await fs.promises.rm(current.runDir, { recursive: true, force: true });
          else if (fs.existsSync(current.runDir)) {
            const retained = path.join(RUN_ROOT, `failed-${Date.now()}-${safeId(workflowId)}`);
            await fs.promises.rename(current.runDir, retained);
            // Retention starts at close, not at the original run's timestamp.
            await fs.promises.utimes(retained, new Date(), new Date());
          }
          // Do not remove registry metadata until its session cleanup has succeeded.
          await fs.promises.rm(workflowDir(workflowId), { recursive: true, force: true });
          return `Closed workflow ${workflowId}${failedAgents.length ? "; failed diagnostics retained for 24 hours" : ""}`;
        });
      } finally { closingWorkflows.delete(workflowId); }
    })();
    closingWorkflowRequests.set(workflowId, closing);
    void closing.then(() => closingWorkflowRequests.delete(workflowId), () => closingWorkflowRequests.delete(workflowId));
    return closing;
  };
  pi.events.on("subagent:request", (data: unknown) => {
    const request = data as Partial<CloseWorkflowRequest>;
    if (request.action !== "closeWorkflow" || typeof request.workflowId !== "string" || typeof request.accept !== "function" || typeof request.resolve !== "function" || typeof request.reject !== "function") return;
    request.accept();
    void closeWorkflow(request.workflowId).then(request.resolve, request.reject);
  });

  pi.registerTool({
    name: "subagent", label: "Subagent",
    description: `Delegate isolated work to user agents in ${path.join(getAgentDir(), "agents")}. Default to single mode. Use tasks only when parallel execution is explicitly requested. Child sessions use normal Pi context and compaction rules, are removed on success, and retained for 24 hours on failure. Maximum ${MAX_TASKS} tasks, ${MAX_CONCURRENCY} concurrent, 30 minute default timeout.`,
    promptSnippet: "Delegate isolated tasks to one or more subagents",
    promptGuidelines: [
      "Use subagent in single mode unless the user explicitly requests parallel agents.",
      "Do not delegate trivial work; use subagent for bounded tasks benefiting from isolated context.",
      "Subagents cannot create other subagents, and file mutations are guarded by cross-process locks.",
    ],
    parameters: Params,
    async execute(_id, params, signal, onUpdate, ctx) {
      widgetCtx = ctx;
      const action = params.action ?? "run";
      if (action === "list") {
        const workflows = await listWorkflows(params.workflowId);
        const text = workflows.length ? workflows.map(w => `${w.workflowId}: ${Object.values(w.agents).map(a => {
          const active = a.activeRunMs ?? 0;
          const idle = (a.idleWaitingMs ?? 0) + (a.status !== "running" && a.lastEndedAt ? Math.max(0, Date.now() - Date.parse(a.lastEndedAt)) : 0);
          return `${a.agentId}=${a.status} (cumulative active run time ${active}ms; persistent idle/waiting time ${idle}ms)`;
        }).join(", ") || "no agents"}`).join("\n") : "No workflow agents.";
        return { content: [{ type: "text", text }], details: { mode: "management", results: [], workflows } as Details };
      }
      if (action === "closeAgent") {
        if (!params.workflowId || !params.agentId) throw new Error("closeAgent requires workflowId and agentId");
        const ownerId = `${safeId(params.workflowId)}:${safeId(params.agentId)}`;
        if (closingAgents.has(ownerId)) throw new Error(`Workflow agent ${params.workflowId}/${params.agentId} is already closing`);
        closingAgents.add(ownerId);
        try {
          const task = active.get(ownerId);
          if (task) { task.status = "aborted"; task.reason = "Agent closed"; active.delete(ownerId); }
          const child = children.get(ownerId);
          if (child) { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }
          updateWidget();
          const exit = childExits.get(ownerId); const run = workflowRuns.get(ownerId);
          await Promise.all([exit, run].filter((value): value is Promise<void> => Boolean(value)));
          await mutateWorkflow(params.workflowId, async () => {
            const workflow = await readWorkflow(params.workflowId!); const agent = workflow?.agents[params.agentId!];
            if (!workflow || !agent) throw new Error(`Unknown workflow agent: ${params.workflowId}/${params.agentId}`);
            const failed = agent.status === "failed" || agent.status === "aborted";
            if (!failed) await fs.promises.rm(agent.sessionDir, { recursive: true, force: true });
            else if (fs.existsSync(agent.sessionDir)) {
              const retained = path.join(RUN_ROOT, `failed-${Date.now()}-${safeId(params.workflowId!)}-${safeId(params.agentId!)}`);
              await fs.promises.rename(agent.sessionDir, retained);
              await fs.promises.utimes(retained, new Date(), new Date());
            }
            delete workflow.agents[params.agentId!]; await writeWorkflow(workflow);
          });
        } finally { closingAgents.delete(ownerId); }
        return { content: [{ type: "text", text: `Closed ${params.workflowId}/${params.agentId}` }], details: { mode: "management", results: [] } as Details };
      }
      if (action === "closeWorkflow") {
        if (!params.workflowId) throw new Error("closeWorkflow requires workflowId");
        const text = await closeWorkflow(params.workflowId);
        return { content: [{ type: "text", text }], details: { mode: "management", results: [] } as Details };
      }
      const workflowLifecycle = params.lifecycle === "workflow";
      if (workflowLifecycle && (!params.workflowId || !params.agentId)) throw new Error("workflow lifecycle requires workflowId and agentId");
      if (workflowLifecycle && (params.tasks?.length || params.chain?.length)) throw new Error("workflow lifecycle supports only agent+task; send one job at a time");
      const scope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, scope); const agents = discovery.agents;
      const single = params.agent && params.task ? [{ agent: params.agent, task: params.task, cwd: params.cwd, model: params.model, thinking: params.thinking, maxTokens: params.maxTokens }] : [];
      const modes = Number(single.length > 0) + Number((params.tasks?.length ?? 0) > 0) + Number((params.chain?.length ?? 0) > 0);
      if (modes !== 1) throw new Error(`Provide exactly one mode: agent+task, tasks, or chain. Available: ${agents.map(a => a.name).join(", ") || "none"}`);
      const specs: TaskSpec[] = single.length ? single : params.tasks?.length ? params.tasks : params.chain!;
      if (specs.length > MAX_TASKS) throw new Error(`Maximum ${MAX_TASKS} tasks`);
      const requested = specs.map(s => agents.find(a => a.name === s.agent));
      const missing = specs.filter((_, i) => !requested[i]).map(s => s.agent);
      if (missing.length) throw new Error(`Unknown agents: ${missing.join(", ")}. Available: ${agents.map(a => a.name).join(", ") || "none"}`);
      const project = requested.filter((a): a is AgentConfig => a?.source === "project");
      if (project.length && (params.confirmProjectAgents ?? true) && ctx.hasUI) {
        const ok = await ctx.ui.confirm("Run project-local agents?", `${project.map(a => a.name).join(", ")}\n${discovery.projectAgentsDir}\n\nThese prompts are repository-controlled.`);
        if (!ok) throw new Error("Project-local agents were not approved");
      }
      const workflowRunId = workflowLifecycle ? `${safeId(params.workflowId!)}:${safeId(params.agentId!)}` : undefined;
      let releaseWorkflowRun: (() => void) | undefined;
      if (workflowRunId) {
        if (closingWorkflows.has(params.workflowId!) || closingAgents.has(workflowRunId) || workflowRuns.has(workflowRunId)) throw new Error(`Workflow agent ${params.workflowId}/${params.agentId} is already running or closing`);
        let release!: () => void;
        workflowRuns.set(workflowRunId, new Promise<void>(resolve => { release = resolve; }));
        releaseWorkflowRun = () => { workflowRuns.delete(workflowRunId); release(); };
      }
      // These values must remain initialized even when registry/setup work throws;
      // the catch path uses them to settle any pre-existing workflow record.
      let workflowStartedAt: number | undefined;
      let workflowAttemptPersisted = false;
      try {
        const runId = workflowLifecycle ? `workflow-${safeId(params.workflowId!)}` : `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        const runDir = workflowLifecycle ? path.join(RUN_ROOT, runId) : path.join(RUN_ROOT, runId); const lockDir = path.join(runDir, "coord");
        const roots = [...new Set(specs.map(s => path.resolve(s.cwd ?? ctx.cwd)))];
        if (workflowLifecycle) await mutateWorkflow(params.workflowId!, async () => {
          await fs.promises.mkdir(lockDir, { recursive: true });
          if (!fs.existsSync(path.join(lockDir, "registry.json"))) {
            const blocked = (await Promise.all(roots.map(gitDirty))).flat();
            await fs.promises.writeFile(path.join(lockDir, "registry.json"), JSON.stringify({ owners: Object.fromEntries(blocked.map(f => [f, "preexisting"])), roots }, null, 2));
          }
        });
        else {
          await fs.promises.mkdir(lockDir, { recursive: true });
          if (!fs.existsSync(path.join(lockDir, "registry.json"))) {
            const blocked = (await Promise.all(roots.map(gitDirty))).flat();
            await fs.promises.writeFile(path.join(lockDir, "registry.json"), JSON.stringify({ owners: Object.fromEntries(blocked.map(f => [f, "preexisting"])), roots }, null, 2));
          }
        }
        const timeout = (params.timeoutMinutes ?? DEFAULT_TIMEOUT_MS / 60_000) * 60_000;

      const runOne = async (spec: TaskSpec, index: number, prior = ""): Promise<RunResult> => {
        const agent = requested[specs.indexOf(spec)]!;
        const id = workflowLifecycle ? `${safeId(params.workflowId!)}:${safeId(params.agentId!)}` : `${runId}-${index + 1}`;
        const task = prior ? spec.task.replace(/\{previous\}/g, prior) : spec.task;
        const state: ActiveTask = { ...spec, task, id, status: "queued", contextTokens: 0, lockCount: 0, workflowId: workflowLifecycle ? params.workflowId : undefined, agentId: workflowLifecycle ? params.agentId : undefined };
        active.set(id, state); updateWidget();
        // Fresh reviewers get a new directory/context. The running-run guard above
        // makes this reset safe: it never deletes a live persisted session.
        const sessionDir = workflowLifecycle ? path.join(runDir, `session-${safeId(params.agentId!)}${params.freshSession ? `-${crypto.randomUUID()}` : ""}`) : path.join(runDir, `session-${index + 1}`);
        await fs.promises.mkdir(sessionDir, { recursive: true });
        let workflow: WorkflowRecord | undefined;
        let existing: WorkflowAgentRecord | undefined;
        state.status = "running"; state.startedAt = Date.now(); workflowStartedAt = state.startedAt; state.sessionDir = sessionDir; updateWidget();
        if (workflowLifecycle) {
          await mutateWorkflow(params.workflowId!, async () => {
            workflow = await readWorkflow(params.workflowId!);
            existing = workflow?.agents[params.agentId!];
            if (existing && (existing.profile !== agent.name || existing.cwd !== path.resolve(spec.cwd ?? ctx.cwd))) throw new Error("A workflow agent cannot change profile or working directory when resumed");
            const now = new Date().toISOString();
            workflow ??= { workflowId: params.workflowId!, runDir, agents: {}, createdAt: now, updatedAt: now };
            const selectedModel = spec.model ?? agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
            const maxTokens = clampMaxTokens(resolveMaxTokens({ perCall: spec.maxTokens, existing: existing?.maxTokens, profile: agent.maxTokens, workflowRole: params.workflowMaxTokens }), modelMaxTokens(ctx, selectedModel));
            const idleWaitingMs = (existing?.idleWaitingMs ?? 0) + (existing?.lastEndedAt ? Math.max(0, Date.now() - Date.parse(existing.lastEndedAt)) : 0);
            workflow.agents[params.agentId!] = { workflowId: params.workflowId!, agentId: params.agentId!, profile: agent.name, sessionDir,
              sessionFile: params.freshSession ? undefined : existing?.sessionFile, status: "running", model: spec.model ?? agent.model, thinking: spec.thinking ?? agent.thinking ?? pi.getThinkingLevel(), maxTokens,
              cwd: path.resolve(spec.cwd ?? ctx.cwd), createdAt: existing?.createdAt ?? now, updatedAt: now, ownerId: id, lastTask: task, lastResult: existing?.lastResult,
              activeRunMs: existing?.activeRunMs ?? 0, idleWaitingMs }; 
            await writeWorkflow(workflow);
          });
          workflowAttemptPersisted = true;
        }
        const promptFile = path.join(runDir, `prompt-${index + 1}.md`);
        await fs.promises.writeFile(promptFile, `${agent.systemPrompt}\n\nYou are a child subagent. You cannot delegate to other agents. Respect all file-lock failures. Report completion, files changed, and unresolved issues.`);
        const args = ["--mode", "json", "-p", "--session-dir", sessionDir];
        if (!params.freshSession && existing?.sessionFile && fs.existsSync(existing.sessionFile)) args.push("--session", existing.sessionFile);
        args.push("--name", `subagent:${agent.name}:${id}`, "--extension", CHILD_GUARD, "--exclude-tools", "subagent", "--append-system-prompt", promptFile);
        const selectedModel = spec.model ?? agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
        const maxTokens = clampMaxTokens(resolveMaxTokens({ perCall: spec.maxTokens, existing: existing?.maxTokens, profile: agent.maxTokens, workflowRole: params.workflowMaxTokens }), modelMaxTokens(ctx, selectedModel));
        const selectedThinking = spec.thinking ?? agent.thinking ?? pi.getThinkingLevel(); state.modelUsed = selectedModel; state.thinkingUsed = selectedThinking; state.maxTokens = maxTokens;
        if (maxTokens !== undefined) args.push("--extension", MAX_TOKENS_OVERRIDE);
        if (selectedModel) args.push("--model", selectedModel);
        args.push("--thinking", selectedThinking);
        if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
        args.push(`Task: ${task}`);
        if (workflowLifecycle && (closingWorkflows.has(params.workflowId!) || closingAgents.has(id))) throw new Error(`Workflow agent ${params.workflowId}/${params.agentId} is closing`);
        const messages: any[] = []; let stderr = ""; let stopReason = ""; let errorMessage = "";
        const usage = { input: 0, output: 0, cost: 0, turns: 0 };
        const invocation = piInvocation(args);
        let resolveChildExit!: () => void;
        const childExit = new Promise<void>(resolve => { resolveChildExit = resolve; });
        const exitCode = await new Promise<number>((resolve) => {
          // Keep the sanitized run ID for subagent internals, but hand the raw workflow
          // identity to workflow tools in separate fields. Encoding both in the run ID is
          // lossy for arbitrary user-supplied workflow IDs.
          const env: NodeJS.ProcessEnv = { ...process.env, PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_ID: id, PI_SUBAGENT_COORD_DIR: lockDir,
            ...(workflowLifecycle ? { PI_WORKFLOW_ID: params.workflowId!, PI_WORKFLOW_ROLE: params.agentId! } : {}) };
          if (maxTokens !== undefined) env.PI_SUBAGENT_MAX_TOKENS = String(maxTokens);
          const child = spawn(invocation.command, invocation.args, { cwd: spec.cwd ?? ctx.cwd, stdio: ["ignore", "pipe", "pipe"], env });
          children.set(id, child); childExits.set(id, childExit);
          let buffer = ""; let finished = false;
          const finish = (code: number) => { if (finished) return; finished = true; children.delete(id); childExits.delete(id); resolveChildExit(); clearTimeout(timer); resolve(code); };
          const timer = setTimeout(() => { state.reason = `Timed out after ${Math.round(timeout / 60_000)} minutes`; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }, timeout);
          const abort = () => { state.reason = "Aborted by parent"; state.status = "aborted"; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); };
          if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
          const line = (raw: string) => {
            if (!raw.trim()) return; let e: any; try { e = JSON.parse(raw); } catch { return; }
            if (e.type === "tool_execution_start") { state.currentTool = `${e.toolName} ${JSON.stringify(e.args ?? {}).slice(0, 100)}`; state.currentToolStartedAt = Date.now(); updateWidget(); }
            if (e.type === "tool_execution_end") { state.currentTool = undefined; state.currentToolStartedAt = undefined; updateWidget(); }
            if (e.type === "message_end" && e.message) {
              messages.push(e.message);
              if (e.message.role === "assistant") { const u = e.message.usage; usage.turns++; usage.input += u?.input ?? 0; usage.output += u?.output ?? 0; usage.cost += u?.cost?.total ?? 0; state.contextTokens = u?.totalTokens ?? 0; state.modelUsed = e.message.model; stopReason = e.message.stopReason ?? stopReason; errorMessage = e.message.errorMessage ?? errorMessage; }
              onUpdate?.({ content: [{ type: "text", text: finalText(messages) || `${agent.name} is working...` }], details: { mode: "single", results: [] } }); updateWidget();
            }
          };
          child.stdout.on("data", d => { buffer += d; const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; lines.forEach(line); });
          child.stderr.on("data", d => stderr += d.toString()); child.on("error", e => { stderr += e.message; finish(1); });
          child.on("close", code => { if (buffer.trim()) line(buffer); finish(code ?? 1); });
        });
        try { const registry = JSON.parse(await fs.promises.readFile(path.join(lockDir, "registry.json"), "utf8")); state.lockCount = Object.values(registry.owners ?? {}).filter(v => v === id).length; } catch {}
        const guardFailure = await fs.promises.readFile(path.join(lockDir, `failure-${id}.txt`), "utf8").catch(() => "");
        if (guardFailure) state.reason = guardFailure.trim();
        const output = trimOutput(finalText(messages)); const failed = exitCode !== 0 || stopReason === "error" || stopReason === "aborted" || Boolean(state.reason);
        state.status = failed ? (state.reason === "Aborted by parent" ? "aborted" : "failed") : "done"; state.output = output; state.reason ||= errorMessage || (failed ? stderr.trim() || `Child exited with code ${exitCode}` : undefined); state.currentTool = undefined; state.currentToolStartedAt = undefined; updateWidget();
        active.delete(id); updateWidget();
        if (workflowLifecycle) await mutateWorkflow(params.workflowId!, async () => {
          workflow = await readWorkflow(params.workflowId!);
          if (workflow?.agents[params.agentId!]) {
            const files = (await fs.promises.readdir(sessionDir).catch(() => [] as string[])).filter(f => f.endsWith(".jsonl")).sort();
            const record = workflow.agents[params.agentId!]; record.sessionFile = files.length ? path.join(sessionDir, files[files.length - 1]) : record.sessionFile;
            record.status = state.status; record.updatedAt = new Date().toISOString(); record.lastEndedAt = record.updatedAt;
            record.activeRunMs = (record.activeRunMs ?? 0) + Math.max(0, Date.now() - (state.startedAt ?? Date.now()));
            record.lastResult = output.slice(0, 2000); record.reason = state.reason;
            await writeWorkflow(workflow);
          }
        });
        return { ...state, exitCode, usage };
      };

      let results: RunResult[] = [];
      if (params.chain?.length) {
        let previous = "";
        for (let i = 0; i < specs.length; i++) { const r = await runOne(specs[i], i, previous); results.push(r); if (r.status !== "done") break; previous = r.output ?? ""; }
      } else if (params.tasks?.length) results = await withConcurrency(specs, MAX_CONCURRENCY, runOne);
      else results = [await runOne(specs[0], 0)];
      const failed = results.filter(r => r.status !== "done");
      if (!workflowLifecycle && !failed.length) await fs.promises.rm(runDir, { recursive: true, force: true });
      const summaries = results.map(r => `### ${r.agent} — ${r.status}\n${r.status === "done" ? r.output || "(no output)" : `Reason: ${r.reason || "unknown failure"}\nSession: ${r.sessionDir}`}`);
        return { content: [{ type: "text", text: `${results.length - failed.length}/${results.length} subagents completed\n\n${summaries.join("\n\n---\n\n")}` }], details: { mode: workflowLifecycle ? "workflow" : params.chain?.length ? "chain" : params.tasks?.length ? "parallel" : "single", results } as Details };
      } catch (error: any) {
        if (workflowLifecycle) await mutateWorkflow(params.workflowId!, async () => {
          const workflow = await readWorkflow(params.workflowId!); const record = workflow?.agents[params.agentId!];
          if (workflow && record) {
            const endedAt = Date.now();
            // If the running record was written, its resume idle interval is already
            // charged. If setup failed first, preserve that interval before closing it.
            if (!settleExceptionalWorkflowTiming(record, workflowStartedAt, endedAt, workflowAttemptPersisted)) return;
            record.status = closingWorkflows.has(params.workflowId!) || closingAgents.has(workflowRunId!) ? "aborted" : "failed";
            record.reason = error.message; record.updatedAt = new Date(endedAt).toISOString(); record.lastEndedAt = record.updatedAt;
            await writeWorkflow(workflow);
          }
        });
        throw error;
      } finally {
        if (workflowRunId) { active.delete(workflowRunId); updateWidget(); }
        releaseWorkflowRun?.();
      }
    },
    renderCall(args, theme) { const count = args.tasks?.length ?? args.chain?.length ?? 1; return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", count === 1 ? args.agent ?? "single" : `${count} agents`), 0, 0); },
    renderResult(result, _options, theme) { const d = result.details as Details | undefined; if (!d) return new Text("subagent", 0, 0); const ok = d.results.filter(r => r.status === "done").length; return new Text(theme.fg(ok === d.results.length ? "success" : "warning", `${ok}/${d.results.length} completed`) + "\n" + d.results.map(r => `${r.status === "done" ? "✓" : "✗"} ${r.agent}: ${r.reason ?? (r.output || "").split("\n")[0]}`).join("\n"), 0, 0); },
  });
}
