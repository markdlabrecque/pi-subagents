// Keeps the herdr pane "working" while background subagents run.
//
// herdr-agent-state.ts (managed by herdr, do not edit) reports "idle" once the
// parent turn settles, even if a background job is still going. This reports
// "working" straight to the herdr socket with the same source and pane, so it
// overrides that idle report while jobs run. Outside herdr it does nothing.

import net from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const socketPath = process.env.HERDR_SOCKET_PATH;
const paneId = process.env.HERDR_PANE_ID;
const enabled = process.env.HERDR_ENV === "1" && !!socketPath && !!paneId;
const source = "herdr:pi";
let seq = Date.now() * 1000;

function send(state: "working" | "idle", sessionPath?: string) {
  const request = {
    id: `${source}:bg:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent",
    params: {
      pane_id: paneId, source, agent: "pi", state,
      seq: (seq = Math.max(seq + 1, Date.now() * 1000)),
      ...(sessionPath ? { agent_session_path: sessionPath } : {}),
    },
  };
  const socket = net.createConnection(process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath!);
  const done = () => socket.destroy();
  socket.on("error", done);
  socket.on("data", done);
  socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  setTimeout(done, 1500).unref?.();
}

export function createHerdrStatus(pi: ExtensionAPI) {
  const running = new Set<string>();
  if (!enabled) return { start(_id: string) {}, end(_id: string) {} };
  let agentActive = false;
  let sessionPath: string | undefined;
  const remember = (ctx: any) => {
    try { const f = ctx?.sessionManager?.getSessionFile?.(); if (typeof f === "string") sessionPath = f; } catch {}
  };

  pi.on("agent_start", (_e, ctx) => { remember(ctx); agentActive = true; });
  // herdr-agent-state just reported idle; report working again if jobs remain.
  pi.on("agent_settled", (_e, ctx) => {
    remember(ctx);
    agentActive = false;
    if (running.size > 0) setTimeout(() => running.size > 0 && send("working", sessionPath), 100);
  });
  pi.on("session_shutdown", () => { running.clear(); });

  return {
    start(jobId: string) {
      running.add(jobId);
      if (!agentActive) send("working", sessionPath);
    },
    end(jobId: string) {
      if (running.delete(jobId) && running.size === 0 && !agentActive) send("idle", sessionPath);
    },
  };
}
