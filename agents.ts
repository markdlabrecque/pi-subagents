/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	maxTokens?: number;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		const thinking = frontmatter.thinking;
		if (thinking && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) {
			continue;
		}
		const parsedMaxTokens = frontmatter.maxTokens === undefined ? undefined : Number(frontmatter.maxTokens);
		const maxTokens = Number.isSafeInteger(parsedMaxTokens) && parsedMaxTokens > 0 ? parsedMaxTokens : undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			thinking: thinking as AgentConfig["thinking"],
			maxTokens,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function loadAgentsFromProviders(): AgentConfig[] {
	const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents.agent-providers")];
	if (!(registry instanceof Map)) return [];

	const agents: AgentConfig[] = [];
	for (const provider of registry.values()) {
		if (typeof provider !== "function") continue;
		let entries: unknown;
		try {
			entries = provider();
		} catch {
			continue;
		}
		if (!Array.isArray(entries)) continue;
		for (const entry of entries) {
			try {
				if (!entry || typeof entry !== "object") continue;
				const { name, description, tools, model, thinking, maxTokens, systemPrompt, source, filePath } = entry;
				if (typeof name !== "string" || !name.trim() ||
					typeof description !== "string" || !description.trim() ||
					typeof systemPrompt !== "string" || typeof filePath !== "string" || !filePath.trim() ||
					source !== "user") continue;
				if (tools !== undefined && (!Array.isArray(tools) || !tools.every(t => typeof t === "string"))) continue;
				if (model !== undefined && typeof model !== "string") continue;
				if (thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) continue;
				if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) continue;
				agents.push({ name, description, tools, model, thinking, maxTokens, systemPrompt, source, filePath });
			} catch {
				// A malformed entry must not hide other profiles from this provider.
			}
		}
	}
	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	// Explicit user files override providers; project files still override both.
	const userAgents = scope === "project" ? [] : [...loadAgentsFromProviders(), ...loadAgentsFromDir(userDir, "user")];
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
