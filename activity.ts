import { randomUUID } from "node:crypto";

/** Semantic activity, not a terminal rendering or an Ovis-private message. */
export const ACTIVITY_EVENT = "pi:activity/v1";
export type ActivityStatus = "running" | "completed" | "failed" | "cancelled";
export interface AgentActivity {
  version: 1;
  sessionId: string;
  producer: "subagents";
  id: string;
  revision: number;
  kind: "agent";
  title: string;
  status: ActivityStatus;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  agent?: string;
  model?: string;
  progress?: { label: string };
  result?: string;
  stats?: { turns?: number; toolCalls?: number; tokens?: number };
}

/** Bound UTF-8 bytes without cutting a code point. Strip terminal control characters. */
function text(value: string, maxBytes: number): string {
  let out = "", bytes = 0;
  for (const char of value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    out += char; bytes += size;
  }
  return out;
}

type Update = Pick<AgentActivity, "model" | "progress" | "stats">;

/** Best-effort observation only: listeners cannot change child results or scheduling.
 * A UUID identifies a dispatch, not a reusable workflow role. No event is persisted here.
 */
export function createAgentActivity(
  emit: (name: string, data: AgentActivity) => void,
  context: { sessionId: string; task: string; agent: string; model?: string },
) {
  let ended = false;
  let lastTime = Date.now();
  const timestamp = new Date(lastTime).toISOString();
  let activity: AgentActivity = {
    version: 1, sessionId: context.sessionId, producer: "subagents", id: randomUUID(), revision: 1,
    kind: "agent", title: text(context.task.trim(), 240) || "Subagent", status: "running",
    startedAt: timestamp, updatedAt: timestamp, agent: text(context.agent, 128),
    ...(context.model ? { model: text(context.model, 256) } : {}),
    progress: { label: "Preparing agent" },
  };
  const send = () => {
    // Unit harnesses/embedders without a session cannot safely route activity.
    if (!context.sessionId || context.sessionId.length > 128) return;
    try { emit(ACTIVITY_EVENT, structuredClone(activity)); } catch { /* Presentation must not fail execution. */ }
  };
  const next = () => {
    lastTime = Math.max(lastTime, Date.now());
    activity = { ...activity, revision: activity.revision + 1, updatedAt: new Date(lastTime).toISOString() };
  };
  send();
  return {
    update(update: Update) {
      if (ended) return;
      const model = update.model ? text(update.model, 256) : activity.model;
      const progress = update.progress ? { label: text(update.progress.label, 512) } : undefined;
      const stats = update.stats ? Object.fromEntries(Object.entries(update.stats)
        .filter(([, value]) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) : activity.stats;
      if (model === activity.model && JSON.stringify(progress) === JSON.stringify(activity.progress) && JSON.stringify(stats) === JSON.stringify(activity.stats)) return;
      next(); activity = { ...activity, model, progress, stats }; send();
    },
    finish(status: Exclude<ActivityStatus, "running">, result: string) {
      if (ended) return;
      ended = true; next();
      activity = { ...activity, status, endedAt: activity.updatedAt, progress: undefined, result: text(result, 16_000) };
      send();
    },
  };
}
