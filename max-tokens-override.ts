import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Return a valid positive integer token limit, or no override. */
export function normalizeMaxTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Never raise a model's configured output limit. */
export function applyMaxTokens<T extends { maxTokens?: number }>(model: T, requested: unknown): number | undefined {
  const limit = normalizeMaxTokens(requested);
  if (limit === undefined) return undefined;
  const modelLimit = normalizeMaxTokens(model.maxTokens);
  const effective = modelLimit === undefined ? limit : Math.min(limit, modelLimit);
  model.maxTokens = effective;
  return effective;
}

/**
 * Child-only runtime override. Pi has no --max-tokens CLI flag, so the parent adds
 * this extension only when a resolved child limit exists. It updates both initial
 * and restored/model-selected sessions, and clamps to the selected model limit.
 */
export default function (pi: ExtensionAPI) {
  const requested = normalizeMaxTokens(Number(process.env.PI_SUBAGENT_MAX_TOKENS));
  if (requested === undefined) return;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.model) applyMaxTokens(ctx.model, requested);
  });
  pi.on("model_select", event => {
    applyMaxTokens(event.model, requested);
  });
}
