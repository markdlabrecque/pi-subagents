import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Registry { owners: Record<string, string>; roots: string[]; }
interface Held { release: () => Promise<void>; beforeDirty: Set<string>; backups: Map<string, Buffer | null>; cwd: string; }

const id = process.env.PI_SUBAGENT_ID;
const coord = process.env.PI_SUBAGENT_COORD_DIR;
const registryPath = coord ? path.join(coord, "registry.json") : "";
const mutexPath = coord ? path.join(coord, "mutation.mutex") : "";
const held = new Map<string, Held>();
// Tool calls issued together before either result returns are sibling calls from one
// assistant turn. A child must combine shell work rather than wait on its own mutex.
const pendingBashCalls = new Set<string>();
// Completion does not reopen the allowance: only a real assistant turn_start does.
let usedBashThisTurn = false;
const failurePath = coord && id ? path.join(coord, `failure-${id}.txt`) : "";
const recordFailure = async (reason: string) => { if (failurePath) await fs.promises.writeFile(failurePath, reason).catch(() => {}); };
const configuredWait = Number(process.env.PI_SUBAGENT_MUTEX_WAIT_MS ?? 10_000);
const MUTEX_WAIT_MS = Number.isFinite(configuredWait) && configuredWait >= 0 ? configuredWait : 10_000;
const MUTEX_POLL_MS = 100;
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new Error("Aborted while waiting for the mutation lock"));
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener("abort", aborted); resolve(); }
  function aborted() { clearTimeout(timer); signal?.removeEventListener("abort", aborted); reject(new Error("Aborted while waiting for the mutation lock")); }
  signal?.addEventListener("abort", aborted, { once: true });
});

async function canonical(input: string, cwd: string): Promise<string> {
  const absolute = path.resolve(cwd, input.replace(/^@/, ""));
  try { return await fs.promises.realpath(absolute); }
  catch {
    try { return path.join(await fs.promises.realpath(path.dirname(absolute)), path.basename(absolute)); }
    catch { return absolute; }
  }
}
interface MutexOwner { token: string; pid: number; }
async function mutexOwner(): Promise<MutexOwner | undefined> {
  try {
    const stat = await fs.promises.stat(mutexPath);
    const source = stat.isDirectory() ? path.join(mutexPath, "owner") : mutexPath;
    return JSON.parse(await fs.promises.readFile(source, "utf8"));
  } catch { return undefined; }
}
function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}
async function removeOwnedMutex(token: string): Promise<boolean> {
  const owner = await mutexOwner();
  if (owner?.token !== token) return false;
  const stat = await fs.promises.stat(mutexPath).catch(() => undefined);
  if (!stat) return false;
  if (stat.isDirectory()) {
    // Compatibility with locks created by the previous directory-based guard.
    await fs.promises.rm(mutexPath, { recursive: true, force: true });
    return true;
  }
  // Serialize removers with an atomically published, crash-recoverable election.
  // This closes the check/unlink window without leaving a permanent artifact if
  // the elected remover exits unexpectedly.
  const removalPath = `${mutexPath}.removing`;
  const electionToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  while (true) {
    const temp = `${removalPath}.${electionToken}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify({ token: electionToken, pid: process.pid }), { flag: "wx", mode: 0o600 });
    try {
      await fs.promises.link(temp, removalPath);
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      let election: MutexOwner | undefined;
      try { election = JSON.parse(await fs.promises.readFile(removalPath, "utf8")); } catch {}
      if (!election || processIsAlive(election.pid)) return false;
      await fs.promises.unlink(removalPath).catch(() => {});
    } finally {
      await fs.promises.unlink(temp).catch(() => {});
    }
  }
  try {
    const current = await mutexOwner();
    if (current?.token !== token) return false;
    await fs.promises.unlink(mutexPath);
    return true;
  } finally {
    let election: MutexOwner | undefined;
    try { election = JSON.parse(await fs.promises.readFile(removalPath, "utf8")); } catch {}
    if (election?.token === electionToken) await fs.promises.unlink(removalPath).catch(() => {});
  }
}
async function publishMutex(owner: MutexOwner): Promise<void> {
  const temp = `${mutexPath}.${owner.token}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  try { await fs.promises.link(temp, mutexPath); }
  finally { await fs.promises.unlink(temp).catch(() => {}); }
}
export async function acquireMutationLock(signal?: AbortSignal): Promise<() => Promise<void>> {
  const deadline = Date.now() + MUTEX_WAIT_MS;
  while (true) {
    if (signal?.aborted) throw new Error("Aborted while waiting for the mutation lock");
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      await publishMutex({ token, pid: process.pid });
      return async () => { await removeOwnedMutex(token); };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await mutexOwner();
      if (owner && !processIsAlive(owner.pid) && await removeOwnedMutex(owner.token)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out after ${MUTEX_WAIT_MS}ms waiting for the mutation lock`);
      await sleep(MUTEX_POLL_MS, signal);
    }
  }
}
async function readRegistry(): Promise<Registry> {
  return JSON.parse(await fs.promises.readFile(registryPath, "utf8"));
}
async function writeRegistry(registry: Registry): Promise<void> {
  const temp = `${registryPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(registry, null, 2));
  await fs.promises.rename(temp, registryPath);
}
async function claim(file: string, registry: Registry): Promise<string | undefined> {
  const owner = registry.owners[file];
  if (owner && owner !== id) return owner;
  registry.owners[file] = id!;
}
function normalizeRepositoryRelativePath(value: string): string {
  return path.posix.normalize(process.platform === "win32" ? value.replace(/\\/g, "/") : value);
}
function parsePorcelainV1Z(output: string): string[] {
  const records = output.split("\0"); const paths: string[] = [];
  for (let index = 0; index < records.length - 1; index++) {
    const record = records[index]; if (record.length < 3) continue;
    const status = record.slice(0, 2); paths.push(normalizeRepositoryRelativePath(record.slice(3)));
    // -z rename/copy output is status+new path NUL old path NUL, never C-quoted.
    if (/[RC]/.test(status)) { const original = records[++index]; if (original !== undefined) paths.push(normalizeRepositoryRelativePath(original)); }
  }
  return paths;
}
async function gitDirty(cwd: string): Promise<Set<string>> {
  return new Promise(resolve => {
    const proc = spawn("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let out = ""; proc.stdout.on("data", d => out += d); proc.on("close", async code => {
      if (code !== 0) return resolve(new Set());
      resolve(new Set(await Promise.all(parsePorcelainV1Z(out).map(name => canonical(name, cwd)))));
    });
  });
}
async function backupForeign(registry: Registry): Promise<Map<string, Buffer | null>> {
  const backups = new Map<string, Buffer | null>();
  for (const [file, owner] of Object.entries(registry.owners)) {
    if (owner === id) continue;
    try { backups.set(file, await fs.promises.readFile(file)); } catch { backups.set(file, null); }
  }
  return backups;
}
async function restore(file: string, content: Buffer | null): Promise<void> {
  if (content === null) await fs.promises.rm(file, { recursive: true, force: true });
  else { await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, content); }
}
async function currentContent(file: string): Promise<Buffer | null> {
  try { return await fs.promises.readFile(file); } catch { return null; }
}
export async function auditProtectedMutations(registry: Registry, backups: Map<string, Buffer | null>, ownerId: string): Promise<string[]> {
  const violations: string[] = [];
  for (const [file, backup] of backups) {
    const current = await currentContent(file);
    const changed = backup === null ? current !== null : current === null || !backup.equals(current);
    if (!changed) continue;
    const owner = registry.owners[file];
    if (owner === "preexisting") {
      registry.owners[file] = ownerId;
      continue;
    }
    if (owner && owner !== ownerId) {
      violations.push(`${file} (owned by ${owner})`);
      await restore(file, backup);
    }
  }
  return violations;
}
function targetPath(tool: string, input: any): string | undefined {
  if (tool !== "edit" && tool !== "write") return undefined;
  return typeof input?.path === "string" ? input.path : typeof input?.file_path === "string" ? input.file_path : undefined;
}

export default function (pi: ExtensionAPI) {
  if (!id || !coord) return;
  pi.on("turn_start" as any, () => { usedBashThisTurn = false; });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "subagent") return { block: true, reason: "Sub-subagents are disabled" };
    const fileArg = targetPath(event.toolName, event.input);
    if (!fileArg && event.toolName !== "bash") return;
    if (event.toolName === "bash") {
      if (usedBashThisTurn || pendingBashCalls.size) {
        const reason = "At most one bash call per assistant turn: sibling bash calls must combine commands into one compound command.";
        await recordFailure(reason);
        return { block: true, reason };
      }
      usedBashThisTurn = true;
      pendingBashCalls.add(event.toolCallId);
    }
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireMutationLock(ctx.signal);
      const registry = await readRegistry();
      const beforeDirty = await gitDirty(ctx.cwd);
      if (fileArg) {
        const file = await canonical(fileArg, ctx.cwd); const conflict = await claim(file, registry);
        if (conflict) {
          const reason = `File is locked by ${conflict}: ${file}`;
          await recordFailure(reason); await release(); return { block: true, reason };
        }
        await writeRegistry(registry);
        held.set(event.toolCallId, { release, beforeDirty, backups: new Map(), cwd: ctx.cwd });
        return;
      }
      // Every bash call is serialized. Back up all files owned by another agent so
      // an undeclared shell mutation can be detected and reversed after execution.
      const backups = await backupForeign(registry);
      held.set(event.toolCallId, { release, beforeDirty, backups, cwd: ctx.cwd });
    } catch (error: any) {
      if (event.toolName === "bash") pendingBashCalls.delete(event.toolCallId);
      if (release) await release();
      return { block: true, reason: `Unable to acquire mutation guard: ${error?.message ?? error}` };
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "bash") pendingBashCalls.delete(event.toolCallId);
    const state = held.get(event.toolCallId); if (!state) return;
    held.delete(event.toolCallId);
    const violations: string[] = [];
    try {
      const registry = await readRegistry();
      if (event.toolName === "bash") {
        const after = await gitDirty(state.cwd);
        // Git reports the complete dirty set, not only files changed by this command.
        // Claim only previously unowned files here; compare protected-file contents
        // below to distinguish real mutations from unchanged preexisting dirt.
        for (const file of after) {
          if (!registry.owners[file]) registry.owners[file] = id!;
        }
        violations.push(...await auditProtectedMutations(registry, state.backups, id!));
        await writeRegistry(registry);
      }
    } finally { await state.release(); }
    if (violations.length) {
      await recordFailure(`Shell lock violation:\n${[...new Set(violations)].join("\n")}`);
      return {
        content: [{ type: "text", text: `LOCK VIOLATION: shell command touched files owned by another agent. Unauthorized changes were restored.\n${[...new Set(violations)].join("\n")}` }],
        isError: true,
      };
    }
  });

  pi.on("session_shutdown", async () => {
    for (const state of held.values()) await state.release().catch(() => {});
    held.clear(); pendingBashCalls.clear(); usedBashThisTurn = false;
  });
}
