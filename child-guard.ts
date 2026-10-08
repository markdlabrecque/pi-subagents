import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Child sessions may use normal tools, but cannot delegate recursively. */
export default function (pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_CHILD !== "1") return;
  pi.on("tool_call", async (event) => {
    if (event.toolName === "subagent") return { block: true, reason: "Sub-subagents are disabled" };
  });
}
