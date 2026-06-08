import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SourceDigest } from "./types.js";

interface ContentBlock {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface SessionEntryLike {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
	};
}

export interface SessionDigest extends SourceDigest {
	text: string;
	charCount: number;
}

export function buildSessionDigest(ctx: ExtensionContext, maxChars: number): SessionDigest {
	const entries = readBranchEntries(ctx);
	const text = truncateFromEnd(buildConversationText(entries), maxChars).trim();
	const sessionKey = getSessionKey(ctx);
	const messageCount = countTextMessages(entries);
	const signature = createHash("sha256").update(`${sessionKey}\n${messageCount}\n${text}`).digest("hex").slice(0, 24);
	const capturedAt = new Date().toISOString();

	return {
		sessionKey,
		signature,
		messageCount,
		excerpt: text.replace(/\s+/g, " ").slice(0, 500),
		capturedAt,
		text,
		charCount: text.length,
	};
}

export function shouldSkipUnchanged(lastSignature: string | undefined, digest: SessionDigest, minChars: number): string | undefined {
	if (digest.charCount < minChars) return `session digest below threshold (${digest.charCount}/${minChars} chars)`;
	if (lastSignature && lastSignature === digest.signature) return "session signature unchanged";
	return undefined;
}

export function isStaleCtxError(error: unknown): boolean {
	return /stale after session replacement/.test(String(error));
}

function readBranchEntries(ctx: ExtensionContext): SessionEntryLike[] {
	try {
		return ctx.sessionManager.getBranch() as SessionEntryLike[];
	} catch (error) {
		if (isStaleCtxError(error)) return [];
		throw error;
	}
}

function getSessionKey(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionFile() ?? `memory:${ctx.cwd}`;
	} catch (error) {
		if (isStaleCtxError(error)) return "memory:stale-session";
		throw error;
	}
}

function buildConversationText(entries: SessionEntryLike[]): string {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;

		const lines = extractTextParts(entry.message.content)
			.map((text) => `${role}: ${text.trim()}`)
			.filter((line) => line.trim().length > 0);
		if (role === "assistant") lines.push(...extractToolCallLines(entry.message.content));
		if (lines.length > 0) sections.push(lines.join("\n"));
	}
	return sections.join("\n\n");
}

function countTextMessages(entries: SessionEntryLike[]): number {
	return entries.filter((entry) => {
		if (entry.type !== "message" || !entry.message?.role) return false;
		if (entry.message.role !== "user" && entry.message.role !== "assistant") return false;
		return extractTextParts(entry.message.content).length > 0;
	}).length;
}

function extractTextParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		const block = raw as ContentBlock;
		if (block.type === "text" && typeof block.text === "string" && block.text.trim()) parts.push(block.text);
	}
	return parts;
}

function extractToolCallLines(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		const block = raw as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		lines.push(`assistant tool_call: ${block.name} ${JSON.stringify(block.arguments ?? {})}`);
	}
	return lines;
}

function truncateFromEnd(text: string, maxChars: number): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	return text.slice(text.length - maxChars);
}
