import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildDreamingUserPrompt, DREAMING_SYSTEM_PROMPT } from "./prompts.js";
import { buildSessionDigest, shouldSkipUnchanged } from "./session.js";
import {
	deleteDreamingMemory,
	findDreamingMemory,
	listActiveMemories,
	loadDreamingMemoryStore,
	makeMemorySlug,
	normalizeMemory,
	rememberLastRun,
	saveDreamingMemory,
	saveDreamingMemoryState,
	writeDreamingIndex,
} from "./store.js";
import type {
	DreamingLastRun,
	DreamingMaintenanceOperation,
	DreamingMaintenanceResult,
	DreamingMemory,
	DreamingMemoryStore,
	DreamingRunOptions,
	DreamingRunResult,
	DreamingState,
	MemoryKind,
	MemorySensitivity,
	SourceDigest,
} from "./types.js";

const DEFAULT_FAILURE_RESULT = { saved: 0, deleted: 0, dropped: 0 };
const SECRET_PATTERNS = [
	/\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)\b\s*[:=]\s*\S+/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\bsk-[A-Za-z0-9_-]{20,}\b/,
	/\b[A-Za-z0-9_=-]{32,}\.[A-Za-z0-9_=-]{16,}\.[A-Za-z0-9_=-]{16,}\b/,
];
const VALID_KINDS = new Set<MemoryKind>(["preference", "fact", "workflow", "correction", "project"]);
const VALID_SENSITIVITIES = new Set<MemorySensitivity>(["normal", "sensitive", "forbidden"]);

interface ApplyCounts {
	saved: number;
	deleted: number;
	dropped: number;
}

interface RequiredMemoryOperation {
	slug: string;
	kind: MemoryKind;
	name: string;
	description: string;
	body: string;
	confidence: number;
	sensitivity: MemorySensitivity;
	tags: string[];
	malformed: boolean;
}

export async function runDreaming(ctx: ExtensionContext, options: DreamingRunOptions): Promise<DreamingRunResult> {
	const startedAt = new Date().toISOString();
	const store = loadDreamingMemoryStore(ctx.cwd);
	const settings = store.state.settings;

	if (!settings.enabled && !options.force) {
		return finishRun(
			ctx.cwd,
			store.state,
			{
				status: "skipped",
				reason: options.reason,
				message: "pi-dreaming is disabled",
				...DEFAULT_FAILURE_RESULT,
			},
			startedAt,
		);
	}

	const digest = buildSessionDigest(ctx, settings.maxDigestChars);
	const skipReason = options.force ? undefined : shouldSkipUnchanged(store.state.lastRun?.signature, digest, settings.minCharsForDream);
	if (skipReason) {
		return finishRun(
			ctx.cwd,
			store.state,
			{
				status: "skipped",
				reason: options.reason,
				signature: digest.signature,
				message: skipReason,
				...DEFAULT_FAILURE_RESULT,
			},
			startedAt,
		);
	}

	if (!ctx.model) {
		return finishRun(
			ctx.cwd,
			store.state,
			{
				status: "failed",
				reason: options.reason,
				signature: digest.signature,
				message: "no active model is selected",
				...DEFAULT_FAILURE_RESULT,
			},
			startedAt,
		);
	}

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) {
			return finishRun(
				ctx.cwd,
				store.state,
				{
					status: "failed",
					reason: options.reason,
					signature: digest.signature,
					message: `model auth failed for ${ctx.model.provider}/${ctx.model.id}: ${auth.error}`,
					...DEFAULT_FAILURE_RESULT,
				},
				startedAt,
			);
		}
		if (!auth.apiKey) {
			return finishRun(
				ctx.cwd,
				store.state,
				{
					status: "failed",
					reason: options.reason,
					signature: digest.signature,
					message: `no API key for ${ctx.model.provider}/${ctx.model.id}`,
					...DEFAULT_FAILURE_RESULT,
				},
				startedAt,
			);
		}

		const userMessage: UserMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: buildDreamingUserPrompt({
						digest,
						activeMemories: listActiveMemories(store),
					}),
				},
			],
			timestamp: Date.now(),
		};

		const response = await complete(
			ctx.model,
			{ systemPrompt: DREAMING_SYSTEM_PROMPT, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 4_096 },
		);

		if (response.stopReason === "aborted") {
			return finishRun(
				ctx.cwd,
				store.state,
				{
					status: "skipped",
					reason: options.reason,
					signature: digest.signature,
					message: "dreaming model call was aborted",
					...DEFAULT_FAILURE_RESULT,
				},
				startedAt,
			);
		}
		if (response.stopReason === "error") {
			return finishRun(
				ctx.cwd,
				store.state,
				{
					status: "failed",
					reason: options.reason,
					signature: digest.signature,
					message: response.errorMessage ?? "dreaming model call failed",
					...DEFAULT_FAILURE_RESULT,
				},
				startedAt,
			);
		}

		const result = parseMaintenanceResult(extractText(response.content));
		const counts = applyMaintenance(ctx.cwd, store, result, digest, options.dryRun === true);
		return finishRun(
			ctx.cwd,
			store.state,
			{
				status: "completed",
				reason: options.reason,
				signature: digest.signature,
				message: options.dryRun ? "dry-run completed; Markdown store unchanged" : "dreaming completed",
				...counts,
			},
			startedAt,
			options.dryRun === true,
		);
	} catch (error) {
		return finishRun(
			ctx.cwd,
			store.state,
			{
				status: "failed",
				reason: options.reason,
				signature: digest.signature,
				message: String(error),
				...DEFAULT_FAILURE_RESULT,
			},
			startedAt,
		);
	}
}

function applyMaintenance(
	cwd: string,
	store: DreamingMemoryStore,
	result: DreamingMaintenanceResult,
	digest: SourceDigest,
	dryRun: boolean,
): ApplyCounts {
	const counts: ApplyCounts = { saved: 0, deleted: 0, dropped: 0 };
	let changed = false;

	for (const operation of result.memories) {
		if (operation.action === "ignore") continue;
		if (operation.action === "delete") {
			const slug = typeof operation.slug === "string" ? makeMemorySlug(operation.slug) : "";
			if (!slug) {
				counts.dropped++;
				continue;
			}
			const existing = findDreamingMemory(store, slug);
			if (!existing) continue;
			counts.deleted++;
			if (!dryRun) {
				if (!deleteDreamingMemory(cwd, slug)) throw new Error(`failed to delete memory ${slug}`);
				store.memories = store.memories.filter((memory) => memory.slug !== slug);
				changed = true;
			}
			continue;
		}
		if (operation.action !== "upsert") {
			counts.dropped++;
			continue;
		}

		const normalized = normalizeOperation(store, operation, digest);
		if (!shouldPersistMemory(store, normalized)) {
			counts.dropped++;
			continue;
		}
		counts.saved++;
		if (dryRun) continue;

		const memory = normalizeMemory(normalized);
		if (!memory) {
			counts.dropped++;
			counts.saved--;
			continue;
		}
		if (!saveDreamingMemory(cwd, memory)) throw new Error(`failed to save memory ${memory.slug}`);
		const index = store.memories.findIndex((existing) => existing.slug === memory.slug);
		if (index === -1) store.memories.push(memory);
		else store.memories[index] = memory;
		changed = true;
	}

	if (changed && !dryRun && !writeDreamingIndex(cwd, store.memories)) {
		throw new Error("failed to update dreaming memory index");
	}

	return counts;
}

function normalizeOperation(
	store: DreamingMemoryStore,
	operation: DreamingMaintenanceOperation,
	digest: SourceDigest,
): RequiredMemoryOperation & Pick<DreamingMemory, "createdAt" | "updatedAt" | "lastSeenAt" | "lastUsedAt" | "sources"> {
	const now = new Date().toISOString();
	const body = typeof operation.body === "string" ? operation.body.trim() : "";
	const slug = makeMemorySlug(stringValue(operation.slug) || stringValue(operation.name) || body);
	const existing = findDreamingMemory(store, slug);
	const kind = parseKind(operation.kind);
	const sensitivity = containsSecret(memorySafetyText(operation)) ? "forbidden" : parseSensitivity(operation.sensitivity) ?? "normal";
	const confidence = parseConfidence(operation.confidence);
	const tagsMalformed = operation.tags !== undefined && (!Array.isArray(operation.tags) || operation.tags.some((tag) => typeof tag !== "string"));
	const malformed =
		!body ||
		(operation.kind !== undefined && !kind) ||
		(operation.sensitivity !== undefined && !parseSensitivity(operation.sensitivity)) ||
		(operation.confidence !== undefined && confidence === undefined) ||
		tagsMalformed;
	const name = stringValue(operation.name).trim() || existing?.name || titleFromSlug(slug);
	return {
		slug,
		kind: kind ?? existing?.kind ?? "fact",
		name,
		description: stringValue(operation.description).trim() || existing?.description || firstParagraph(body).slice(0, 180) || name,
		body,
		confidence: confidence ?? existing?.confidence ?? 0.5,
		sensitivity,
		tags: Array.isArray(operation.tags)
			? operation.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean).slice(0, 8)
			: existing?.tags ?? [],
		malformed,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		lastSeenAt: now,
		lastUsedAt: existing?.lastUsedAt,
		sources: mergeSources(existing?.sources ?? [], digest),
	};
}

function shouldPersistMemory(store: DreamingMemoryStore, operation: RequiredMemoryOperation): boolean {
	if (operation.malformed) return false;
	if (operation.sensitivity !== "normal") return false;
	if (operation.confidence < store.state.settings.autoSaveMinConfidence) return false;
	return !containsSecret([operation.name, operation.description, operation.body, operation.tags.join(" ")].join("\n"));
}

function parseMaintenanceResult(text: string): DreamingMaintenanceResult {
	const json = extractJsonObject(text);
	const parsed = JSON.parse(json) as unknown;
	if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { memories?: unknown }).memories)) {
		return { memories: [] };
	}
	return {
		memories: (parsed as { memories: unknown[] }).memories
			.filter(isPlainObject)
			.map((memory) => memory as unknown as DreamingMaintenanceOperation),
	};
}

function extractJsonObject(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) return trimmed;
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) throw new Error("dreaming response did not contain JSON");
	return trimmed.slice(start, end + 1);
}

function extractText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function parseKind(value: unknown): MemoryKind | undefined {
	return typeof value === "string" && VALID_KINDS.has(value as MemoryKind) ? (value as MemoryKind) : undefined;
}

function parseSensitivity(value: unknown): MemorySensitivity | undefined {
	return typeof value === "string" && VALID_SENSITIVITIES.has(value as MemorySensitivity)
		? (value as MemorySensitivity)
		: undefined;
}

function parseConfidence(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return clamp(value, 0, 1);
}

function mergeSources(existing: SourceDigest[], digest: SourceDigest): SourceDigest[] {
	const withoutCurrent = existing.filter((source) => source.signature !== digest.signature);
	return [digest, ...withoutCurrent].slice(0, 8);
}

function memorySafetyText(operation: DreamingMaintenanceOperation): string {
	return [operation.slug, operation.name, operation.description, operation.body, ...(Array.isArray(operation.tags) ? operation.tags : [])]
		.filter((part): part is string => typeof part === "string")
		.join("\n");
}

function containsSecret(text: string): boolean {
	return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function finishRun(
	cwd: string,
	state: DreamingState,
	result: DreamingRunResult,
	startedAt: string,
	skipSave = false,
): DreamingRunResult {
	const lastRun: DreamingLastRun = {
		startedAt,
		finishedAt: new Date().toISOString(),
		reason: result.reason,
		status: result.status,
		message: result.message,
	};
	if (result.signature) lastRun.signature = result.signature;
	const next = rememberLastRun(state, lastRun);
	if (!skipSave && !saveDreamingMemoryState(cwd, next)) {
		return {
			...result,
			status: "failed",
			message: `failed to save dreaming state after ${result.status}: ${result.message}`,
		};
	}
	return result;
}

function titleFromSlug(slug: string): string {
	return slug.split("-").filter(Boolean).map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" ") || "Memory";
}

function firstParagraph(text: string): string {
	return text.split(/\n\s*\n/).map((part) => part.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
