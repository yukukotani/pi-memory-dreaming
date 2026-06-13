import type { DreamingMemory } from "./types.js";
import type { SessionDigest } from "./session.js";

export const DREAMING_SYSTEM_PROMPT = `You are pi-dreaming, a memory maintenance process for a local coding assistant.
Maintain durable Markdown memories that will help future conversations.
Return strict JSON only. Do not wrap the response in markdown fences.
Never save secrets, credentials, API keys, passwords, tokens, private keys, or one-time codes.
Mark health, finance, legal, political, religious, biometric, or highly personal information as sensitive unless the user explicitly asked to remember it.
Only propose durable, stable, reusable memories. Use delete only when an existing memory is clearly stale, contradicted, or superseded.`;

export function buildRecallSystemPrompt(memories: DreamingMemory[], limit: number): string {
	const active = memories
		.filter((memory) => memory.sensitivity === "normal")
		.sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, limit);
	if (active.length === 0) return "";

	const lines = active.flatMap((memory) => [
		`- [[${memory.slug}]] ${memory.name} (${memory.kind}, ${memory.confidence.toFixed(2)}): ${memory.description}`,
		...memory.body
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.slice(0, 6)
			.map((line) => `  ${line}`),
	]);
	return [
		"## Saved memories from pi-dreaming",
		"Use these Markdown memories as background context. Do not mention them unless relevant.",
		"If the user corrects a memory, prefer the user's latest instruction.",
		...lines,
	].join("\n");
}

export function buildDreamingUserPrompt(params: {
	digest: SessionDigest;
	activeMemories: DreamingMemory[];
}): string {
	return [
		"Analyze the conversation digest and maintain the Markdown memory set.",
		"Output shape:",
		`{"memories":[{"action":"upsert","slug":"stable-slug","kind":"preference|fact|workflow|correction|project","name":"Short title","description":"One-line summary","body":"# Short title\\n\\nDurable Markdown memory with optional [[other-slug]] links.","confidence":0.0,"sensitivity":"normal|sensitive|forbidden","tags":["..."]},{"action":"delete","slug":"stale-slug","deleteReason":"why stale"},{"action":"ignore"}]}`,
		"Use action=upsert for new or updated durable normal memories.",
		"Use action=delete only when an existing memory is clearly stale, contradicted, or superseded; include its slug.",
		"Use action=ignore for observations that are not durable.",
		"Prefer stable lowercase kebab-case slugs. Preserve existing slugs when updating a memory.",
		"Markdown bodies should be concise, reusable, and may link related memories as [[slug]].",
		"Do not include secrets or sensitive personal data. Runtime will drop unsafe or low-confidence operations instead of saving candidates.",
		"",
		"<active_markdown_memories>",
		formatMemories(params.activeMemories),
		"</active_markdown_memories>",
		"",
		`<conversation_digest session=${JSON.stringify(params.digest.sessionKey)} signature=${JSON.stringify(params.digest.signature)}>` ,
		params.digest.text,
		"</conversation_digest>",
	].join("\n");
}

function formatMemories(memories: DreamingMemory[]): string {
	if (memories.length === 0) return "(none)";
	return memories
		.slice(0, 80)
		.map((memory) => [
			`slug=${memory.slug} | kind=${memory.kind} | confidence=${memory.confidence.toFixed(2)} | sensitivity=${memory.sensitivity}`,
			`name=${memory.name}`,
			`description=${memory.description}`,
			memory.body,
		].join("\n"))
		.join("\n\n---\n\n");
}
