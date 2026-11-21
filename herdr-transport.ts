import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { KILL_GRACE_MS } from "./worker-stop.mjs";

const RPC_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 5_000;
const ALLOCATION_RECONCILE_MS = 4_000;
const STOP_TIMEOUT_MS = KILL_GRACE_MS + 2_000;
const CHECK_INTERVAL_MS = 100;
const RUNNER = join(import.meta.dirname, "herdr-worker.mjs");

async function confirmStopped(path: string, deadline: number): Promise<boolean> {
  do {
    try { await access(path); return true; }
    catch { /* Absence is not evidence of exit. */ }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await delay(Math.min(CHECK_INTERVAL_MS, remaining));
  } while (true);
}

export interface WorkerInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface WorkerOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

class HerdrError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}

function rpc(socketPath: string, method: string, params: object, timeoutMs = RPC_TIMEOUT_MS): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection(socketPath, () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
    const reader = createInterface({ input: socket, crlfDelay: Infinity });
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`${method} timed out`)), timeoutMs);
    function finish(error?: Error, result?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reader.close(); socket.destroy();
      if (error) reject(error); else resolve(result);
    }
    socket.on("error", finish);
    socket.on("close", () => finish(new Error(`${method} disconnected before replying`)));
    reader.once("line", line => {
      try {
        const reply = JSON.parse(line);
        if (reply?.id !== id) throw new Error(`${method} returned a mismatched response ID`);
        if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
        if (!reply.result?.type) throw new Error(`${method} returned no result`);
        finish(undefined, reply.result);
      } catch (error) { finish(error as Error); }
    });
  });
}

export class HerdrDispatch {
  private readonly label = `Pi subagent ${randomUUID()}`;
  private workspaceId?: string;
  private tabId?: string;
  private paneId?: string;
  private allocation: "none" | "uncertain" | "acknowledged" | "rejected" = "none";
  private channelWarning?: string;
  private pendingTermination = false;

  get terminationUnconfirmed(): boolean { return this.pendingTermination; }

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  async run(invocation: WorkerInvocation, signal: AbortSignal, output: WorkerOutput): Promise<number> {
    const { HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: callerPane, HERDR_WORKSPACE_ID: callerWorkspace } = this.env;
    if (signal.aborted) return 1;
    if (!socketPath?.startsWith("/") || (!callerPane && !callerWorkspace)) throw new Error("Missing local Herdr socket or caller workspace");
    // A pane may have moved since its environment was injected. Never use focused UI state.
    const caller = callerPane ? await rpc(socketPath, "pane.get", { pane_id: callerPane }) : undefined;
    this.workspaceId = callerPane ? caller?.pane?.workspace_id : callerWorkspace;
    if (!this.workspaceId) throw new Error("Could not resolve the Herdr caller workspace");
    if (signal.aborted) return 1;

    const dir = await mkdtemp(join(tmpdir(), "pi-sa-")); // mode 0700; task and env never go through Herdr's API.
    const channel = join(dir, "worker.sock");
    const stoppedPath = join(dir, "stopped");
    const server = createServer();
    let peer: Socket | undefined;
    let hello: { tabId?: string; paneId?: string } | undefined;
    let listening = false, started = false, finished = false;
    let streamError: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopDeadline: number | undefined;
    let settle!: (result: { code: number; error?: string }) => void;
    const done = new Promise<{ code: number; error?: string }>(resolve => { settle = resolve; });
    const finish = (code: number, error?: string) => {
      if (finished) return;
      finished = true; clearTimeout(timer); settle({ code, error });
    };
    const abort = () => {
      if (finished) return;
      if (!started) return finish(1);
      if (timer) return;
      stopDeadline = performance.now() + STOP_TIMEOUT_MS;
      peer!.write('{"type":"stop"}\n');
      timer = setTimeout(() => finish(1, "Herdr worker did not confirm termination"), STOP_TIMEOUT_MS);
    };
    const start = () => {
      if (started || finished || !hello || !this.tabId) return;
      if (hello.tabId !== this.tabId || hello.paneId !== this.paneId) return finish(1, "Herdr worker connected from an unexpected pane");
      clearTimeout(timer); timer = undefined;
      // Pass the same environment as headless, except for Herdr's own pane context.
      const env = Object.fromEntries(Object.entries(invocation.env).filter(([key]) => !key.startsWith("HERDR_")));
      started = true;
      this.pendingTermination = true;
      peer!.write(JSON.stringify({ type: "start", command: invocation.command, args: invocation.args, env, stoppedPath }) + "\n");
    };
    server.on("connection", socket => {
      socket.on("error", () => {}); // close is the authoritative loss signal.
      if (peer || finished) { socket.destroy(); return; }
      peer = socket;
      socket.once("close", () => finish(1, "Herdr worker channel closed before an exit status (tab closed or runner lost)"));
      const reader = createInterface({ input: socket, crlfDelay: Infinity });
      reader.on("line", line => {
        if (finished) return;
        let frame;
        try { frame = JSON.parse(line); } catch { /* Handled as an unexpected frame below. */ }
        if (frame?.type === "hello" && !hello) { hello = frame; start(); }
        else if (started && frame?.type === "stdout" && typeof frame.text === "string") output.stdout(frame.text);
        else if (started && frame?.type === "stderr" && typeof frame.text === "string") output.stderr(frame.text);
        else if (started && frame?.type === "exit" && Number.isInteger(frame.code) && frame.code >= 0) {
          this.pendingTermination = false;
          const error = streamError ?? (typeof frame.error === "string" ? frame.error : undefined);
          finish(error ? frame.code || 1 : frame.code, error);
        } else if (started) {
          // Keep draining and wait for termination after an invalid frame, just as on abort.
          streamError = "Unexpected Herdr worker frame";
          abort();
        } else finish(1, "Unexpected Herdr worker frame");
      });
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      server.listen(channel); await once(server, "listening"); listening = true;
      if (signal.aborted) return 1;
      this.allocation = "uncertain";
      const result = await rpc(socketPath, "layout.apply", {
        workspace_id: this.workspaceId, tab_label: this.label, focus: false,
        root: { type: "pane", cwd: invocation.cwd, command: [process.versions.bun ? "node" : process.execPath, RUNNER, channel] },
      });
      const layout = result.layout;
      if (result.type !== "layout_apply" || layout?.workspace_id !== this.workspaceId ||
          typeof layout?.tab_id !== "string" || layout.root?.type !== "pane" || typeof layout.root.pane_id !== "string") {
        throw new Error("Herdr returned invalid worker tab or pane IDs");
      }
      this.tabId = layout.tab_id; this.paneId = layout.root.pane_id;
      this.allocation = "acknowledged";
      if (!finished) {
        timer = setTimeout(() => finish(1, "Herdr worker did not connect"), START_TIMEOUT_MS);
        start();
      }
      const resultFrame = await done;
      if (resultFrame.error) output.stderr(`${resultFrame.error}\n`);
      return resultFrame.code;
    } catch (error) {
      // A server error is an explicit rejection, unlike a dropped/malformed reply.
      if (this.allocation === "uncertain" && error instanceof HerdrError) {
        this.allocation = error.code === "layout_apply_failed" ? "rejected" : "none";
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      peer?.destroy();
      if (listening) await new Promise<void>(resolve => server.close(() => resolve()));
      if (this.terminationUnconfirmed) {
        this.pendingTermination = !(await confirmStopped(stoppedPath, stopDeadline ?? performance.now() + STOP_TIMEOUT_MS));
        if (this.pendingTermination) output.stderr("Herdr worker termination could not be confirmed\n");
      }
      await rm(dir, { recursive: true, force: true }).catch(error => {
        this.channelWarning = `Herdr worker channel cleanup: ${String(error)}`;
      });
    }
  }

  /** Return a separate warning instead of replacing the worker's outcome. */
  async cleanup(): Promise<string | undefined> {
    const tabWarning = await this.closeTab();
    return [tabWarning, this.channelWarning].filter(Boolean).join("; ") || undefined;
  }

  private async reconcileTab(socketPath: string): Promise<string | undefined> {
    const deadline = performance.now() + ALLOCATION_RECONCILE_MS;
    let lastError: unknown;
    // A timed-out layout request can still allocate after the first list returns.
    while (performance.now() < deadline) {
      const timeout = Math.min(RPC_TIMEOUT_MS, deadline - performance.now());
      const result = await rpc(socketPath, "tab.list", { workspace_id: this.workspaceId }, timeout).catch(error => {
        if (this.allocation === "rejected") throw error;
        lastError = error;
      });
      if (result) {
        if (result.type !== "tab_list" || !Array.isArray(result.tabs)) throw new Error("Invalid tab list");
        const matches = result.tabs.filter((tab: any) => tab?.workspace_id === this.workspaceId && tab.label === this.label && typeof tab.tab_id === "string");
        if (matches.length > 1) throw new Error("Multiple tabs matched the worker's exact allocation label");
        if (matches.length === 1) return matches[0].tab_id;
        if (this.allocation === "rejected") return;
        lastError = undefined;
      }
      const remaining = deadline - performance.now();
      if (remaining > 0) await delay(Math.min(CHECK_INTERVAL_MS, remaining));
    }
    throw new Error(`Could not confirm whether the worker tab was created${lastError ? `: ${String(lastError)}` : ""}`);
  }

  private async closeTab(): Promise<string | undefined> {
    const socketPath = this.env.HERDR_SOCKET_PATH!;
    try {
      if (this.allocation === "uncertain" || this.allocation === "rejected") {
        this.tabId = await this.reconcileTab(socketPath);
      }
      if (this.tabId) {
        const result = await rpc(socketPath, "tab.close", { tab_id: this.tabId });
        if (result.type !== "ok") throw new Error("Tab close was not acknowledged");
      }
    } catch (error) {
      if (error instanceof HerdrError && error.code === "tab_not_found") return;
      // The exact tab may already be gone even if the close reply was lost.
      if (this.tabId && !(error instanceof HerdrError)) {
        try { await rpc(socketPath, "tab.get", { tab_id: this.tabId }); }
        catch (check) { if (check instanceof HerdrError && check.code === "tab_not_found") return; }
      }
      return `Herdr tab cleanup (${this.tabId ?? this.label}): ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

export function inHerdr(env: NodeJS.ProcessEnv): boolean {
  return process.platform !== "win32" && (env.HERDR_ENV === "1" || Boolean(env.HERDR_SOCKET_PATH && (env.HERDR_PANE_ID || env.HERDR_WORKSPACE_ID)));
}
