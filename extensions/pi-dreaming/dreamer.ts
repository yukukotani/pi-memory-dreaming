import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildDreamingUserPrompt, DREAMING_SYSTEM_PROMPT } from "./prompts.js";
import { buildSessionDigest, shouldSkipUnchanged } from "./session.js";
import {
	getActiveMemories,
	getCandidateMemories,
	loadDreamingStore,
	makeMemoryId,
	rememberLastRun,
	saveDreamingStore,
} from "./store.js";
import type {
	DreamingLastRun,
	DreamingMemory,
	DreamingRunOptions,
	DreamingRunResult,
	DreamingStore,
	DreamingSynthesisCandidate,
	DreamingSynthesisResult,
	MemoryKind,
	MemorySensitivity,
	SourceDigest,
} from "./types.js";

const DEFAULT_FAILURE_RESULT = { saved: 0, candidates: 0, archived: 0 };
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
	candidates: number;
	archived: number;
}

export async function runDreaming(ctx: ExtensionContext, options: DreamingRunOptions): Promise<DreamingRunResult> {
	const startedAt = new Date().toISOString();
	const store = loadDreamingStore(ctx.cwd);

	if (!store.settings.enabled && !options.force) {
		return finishRun(
			ctx.cwd,
			store,
			{
				status: "skipped",
				reason: options.reason,
				message: "pi-dreaming is disabled",
				...DEFAULT_FAILURE_RESULT,
			},
			startedAt,
		);
	}

	const digest = buildSessionDigest(ctx, store.settings.maxDigestChars);
	const skipReason = options.force ? undefined : shouldSkipUnchanged(store.lastRun?.signature, digest, store.settings.minCharsForDream);
	if (skipReason) {
		return finishRun(
			ctx.cwd,
			store,
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
			store,
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
				store,
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
				store,
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
						activeMemories: getActiveMemories(store),
						candidateMemories: getCandidateMemories(store),
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
				store,
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
				store,
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

		const result = parseSynthesisResult(extractText(response.content));
		const counts = applySynthesis(store, result, digest, options.dryRun === true);
		return finishRun(
			ctx.cwd,
			store,
			{
				status: "completed",
				reason: options.reason,
				signature: digest.signature,
				message: options.dryRun ? "dry-run completed; store unchanged" : "dreaming completed",
				...counts,
			},
			startedAt,
			options.dryRun === true,
		);
	} catch (error) {
		return finishRun(
			ctx.cwd,
			store,
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

function applySynthesis(store: DreamingStore, result: DreamingSynthesisResult, digest: SourceDigest, dryRun: boolean): ApplyCounts {
	const counts: ApplyCounts = { saved: 0, candidates: 0, archived: 0 };
	const now = new Date().toISOString();

	for (const candidate of result.memories) {
		if (candidate.action === "ignore") continue;
		if (candidate.action === "archive") {
			const target = candidate.id ? store.memories.find((memory) => memory.id === candidate.id) : undefined;
			if (!target) continue;
			counts.archived++;
			if (!dryRun) {
				target.status = "archived";
				target.updatedAt = now;
				target.rationale = candidate.archiveReason ?? candidate.rationale ?? target.rationale;
			}
			continue;
		}
		const hasMalformedAction = candidate.action !== "upsert";

		const normalized = normalizeCandidate(candidate, hasMalformedAction);
		if (!normalized) continue;

		const status = shouldAutoSave(store, normalized) ? "active" : "candidate";
		if (status === "active") counts.saved++;
		else counts.candidates++;

		if (dryRun) continue;

		const id = normalized.id ?? makeMemoryId(normalized.content);
		const existing = store.memories.find((memory) => memory.id === id || makeMemoryId(memory.content) === id);
		const nextSources = mergeSources(existing?.sources ?? [], digest);
		if (existing) {
			existing.kind = normalized.kind;
			existing.content = normalized.content;
			existing.status = status;
			existing.confidence = normalized.confidence;
			existing.sensitivity = normalized.sensitivity;
			existing.tags = normalized.tags;
			existing.rationale = normalized.rationale;
			existing.updatedAt = now;
			existing.lastSeenAt = now;
			existing.sources = nextSources;
		} else {
			const memory: DreamingMemory = {
				id,
				kind: normalized.kind,
				content: normalized.content,
				status,
				confidence: normalized.confidence,
				sensitivity: normalized.sensitivity,
				tags: normalized.tags,
				createdAt: now,
				updatedAt: now,
				lastSeenAt: now,
				sources: nextSources,
			};
			if (normalized.rationale) memory.rationale = normalized.rationale;
			store.memories.push(memory);
		}
	}

	return counts;
}

function shouldAutoSave(store: DreamingStore, candidate: RequiredMemoryCandidate): boolean {
	if (candidate.malformed) return false;
	if (candidate.sensitivity !== "normal") return false;
	if (candidate.confidence < store.settings.autoSaveMinConfidence) return false;
	return !containsSecret(candidate.content);
}

interface RequiredMemoryCandidate {
	id?: string;
	kind: MemoryKind;
	content: string;
	confidence: number;
	sensitivity: MemorySensitivity;
	tags: string[];
	rationale?: string;
	malformed: boolean;
}

function normalizeCandidate(candidate: DreamingSynthesisCandidate, forceMalformed = false): RequiredMemoryCandidate | undefined {
	const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
	if (!content) return undefined;
	const kind = parseKind(candidate.kind);
	const candidateSensitivity = parseSensitivity(candidate.sensitivity);
	const confidence = parseConfidence(candidate.confidence);
	const tagsMalformed = candidate.tags !== undefined && (!Array.isArray(candidate.tags) || candidate.tags.some((tag) => typeof tag !== "string"));
	const malformed =
		forceMalformed ||
		(candidate.kind !== undefined && !kind) ||
		(candidate.sensitivity !== undefined && !candidateSensitivity) ||
		(candidate.confidence !== undefined && confidence === undefined) ||
		tagsMalformed;
	const sensitivity = containsSecret(content) ? "forbidden" : candidateSensitivity ?? "normal";
	return {
		id: typeof candidate.id === "string" ? candidate.id.trim() || undefined : undefined,
		kind: kind ?? "fact",
		content,
		confidence: confidence ?? 0.5,
		sensitivity,
		tags: Array.isArray(candidate.tags)
			? candidate.tags
				.filter((tag): tag is string => typeof tag === "string")
				.map((tag) => tag.trim())
				.filter(Boolean)
				.slice(0, 8)
			: [],
		rationale: typeof candidate.rationale === "string" ? candidate.rationale.trim() || undefined : undefined,
		malformed,
	};
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

function parseSynthesisResult(text: string): DreamingSynthesisResult {
	const json = extractJsonObject(text);
	const parsed = JSON.parse(json) as unknown;
	if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { memories?: unknown }).memories)) {
		return { memories: [] };
	}
	return {
		memories: (parsed as { memories: unknown[] }).memories
			.filter(isPlainObject)
			.map((memory) => memory as unknown as DreamingSynthesisCandidate),
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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

function mergeSources(existing: SourceDigest[], digest: SourceDigest): SourceDigest[] {
	const withoutCurrent = existing.filter((source) => source.signature !== digest.signature);
	return [digest, ...withoutCurrent].slice(0, 8);
}

function containsSecret(text: string): boolean {
	return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function finishRun(
	cwd: string,
	store: DreamingStore,
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
	const next = rememberLastRun(store, lastRun);
	if (!skipSave && !saveDreamingStore(cwd, next)) {
		return {
			...result,
			status: "failed",
			message: `failed to save memory store after ${result.status}: ${result.message}`,
		};
	}
	return result;
}
