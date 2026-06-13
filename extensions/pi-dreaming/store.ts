import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
	DEFAULT_DREAMING_INTERVAL_MS,
	DREAMING_STATE_VERSION,
	type DreamingLastRun,
	type DreamingMemory,
	type DreamingMemoryStore,
	type DreamingSettings,
	type DreamingState,
	type MemoryKind,
	type MemorySensitivity,
	type SourceDigest,
} from "./types.js";

export const DREAMING_ROOT_RELATIVE_PATH = ".pi/dreaming";
export const DREAMING_STATE_RELATIVE_PATH = ".pi/dreaming/_state.json";
export const DREAMING_INDEX_RELATIVE_PATH = ".pi/dreaming/_index.md";
export const DREAMING_MEMORIES_RELATIVE_DIR = ".pi/dreaming/memories";

export const DEFAULT_DREAMING_SETTINGS: DreamingSettings = {
	enabled: true,
	intervalMs: DEFAULT_DREAMING_INTERVAL_MS,
	minCharsForDream: 1_000,
	maxDigestChars: 24_000,
	maxActiveMemoriesInPrompt: 30,
	autoSaveMinConfidence: 0.72,
};

const VALID_KINDS = new Set<MemoryKind>(["preference", "fact", "workflow", "correction", "project"]);
const VALID_SENSITIVITIES = new Set<MemorySensitivity>(["normal", "sensitive", "forbidden"]);

export function getDreamingRootPath(cwd: string): string {
	return join(cwd, ...DREAMING_ROOT_RELATIVE_PATH.split("/"));
}

export function getDreamingStatePath(cwd: string): string {
	return join(cwd, ...DREAMING_STATE_RELATIVE_PATH.split("/"));
}

export function getDreamingIndexPath(cwd: string): string {
	return join(cwd, ...DREAMING_INDEX_RELATIVE_PATH.split("/"));
}

export function getDreamingMemoriesDir(cwd: string): string {
	return join(cwd, ...DREAMING_MEMORIES_RELATIVE_DIR.split("/"));
}

export function getDreamingMemoryPath(cwd: string, slug: string): string {
	return join(getDreamingMemoriesDir(cwd), `${normalizeSlug(slug)}.md`);
}

export function createDefaultState(): DreamingState {
	return {
		version: DREAMING_STATE_VERSION,
		settings: { ...DEFAULT_DREAMING_SETTINGS },
	};
}

export function createDefaultMemoryStore(): DreamingMemoryStore {
	return {
		state: createDefaultState(),
		memories: [],
	};
}

export function loadDreamingMemoryStore(cwd: string): DreamingMemoryStore {
	return {
		state: loadDreamingState(cwd),
		memories: loadMarkdownMemories(cwd),
	};
}

export function loadDreamingState(cwd: string): DreamingState {
	const path = getDreamingStatePath(cwd);
	if (!existsSync(path)) return createDefaultState();

	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return normalizeState(parsed);
	} catch (error) {
		console.warn(`[pi-dreaming] invalid dreaming state at ${path}; using defaults — ${String(error)}`);
		return createDefaultState();
	}
}

export function saveDreamingMemoryState(cwd: string, state: DreamingState): boolean {
	const path = getDreamingStatePath(cwd);
	const content = `${JSON.stringify(normalizeState(state), null, 2)}\n`;
	return writeFileAtomically(path, content);
}

export function saveDreamingMemory(cwd: string, memory: DreamingMemory): boolean {
	const normalized = normalizeMemory(memory);
	if (!normalized) return false;
	return writeFileAtomically(getDreamingMemoryPath(cwd, normalized.slug), serializeMarkdownMemory(normalized));
}

export function saveDreamingMemoryStore(cwd: string, store: DreamingMemoryStore): boolean {
	const normalized = normalizeMemoryStore(store);
	if (!saveDreamingMemoryState(cwd, normalized.state)) return false;
	for (const memory of normalized.memories) {
		if (!saveDreamingMemory(cwd, memory)) return false;
	}
	return writeDreamingIndex(cwd, normalized.memories);
}

export function deleteDreamingMemory(cwd: string, slug: string): boolean {
	const path = getDreamingMemoryPath(cwd, slug);
	if (!existsSync(path)) return true;
	try {
		unlinkSync(path);
		return true;
	} catch (error) {
		console.warn(`[pi-dreaming] failed to delete memory ${slug} at ${path} — ${String(error)}`);
		return false;
	}
}

export function writeDreamingIndex(cwd: string, memories: DreamingMemory[]): boolean {
	const content = buildDreamingIndex(memories);
	return writeFileAtomically(getDreamingIndexPath(cwd), content);
}

export function rememberLastRun(state: DreamingState, lastRun: DreamingLastRun): DreamingState {
	return normalizeState({ ...state, lastRun });
}

export function listActiveMemories(store: DreamingMemoryStore): DreamingMemory[] {
	return store.memories
		.filter((memory) => memory.sensitivity === "normal")
		.sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt));
}

export function findDreamingMemory(store: DreamingMemoryStore, slug: string): DreamingMemory | undefined {
	const normalized = normalizeSlug(slug);
	return store.memories.find((memory) => memory.slug === normalized);
}

export function makeMemorySlug(input: string): string {
	const normalized = normalizeSlug(input);
	if (normalized) return normalized.slice(0, 80);
	const hash = createHash("sha256").update(input.trim()).digest("hex").slice(0, 12);
	return `memory-${hash}`;
}

export function normalizeSlug(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function normalizeMemoryStore(value: unknown): DreamingMemoryStore {
	if (!isPlainObject(value)) return createDefaultMemoryStore();
	return {
		state: normalizeState(value.state),
		memories: dedupeMemories(Array.isArray(value.memories) ? value.memories.map(normalizeMemory).filter(isMemory) : []),
	};
}

export function normalizeMemory(value: unknown): DreamingMemory | undefined {
	if (!isPlainObject(value)) return undefined;

	const body = stringValue(value.body).trim();
	if (!body) return undefined;

	const now = new Date().toISOString();
	const slug = makeMemorySlug(stringValue(value.slug) || stringValue(value.name) || body);
	const name = stringValue(value.name).trim() || titleFromSlug(slug);
	const description = stringValue(value.description).trim() || firstParagraph(body).slice(0, 180) || name;
	const kind = VALID_KINDS.has(value.kind as MemoryKind) ? (value.kind as MemoryKind) : "fact";
	const sensitivity = VALID_SENSITIVITIES.has(value.sensitivity as MemorySensitivity)
		? (value.sensitivity as MemorySensitivity)
		: "normal";
	const lastUsedAt = optionalString(value.lastUsedAt);

	const memory: DreamingMemory = {
		slug,
		name,
		description,
		kind,
		body,
		confidence: clampNumber(value.confidence, 0.5, 0, 1),
		sensitivity,
		tags: stringArray(value.tags).slice(0, 8),
		createdAt: stringValue(value.createdAt) || now,
		updatedAt: stringValue(value.updatedAt) || now,
		lastSeenAt: stringValue(value.lastSeenAt) || now,
		sources: sourceArray(value.sources, now),
	};
	if (lastUsedAt) memory.lastUsedAt = lastUsedAt;
	return memory;
}

function loadMarkdownMemories(cwd: string): DreamingMemory[] {
	const dir = getDreamingMemoriesDir(cwd);
	if (!existsSync(dir)) return [];

	const memories: DreamingMemory[] = [];
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".md")) continue;
		const path = join(dir, entry);
		try {
			const parsed = parseMarkdownMemory(path, readFileSync(path, "utf-8"));
			if (parsed) memories.push(parsed);
		} catch (error) {
			console.warn(`[pi-dreaming] failed to read memory ${path} — ${String(error)}`);
		}
	}
	return dedupeMemories(memories);
}

function normalizeState(value: unknown): DreamingState {
	if (!isPlainObject(value)) return createDefaultState();
	const state: DreamingState = {
		version: DREAMING_STATE_VERSION,
		settings: normalizeSettings(value.settings),
	};
	const lastRun = normalizeLastRun(value.lastRun);
	if (lastRun) state.lastRun = lastRun;
	return state;
}

function normalizeSettings(value: unknown): DreamingSettings {
	const input = isPlainObject(value) ? value : {};
	return {
		enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_DREAMING_SETTINGS.enabled,
		intervalMs: positiveNumber(input.intervalMs, DEFAULT_DREAMING_SETTINGS.intervalMs),
		minCharsForDream: positiveNumber(input.minCharsForDream, DEFAULT_DREAMING_SETTINGS.minCharsForDream),
		maxDigestChars: positiveNumber(input.maxDigestChars, DEFAULT_DREAMING_SETTINGS.maxDigestChars),
		maxActiveMemoriesInPrompt: positiveNumber(input.maxActiveMemoriesInPrompt, DEFAULT_DREAMING_SETTINGS.maxActiveMemoriesInPrompt),
		autoSaveMinConfidence: clampNumber(input.autoSaveMinConfidence, DEFAULT_DREAMING_SETTINGS.autoSaveMinConfidence, 0, 1),
	};
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
	const lastRun: DreamingLastRun = { startedAt, reason, status };
	const finishedAt = optionalString(value.finishedAt);
	const signature = optionalString(value.signature);
	const message = optionalString(value.message);
	if (finishedAt) lastRun.finishedAt = finishedAt;
	if (signature) lastRun.signature = signature;
	if (message) lastRun.message = message;
	return lastRun;
}

function parseMarkdownMemory(path: string, text: string): DreamingMemory | undefined {
	const { frontmatter, body } = splitFrontmatter(text);
	const metadata = {
		...frontmatter,
		slug: stringValue(frontmatter.slug) || basename(path, ".md"),
		body,
	};
	return normalizeMemory(metadata);
}

function serializeMarkdownMemory(memory: DreamingMemory): string {
	const lines = [
		"---",
		frontmatterLine("slug", memory.slug),
		frontmatterLine("name", memory.name),
		frontmatterLine("description", memory.description),
		frontmatterLine("kind", memory.kind),
		frontmatterLine("confidence", memory.confidence),
		frontmatterLine("sensitivity", memory.sensitivity),
		frontmatterLine("tags", memory.tags),
		frontmatterLine("createdAt", memory.createdAt),
		frontmatterLine("updatedAt", memory.updatedAt),
		frontmatterLine("lastSeenAt", memory.lastSeenAt),
		...(memory.lastUsedAt ? [frontmatterLine("lastUsedAt", memory.lastUsedAt)] : []),
		frontmatterLine("sources", memory.sources),
		"---",
		"",
		memory.body.trim(),
		"",
	];
	return lines.join("\n");
}

function buildDreamingIndex(memories: DreamingMemory[]): string {
	const active = [...memories].sort((a, b) => b.confidence - a.confidence || a.slug.localeCompare(b.slug));
	const lines = [
		"# pi-dreaming memory index",
		"",
		"This file is generated from `.pi/dreaming/memories/*.md`.",
		"",
	];
	if (active.length === 0) {
		lines.push("No active memories.", "");
		return lines.join("\n");
	}
	for (const memory of active) {
		lines.push(`- [[${memory.slug}]] — ${memory.name} (${memory.kind}, ${memory.confidence.toFixed(2)}) — ${memory.description}`);
	}
	lines.push("");
	return lines.join("\n");
}

function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
	if (!text.startsWith("---\n")) return { frontmatter: {}, body: text.trim() };
	const end = text.indexOf("\n---", 4);
	if (end === -1) return { frontmatter: {}, body: text.trim() };
	const raw = text.slice(4, end).trim();
	const body = text.slice(end + "\n---".length).trim();
	const frontmatter: Record<string, unknown> = {};
	for (const line of raw.split("\n")) {
		const match = /^(\w+):\s*(.*)$/.exec(line.trim());
		if (!match) continue;
		const [, key, rawValue] = match;
		if (!key || rawValue === undefined) continue;
		frontmatter[key] = parseFrontmatterValue(rawValue);
	}
	return { frontmatter, body };
}

function parseFrontmatterValue(value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
	if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith('"')) {
		try {
			return JSON.parse(trimmed) as unknown;
		} catch {
			return trimmed;
		}
	}
	return trimmed;
}

function frontmatterLine(key: string, value: unknown): string {
	return `${key}: ${typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value)}`;
}

function writeFileAtomically(path: string, content: string): boolean {
	const dir = dirname(path);
	const tmpPath = join(dir, `${basename(path)}.${process.pid}.tmp`);
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
		console.warn(`[pi-dreaming] failed to save ${path} — ${String(error)}`);
		return false;
	}
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort; unsupported filesystems should not break the extension.
	}
	return true;
}

function dedupeMemories(memories: DreamingMemory[]): DreamingMemory[] {
	const bySlug = new Map<string, DreamingMemory>();
	for (const memory of memories) {
		const existing = bySlug.get(memory.slug);
		if (!existing || existing.updatedAt < memory.updatedAt) bySlug.set(memory.slug, memory);
	}
	return [...bySlug.values()];
}

function sourceArray(value: unknown, now: string): SourceDigest[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isPlainObject).map((source) => ({
		sessionKey: stringValue(source.sessionKey) || "unknown",
		signature: stringValue(source.signature) || "unknown",
		messageCount: positiveNumber(source.messageCount, 0),
		excerpt: stringValue(source.excerpt).replace(/\s+/g, " ").slice(0, 500),
		capturedAt: stringValue(source.capturedAt) || now,
	})).slice(0, 8);
}

function firstParagraph(text: string): string {
	return text.split(/\n\s*\n/).map((part) => part.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
}

function titleFromSlug(slug: string): string {
	return slug.split("-").filter(Boolean).map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" ") || "Memory";
}

function isMemory(value: DreamingMemory | undefined): value is DreamingMemory {
	return value !== undefined;
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
	return [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))];
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}
