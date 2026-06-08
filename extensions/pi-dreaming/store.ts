import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
	DEFAULT_DREAMING_INTERVAL_MS,
	DREAMING_STORE_VERSION,
	type DreamingLastRun,
	type DreamingMemory,
	type DreamingSettings,
	type DreamingStore,
	type MemoryKind,
	type MemorySensitivity,
	type MemoryStatus,
} from "./types.js";

export const DREAMING_STORE_RELATIVE_PATH = ".pi/dreaming/memories.json";

export const DEFAULT_DREAMING_SETTINGS: DreamingSettings = {
	enabled: true,
	intervalMs: DEFAULT_DREAMING_INTERVAL_MS,
	minCharsForDream: 1_000,
	maxDigestChars: 24_000,
	maxActiveMemoriesInPrompt: 30,
	autoSaveMinConfidence: 0.72,
	candidateMaxAgeDays: 30,
};

const VALID_KINDS = new Set<MemoryKind>(["preference", "fact", "workflow", "correction", "project"]);
const VALID_STATUSES = new Set<MemoryStatus>(["active", "candidate", "archived"]);
const VALID_SENSITIVITIES = new Set<MemorySensitivity>(["normal", "sensitive", "forbidden"]);

export function getDreamingStorePath(cwd: string): string {
	return join(cwd, ...DREAMING_STORE_RELATIVE_PATH.split("/"));
}

export function createDefaultStore(): DreamingStore {
	return {
		version: DREAMING_STORE_VERSION,
		settings: { ...DEFAULT_DREAMING_SETTINGS },
		memories: [],
	};
}

export function loadDreamingStore(cwd: string): DreamingStore {
	const path = getDreamingStorePath(cwd);
	if (!existsSync(path)) return createDefaultStore();

	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return normalizeStore(parsed);
	} catch (error) {
		console.warn(`[pi-dreaming] invalid memory store at ${path}; using defaults — ${String(error)}`);
		return createDefaultStore();
	}
}

export function saveDreamingStore(cwd: string, store: DreamingStore): boolean {
	const path = getDreamingStorePath(cwd);
	const dir = dirname(path);
	const tmpPath = join(dir, `${basename(path)}.${process.pid}.tmp`);
	const content = `${JSON.stringify(normalizeStore(store), null, 2)}\n`;

	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(tmpPath, content, "utf-8");
		renameSync(tmpPath, path);
	} catch (error) {
		try {
			unlinkSync(tmpPath);
		} catch {
			// Best-effort cleanup only.
		}
		console.warn(`[pi-dreaming] failed to save memory store at ${path} — ${String(error)}`);
		return false;
	}

	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort; unsupported filesystems should not break the extension.
	}

	return true;
}

export function makeMemoryId(content: string): string {
	const hash = createHash("sha256").update(normalizeContentKey(content)).digest("hex").slice(0, 16);
	return `mem_${hash}`;
}

export function normalizeContentKey(content: string): string {
	return content.trim().replace(/\s+/g, " ").toLowerCase();
}

export function getActiveMemories(store: DreamingStore): DreamingMemory[] {
	return store.memories
		.filter((memory) => memory.status === "active")
		.sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt));
}

export function getCandidateMemories(store: DreamingStore): DreamingMemory[] {
	return store.memories
		.filter((memory) => memory.status === "candidate")
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function rememberLastRun(store: DreamingStore, lastRun: DreamingLastRun): DreamingStore {
	return normalizeStore({ ...store, lastRun });
}

function normalizeStore(value: unknown): DreamingStore {
	if (!isPlainObject(value)) return createDefaultStore();

	const settings = normalizeSettings(value.settings);
	const memories = Array.isArray(value.memories)
		? value.memories.map(normalizeMemory).filter((memory): memory is DreamingMemory => memory !== undefined)
		: [];
	const lastRun = normalizeLastRun(value.lastRun);
	const store: DreamingStore = {
		version: DREAMING_STORE_VERSION,
		settings,
		memories: dedupeMemories(memories),
	};
	if (lastRun) store.lastRun = lastRun;
	return store;
}

function normalizeSettings(value: unknown): DreamingSettings {
	const input = isPlainObject(value) ? value : {};
	return {
		enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_DREAMING_SETTINGS.enabled,
		intervalMs: positiveNumber(input.intervalMs, DEFAULT_DREAMING_SETTINGS.intervalMs),
		minCharsForDream: positiveNumber(input.minCharsForDream, DEFAULT_DREAMING_SETTINGS.minCharsForDream),
		maxDigestChars: positiveNumber(input.maxDigestChars, DEFAULT_DREAMING_SETTINGS.maxDigestChars),
		maxActiveMemoriesInPrompt: positiveNumber(
			input.maxActiveMemoriesInPrompt,
			DEFAULT_DREAMING_SETTINGS.maxActiveMemoriesInPrompt,
		),
		autoSaveMinConfidence: clampNumber(
			input.autoSaveMinConfidence,
			DEFAULT_DREAMING_SETTINGS.autoSaveMinConfidence,
			0,
			1,
		),
		candidateMaxAgeDays: positiveNumber(input.candidateMaxAgeDays, DEFAULT_DREAMING_SETTINGS.candidateMaxAgeDays),
	};
}

function normalizeMemory(value: unknown): DreamingMemory | undefined {
	if (!isPlainObject(value)) return undefined;

	const content = stringValue(value.content).trim();
	if (!content) return undefined;

	const now = new Date().toISOString();
	const id = stringValue(value.id) || makeMemoryId(content);
	const kind = VALID_KINDS.has(value.kind as MemoryKind) ? (value.kind as MemoryKind) : "fact";
	const status = VALID_STATUSES.has(value.status as MemoryStatus) ? (value.status as MemoryStatus) : "candidate";
	const sensitivity = VALID_SENSITIVITIES.has(value.sensitivity as MemorySensitivity)
		? (value.sensitivity as MemorySensitivity)
		: "normal";
	const lastUsedAt = optionalString(value.lastUsedAt);
	const rationale = optionalString(value.rationale);
	const memory: DreamingMemory = {
		id,
		kind,
		content,
		status,
		confidence: clampNumber(value.confidence, 0.5, 0, 1),
		sensitivity,
		tags: stringArray(value.tags),
		createdAt: stringValue(value.createdAt) || now,
		updatedAt: stringValue(value.updatedAt) || now,
		lastSeenAt: stringValue(value.lastSeenAt) || now,
		sources: Array.isArray(value.sources)
			? value.sources.filter(isPlainObject).map((source) => ({
				sessionKey: stringValue(source.sessionKey) || "unknown",
				signature: stringValue(source.signature) || "unknown",
				messageCount: positiveNumber(source.messageCount, 0),
				excerpt: stringValue(source.excerpt).slice(0, 500),
				capturedAt: stringValue(source.capturedAt) || now,
			}))
			: [],
	};
	if (lastUsedAt) memory.lastUsedAt = lastUsedAt;
	if (rationale) memory.rationale = rationale;
	return memory;
}

function normalizeLastRun(value: unknown): DreamingLastRun | undefined {
	if (!isPlainObject(value)) return undefined;
	const startedAt = stringValue(value.startedAt);
	if (!startedAt) return undefined;
	const reason = ["timer", "agent_end", "manual", "startup"].includes(stringValue(value.reason))
		? (stringValue(value.reason) as DreamingLastRun["reason"])
		: "manual";
	const status = ["completed", "skipped", "failed"].includes(stringValue(value.status))
		? (stringValue(value.status) as DreamingLastRun["status"])
		: "skipped";
	const finishedAt = optionalString(value.finishedAt);
	const signature = optionalString(value.signature);
	const message = optionalString(value.message);
	const lastRun: DreamingLastRun = { startedAt, reason, status };
	if (finishedAt) lastRun.finishedAt = finishedAt;
	if (signature) lastRun.signature = signature;
	if (message) lastRun.message = message;
	return lastRun;
}

function dedupeMemories(memories: DreamingMemory[]): DreamingMemory[] {
	const byId = new Map<string, DreamingMemory>();
	for (const memory of memories) {
		const existing = byId.get(memory.id);
		if (!existing || existing.updatedAt < memory.updatedAt) {
			byId.set(memory.id, memory);
		}
	}
	return [...byId.values()];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
	const text = stringValue(value).trim();
	return text ? text : undefined;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	];
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}
