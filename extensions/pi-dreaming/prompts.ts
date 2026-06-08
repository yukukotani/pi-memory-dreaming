import type { DreamingMemory } from "./types.js";
import type { SessionDigest } from "./session.js";

export const DREAMING_SYSTEM_PROMPT = `You are pi-dreaming, a memory synthesis process for a local coding assistant.
Extract durable memories that will help future conversations.
Return strict JSON only. Do not include markdown.
Never save secrets, credentials, API keys, passwords, tokens, private keys, or one-time codes.
Mark health, finance, legal, political, religious, biometric, or highly personal information as sensitive unless the user explicitly asked to remember it.`;

export function buildRecallSystemPrompt(memories: DreamingMemory[], limit: number): string {
	const active = memories
		.filter((memory) => memory.status === "active")
		.sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, limit);
	if (active.length === 0) return "";

	const lines = active.map((memory) => `- [${memory.kind}, ${memory.confidence.toFixed(2)}] ${memory.content}`);
	return [
		"## Saved memories from pi-dreaming",
		"Use these memories as background context. Do not mention them unless relevant.",
		"If the user corrects a memory, prefer the user's latest instruction.",
		...lines,
	].join("\n");
}

export function buildDreamingUserPrompt(params: {
	digest: SessionDigest;
	activeMemories: DreamingMemory[];
	candidateMemories: DreamingMemory[];
}): string {
	return [
		"Analyze the conversation digest and propose memory updates.",
		"Output shape:",
		`{"memories":[{"action":"upsert","kind":"preference|fact|workflow|correction|project","content":"...","confidence":0.0,"sensitivity":"normal|sensitive|forbidden","tags":["..."],"rationale":"..."}]}`,
		"Use action=archive only when an existing memory is clearly stale or contradicted; include its id.",
		"Use action=ignore for observations that are not durable.",
		"Auto-save candidates should be concise, stable, and useful across future sessions.",
		"Forbidden memories must never become active.",
		"",
		"<active_memories>",
		formatMemories(params.activeMemories),
		"</active_memories>",
		"",
		"<candidate_memories>",
		formatMemories(params.candidateMemories),
		"</candidate_memories>",
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
		.map(
			(memory) =>
				`${memory.id} | ${memory.status} | ${memory.kind} | ${memory.confidence.toFixed(2)} | ${memory.sensitivity} | ${memory.content}`,
		)
		.join("\n");
}
