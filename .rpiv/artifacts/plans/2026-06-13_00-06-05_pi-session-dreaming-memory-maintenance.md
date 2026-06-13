---
date: 2026-06-13T00:06:05+0900
author: Yuku Kotani
commit: b746064
branch: main
repository: pi-memory-dreaming
topic: pi-session-dreaming-memory-maintenance
tags: [plan, blueprint, pi-dreaming, memory, markdown]
status: ready
parent: .rpiv/artifacts/research/2026-06-12_23-49-17_pi-session-dreaming-memory-maintenance.md
phase_count: 4
phases:
  - { n: 1, title: Markdown store foundation }
  - { n: 2, title: Maintenance synthesis }
  - { n: 3, title: Runtime UX wiring }
  - { n: 4, title: Documentation }
unresolved_phase_count: 0
last_updated: 2026-06-13T00:06:05+0900
last_updated_by: Yuku Kotani
---

# Pi Session Dreaming Memory Maintenance Implementation Plan

## Overview
Replace the current JSON-backed pi-dreaming memory store with Markdown-backed memory maintenance while preserving the existing pi extension entrypoint, lifecycle hooks, and `/dreaming` command seam. The chosen architecture uses a new Markdown memory API with `.pi/dreaming/_state.json` for settings/lastRun, `.pi/dreaming/_index.md` for human-readable links, and flat `.pi/dreaming/memories/<slug>.md` files for durable active memories.

The runtime keeps the existing one-call model orchestration and finishRun shape, but changes the model contract from JSON memory candidates to structured maintenance operations that are applied to Markdown files only after normal-only safety filtering.

## Requirements
- Preserve the pi package extension registration and `/dreaming` lifecycle seam.
- Use the current pi session digest as input; do not add ant-session import or standalone CLI/API.
- Store durable memories as Markdown, not `.pi/dreaming/memories.json`.
- Include stable slugs, names/descriptions, Markdown bodies, and `[[slug]]` links with an index file.
- Automatically save only normal, high-confidence memories; drop secret/forbidden/sensitive/low-confidence items before any Markdown write.
- Remove `/dreaming approve` and `/dreaming reject` because candidate approval is no longer part of the model.
- Preserve automatic and manual run triggers, dry-run/force behavior, unchanged-session skip semantics, and next-turn recall.
- Update README storage and command documentation.

## Current State Analysis
The current implementation has a narrow public seam and a JSON-centric storage/synthesis core. The plan intentionally preserves the seam and replaces the core.

### Key Discoveries
- `package.json:24-27` registers `./extensions/pi-dreaming/index.ts` as the only pi extension entrypoint.
- `extensions/pi-dreaming/index.ts:8-10` only registers commands and lifecycle hooks, making it a safe seam to preserve.
- `extensions/pi-dreaming/index.ts:72-81` loads active memories and appends recall text before each agent turn.
- `extensions/pi-dreaming/store.ts:16` fixes the current durable store path at `.pi/dreaming/memories.json`.
- `extensions/pi-dreaming/store.ts:57-83` shows the local persistence pattern: create directory, write temp file, rename, best-effort chmod.
- `extensions/pi-dreaming/dreamer.ts:60-74` depends on persisted `lastRun.signature` for unchanged-session skipping.
- `extensions/pi-dreaming/dreamer.ts:123-141` makes a single `complete()` call using a system prompt and user prompt.
- `extensions/pi-dreaming/dreamer.ts:226-272` currently turns unsafe/low-confidence items into candidates; Markdown must instead drop them before write.
- `extensions/pi-dreaming/dreamer.ts:380-403` centralizes lastRun persistence and converts save failure into a failed run result.
- `extensions/pi-dreaming/commands.ts:24-25` and `84-101` implement approve/reject candidate UX that will be removed.
- `README.md:48-53` and `60-68` document candidates, JSON storage, and approve/reject commands that will become stale.

## Desired End State
Consumer-visible behavior:

```text
/dreaming run --force
# completed: dreaming completed (saved=2, candidates=0, archived=1)

/dreaming list
# project-style project 0.91 Project prefers Bun commands for verification.
# stable-slug workflow 0.88 Run `bun run check` before release.

/dreaming show project-style
# ---
# slug: project-style
# kind: project
# confidence: 0.91
# ...
# ---
# # Project style
# ... [[stable-slug]] ...
```

Durable files:

```text
.pi/dreaming/
  _state.json
  _index.md
  memories/
    project-style.md
    stable-slug.md
```

Recall remains automatic:

```ts
const memories = listActiveMemories(loadDreamingMemoryStore(ctx.cwd));
const recall = buildRecallSystemPrompt(memories, store.state.settings.maxActiveMemoriesInPrompt);
return { systemPrompt: `${event.systemPrompt}\n\n${recall}` };
```

## What We're NOT Doing
- Not adding a standalone CLI, HTTP API, or external session import.
- Not changing `package.json` extension registration.
- Not implementing a multi-model runtime workflow; the model call remains one `complete()` call with a structured output contract.
- Not keeping candidate approval/rejection UX.
- Not saving sensitive, forbidden, secret-containing, malformed, or low-confidence memory items as Markdown.
- Not preserving `.pi/dreaming/memories.json` compatibility; the developer explicitly allowed ignoring the current format.
- Not introducing test framework changes beyond existing `bun run check` verification.

## Decisions

### Preserve extension and lifecycle seam
The extension entrypoint remains `package.json:24-27` and `extensions/pi-dreaming/index.ts:8-10`. The developer confirmed keeping this seam, so all changes stay below command/lifecycle registration.

### Use a new Markdown store API
Ambiguity: keep legacy `loadDreamingStore`/`saveDreamingStore` API or create a Markdown-specific API. Existing callers are `extensions/pi-dreaming/index.ts:73-80` and `extensions/pi-dreaming/dreamer.ts:42-61`.

Explored:
- Keep legacy API: smaller diff, but forces Markdown behavior into JSON-shaped names and candidate/status assumptions.
- New API: more call-site edits, but makes Markdown/state/index semantics explicit.

Decision: use a new API such as `loadDreamingMemoryStore`, `saveDreamingMemoryStore`, `listActiveMemories`, `writeDreamingMemoryStore`, and `deleteDreamingMemory`.

### Store state separately from Markdown memories
Ambiguity: settings/lastRun could live in `_index.md` frontmatter, a separate state file, or code defaults only. `types.ts:57-62` currently stores settings/lastRun together, and `dreamer.ts:60-74` needs `lastRun.signature`.

Decision: use `.pi/dreaming/_state.json` for settings and lastRun, while memory documents remain Markdown.

### Use flat Markdown memory files plus `_index.md`
Ambiguity: the developer wanted Claude Dreaming as inspiration, but public docs only clearly document `CLAUDE.md`, not a Dreaming-specific layout. The plan chooses a simple flat layout that satisfies stable slug and `[[slug]]` links without adding folder move complexity.

Decision: active memory files live under `.pi/dreaming/memories/<slug>.md`; `.pi/dreaming/_index.md` is regenerated from active memory metadata.

### Keep one model call but change the output contract
Ambiguity: implement a multi-step maintenance workflow or keep the existing one-call orchestration. `dreamer.ts:123-141` and `380-403` already provide reliable auth/error/finish handling.

Decision: keep one `complete()` call and parse structured maintenance operations. This preserves runtime simplicity while changing the semantic contract to Markdown maintenance.

### Drop unsafe memories before write
The current code can persist unsafe or low-confidence candidates at `dreamer.ts:226-261` even though `shouldAutoSave` rejects them at `dreamer.ts:268-272`. The developer decided Markdown must store only normal memories; secret/forbidden/sensitive/low-confidence entries are discarded.

### Delete stale/contradicted files
The developer chose deletion rather than archive flags or archive folders. Synthesis delete operations remove the Markdown file and regenerate `_index.md`.

### Remove approve/reject commands
The developer decided candidate approval is fully removed. `commands.ts:24-25`, `84-101`, `139-140`, and README command docs are deleted/updated.

## Phase 1: Markdown store foundation

### Overview
Build the data model and persistence layer for Markdown memories plus separate state; foundation phase, no dependencies.

### Changes Required:

#### 1. extensions/pi-dreaming/types.ts:1-95
**File**: extensions/pi-dreaming/types.ts
**Changes**: MODIFY — replace JSON-memory/candidate-oriented types with Markdown memory, state, and maintenance operation types.

```ts
export const DREAMING_STATE_VERSION = 2;
export const DEFAULT_DREAMING_INTERVAL_MS = 5 * 60 * 1000;

export type MemoryKind = "preference" | "fact" | "workflow" | "correction" | "project";
export type MemorySensitivity = "normal" | "sensitive" | "forbidden";
export type DreamingRunReason = "timer" | "agent_end" | "manual" | "startup";
export type DreamingMaintenanceAction = "upsert" | "delete" | "ignore";

export interface SourceDigest {
	/** Session file path when available, otherwise a memory:<session-id> fallback. */
	sessionKey: string;
	/** Stable signature for the branch content the dreamer saw. */
	signature: string;
	/** Number of text-bearing user/assistant messages included in the digest. */
	messageCount: number;
	/** Short, human-readable excerpt used for provenance/debugging. */
	excerpt: string;
	/** ISO timestamp for when this digest was produced. */
	capturedAt: string;
}

export interface DreamingMemory {
	/** Stable filename/wiki-link identity, without `.md`. */
	slug: string;
	/** Human-readable title shown by `/dreaming list` and `_index.md`. */
	name: string;
	/** One-line summary for listings and prompt context. */
	description: string;
	kind: MemoryKind;
	body: string;
	confidence: number;
	sensitivity: MemorySensitivity;
	tags: string[];
	createdAt: string;
	updatedAt: string;
	lastSeenAt: string;
	lastUsedAt?: string;
	sources: SourceDigest[];
}

export interface DreamingSettings {
	enabled: boolean;
	intervalMs: number;
	minCharsForDream: number;
	maxDigestChars: number;
	maxActiveMemoriesInPrompt: number;
	autoSaveMinConfidence: number;
}

export interface DreamingLastRun {
	startedAt: string;
	finishedAt?: string;
	reason: DreamingRunReason;
	signature?: string;
	status: "completed" | "skipped" | "failed";
	message?: string;
}

export interface DreamingState {
	version: typeof DREAMING_STATE_VERSION;
	settings: DreamingSettings;
	lastRun?: DreamingLastRun;
}

export interface DreamingMemoryStore {
	state: DreamingState;
	memories: DreamingMemory[];
}

export interface DreamingMaintenanceOperation {
	action: DreamingMaintenanceAction;
	slug?: string;
	kind?: MemoryKind;
	name?: string;
	description?: string;
	body?: string;
	confidence?: number;
	sensitivity?: MemorySensitivity;
	tags?: string[];
	rationale?: string;
	deleteReason?: string;
}

export interface DreamingMaintenanceResult {
	memories: DreamingMaintenanceOperation[];
}

export interface DreamingRunOptions {
	reason: DreamingRunReason;
	force?: boolean;
	dryRun?: boolean;
}

export interface DreamingRunResult {
	status: "completed" | "skipped" | "failed";
	reason: DreamingRunReason;
	signature?: string;
	saved: number;
	deleted: number;
	dropped: number;
	message: string;
}
```

#### 2. extensions/pi-dreaming/store.ts:1-253
**File**: extensions/pi-dreaming/store.ts
**Changes**: MODIFY — replace JSON store implementation with Markdown/state/index persistence helpers.

```ts
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
```

### Success Criteria:

#### Automated Verification:
- [x] Phase 1 code defines `DreamingMemory`, `DreamingState`, `DreamingMemoryStore`, and `DreamingMaintenanceOperation` in `extensions/pi-dreaming/types.ts`.
- [x] Phase 1 code defines Markdown/state paths and APIs in `extensions/pi-dreaming/store.ts`: `loadDreamingMemoryStore`, `saveDreamingMemoryState`, `saveDreamingMemory`, `deleteDreamingMemory`, `writeDreamingIndex`, and `listActiveMemories`.

#### Manual Verification:
- [ ] Confirm store paths match the approved layout: `.pi/dreaming/_state.json`, `.pi/dreaming/_index.md`, and `.pi/dreaming/memories/<slug>.md`.
- [ ] Confirm stale-memory support is delete-oriented (`deleteDreamingMemory`) rather than archive-status oriented.
- [ ] Confirm frontmatter serialization includes slug, name, description, kind, confidence, sensitivity, timestamps, tags, and sources.

## Phase 2: Maintenance synthesis

### Overview
Change prompt/model parsing/apply logic to produce and apply Markdown maintenance operations; depends on Phase 1.

### Changes Required:

#### 1. extensions/pi-dreaming/prompts.ts:1-63
**File**: extensions/pi-dreaming/prompts.ts
**Changes**: MODIFY — update recall formatting and synthesis prompt for Markdown maintenance operations.

```ts
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
```

#### 2. extensions/pi-dreaming/dreamer.ts:1-404
**File**: extensions/pi-dreaming/dreamer.ts
**Changes**: MODIFY — use Markdown store APIs, parse maintenance operations, filter unsafe writes, delete stale files, and preserve finishRun behavior.

```ts
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
```

### Success Criteria:

#### Automated Verification:
- [x] Prompt output shape references `upsert`, `delete`, and `ignore` maintenance operations and no longer includes `<candidate_memories>`.
- [x] Dreamer imports and uses Phase 1 APIs (`loadDreamingMemoryStore`, `listActiveMemories`, `saveDreamingMemory`, `deleteDreamingMemory`, `writeDreamingIndex`, `saveDreamingMemoryState`).
- [x] Secret/forbidden/sensitive/low-confidence/malformed upserts increment `dropped` and do not call `saveDreamingMemory`.
- [x] Dry-run returns counts but passes `skipSave=true` to `finishRun` and does not call write/delete branches.

#### Manual Verification:
- [ ] Confirm `delete` operations remove files with `deleteDreamingMemory` and regenerate `_index.md` only after changes succeed.
- [ ] Confirm `finishRun` persists lastRun to `_state.json` outside dry-run, preserving unchanged-session skip semantics.
- [ ] Confirm result counters are now `saved`, `deleted`, and `dropped` rather than candidate/archived approval counters.

## Phase 3: Runtime UX wiring

### Overview
Wire lifecycle recall and `/dreaming` commands to the Markdown store while removing candidate approval UX; depends on Phases 1 and 2.

### Changes Required:

#### 1. extensions/pi-dreaming/index.ts:1-91
**File**: extensions/pi-dreaming/index.ts
**Changes**: MODIFY — load Markdown store settings/memories in timer and recall hooks, update lastUsedAt through the new API, and keep lifecycle seam intact.

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDreamingCommand } from "./commands.js";
import { runDreaming } from "./dreamer.js";
import { buildRecallSystemPrompt } from "./prompts.js";
import { buildSessionDigest, isStaleCtxError } from "./session.js";
import { listActiveMemories, loadDreamingMemoryStore, saveDreamingMemoryStore } from "./store.js";

export default function (pi: ExtensionAPI): void {
	registerDreamingCommand(pi);
	registerDreamingLifecycle(pi);
}

function registerDreamingLifecycle(pi: ExtensionAPI): void {
	let ctxRef: ExtensionContext | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;
	let running = false;
	let generation = 0;
	let lastObservedSignature: string | undefined;

	function cleanup(): void {
		generation++;
		if (interval) {
			clearInterval(interval);
			interval = undefined;
		}
		ctxRef = undefined;
		running = false;
		lastObservedSignature = undefined;
	}

	function activateSession(ctx: ExtensionContext): void {
		cleanup();
		ctxRef = ctx;
		startTimer(ctx);
	}

	function startTimer(ctx: ExtensionContext): void {
		const store = loadDreamingMemoryStore(ctx.cwd);
		interval = setInterval(() => {
			const currentCtx = ctxRef;
			if (!currentCtx) return;
			void attemptDream(currentCtx, "timer");
		}, store.state.settings.intervalMs);
		interval.unref?.();
	}

	async function attemptDream(ctx: ExtensionContext, reason: "timer" | "agent_end"): Promise<void> {
		if (running) return;
		const currentGeneration = generation;
		try {
			const store = loadDreamingMemoryStore(ctx.cwd);
			const digest = buildSessionDigest(ctx, store.state.settings.maxDigestChars);
			if (reason === "timer" && lastObservedSignature === digest.signature) return;
			running = true;
			const result = await runDreaming(ctx, { reason });
			if (currentGeneration !== generation || !ctxRef) return;
			if (reason === "timer" && result.status !== "failed") lastObservedSignature = digest.signature;
			if (ctx.hasUI && result.status === "completed" && (result.saved > 0 || result.deleted > 0 || result.dropped > 0)) {
				ctx.ui.notify(`pi-dreaming: ${result.message} saved=${result.saved} deleted=${result.deleted} dropped=${result.dropped}`, "info");
			}
		} catch (error) {
			if (!isStaleCtxError(error)) console.warn(`[pi-dreaming] ${String(error)}`);
		} finally {
			running = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		activateSession(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const store = loadDreamingMemoryStore(ctx.cwd);
		if (!store.state.settings.enabled) return;
		const active = listActiveMemories(store);
		const recall = buildRecallSystemPrompt(active, store.state.settings.maxActiveMemoriesInPrompt);
		if (!recall) return;
		const now = new Date().toISOString();
		for (const memory of active.slice(0, store.state.settings.maxActiveMemoriesInPrompt)) memory.lastUsedAt = now;
		saveDreamingMemoryStore(ctx.cwd, store);
		return { systemPrompt: `${event.systemPrompt}\n\n${recall}` };
	});

	pi.on("agent_end", async (_event, ctx) => {
		void attemptDream(ctx, "agent_end");
	});

	pi.on("session_shutdown", async () => {
		cleanup();
	});
}
```

#### 2. extensions/pi-dreaming/commands.ts:1-144
**File**: extensions/pi-dreaming/commands.ts
**Changes**: MODIFY — update status/list/show/forget output for Markdown memories and remove approve/reject handling.

```ts
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runDreaming } from "./dreamer.js";
import {
	deleteDreamingMemory,
	findDreamingMemory,
	listActiveMemories,
	loadDreamingMemoryStore,
	saveDreamingMemoryState,
	writeDreamingIndex,
} from "./store.js";
import type { DreamingMemory, DreamingRunResult } from "./types.js";

const COMMAND_NAME = "dreaming";

export function registerDreamingCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Manage pi-dreaming Markdown memories",
		handler: async (args: string, ctx: ExtensionCommandContext) => handleDreamingCommand(args, ctx),
	});
}

async function handleDreamingCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const [subcommand = "status", ...rest] = splitArgs(args);
	const command = subcommand.toLowerCase();

	if (command === "help") return notify(ctx, usage(), "info");
	if (command === "status") return notify(ctx, formatStatus(ctx.cwd), "info");
	if (command === "list") return notify(ctx, formatList(ctx.cwd, rest[0] ?? "active"), "info");
	if (command === "show") return notify(ctx, formatShow(ctx.cwd, rest[0]), "info");
	if (command === "forget") return forgetMemory(ctx, rest[0]);
	if (command === "enable") return setEnabled(ctx, true);
	if (command === "disable") return setEnabled(ctx, false);
	if (command === "run") return runManualDreaming(ctx, rest);

	notify(ctx, `Unknown /dreaming command: ${command}\n\n${usage()}`, "warning");
}

async function runManualDreaming(ctx: ExtensionCommandContext, args: string[]): Promise<void> {
	await ctx.waitForIdle();
	const dryRun = args.includes("--dry-run");
	const force = args.includes("--force");
	notify(ctx, dryRun ? "Running pi-dreaming dry-run..." : "Running pi-dreaming...", "info");
	const result = await runDreaming(ctx, { reason: "manual", dryRun, force: force || dryRun });
	notify(ctx, formatRunResult(result), result.status === "failed" ? "error" : "info");
}

function formatStatus(cwd: string): string {
	const store = loadDreamingMemoryStore(cwd);
	const active = listActiveMemories(store).length;
	const total = store.memories.length;
	return [
		`pi-dreaming: ${store.state.settings.enabled ? "enabled" : "disabled"}`,
		`saved=${active}, markdownFiles=${total}`,
		`interval=${Math.round(store.state.settings.intervalMs / 1000)}s, autoSaveMinConfidence=${store.state.settings.autoSaveMinConfidence}`,
		store.state.lastRun
			? `lastRun=${store.state.lastRun.status} ${store.state.lastRun.finishedAt ?? store.state.lastRun.startedAt} ${store.state.lastRun.message ?? ""}`
			: "lastRun=(never)",
	].join("\n");
}

function formatList(cwd: string, scope: string): string {
	const store = loadDreamingMemoryStore(cwd);
	const memories = scope === "all" ? store.memories : listActiveMemories(store);
	if (memories.length === 0) return `No ${scope} memories.`;
	return memories.map((memory) => `${memory.slug} ${memory.kind} ${memory.confidence.toFixed(2)} ${memory.name} — ${memory.description}`).join("\n");
}

function formatShow(cwd: string, slug: string | undefined): string {
	if (!slug) return "Usage: /dreaming show <slug>";
	const memory = findDreamingMemory(loadDreamingMemoryStore(cwd), slug);
	if (!memory) return `Memory not found: ${slug}`;
	return formatMemoryMarkdown(memory);
}

function forgetMemory(ctx: ExtensionCommandContext, slug: string | undefined): void {
	if (!slug) return notify(ctx, "Usage: /dreaming forget <slug>", "warning");
	const store = loadDreamingMemoryStore(ctx.cwd);
	const memory = findDreamingMemory(store, slug);
	if (!memory) return notify(ctx, `Memory not found: ${slug}`, "warning");
	if (!deleteDreamingMemory(ctx.cwd, memory.slug)) return notify(ctx, `Failed to delete memory ${memory.slug}`, "error");
	store.memories = store.memories.filter((entry) => entry.slug !== memory.slug);
	const ok = writeDreamingIndex(ctx.cwd, store.memories);
	notify(ctx, ok ? `Deleted memory ${memory.slug}` : `Deleted memory ${memory.slug}, but failed to update index`, ok ? "info" : "warning");
}

function setEnabled(ctx: ExtensionCommandContext, enabled: boolean): void {
	const store = loadDreamingMemoryStore(ctx.cwd);
	store.state.settings.enabled = enabled;
	notify(
		ctx,
		saveDreamingMemoryState(ctx.cwd, store.state) ? `pi-dreaming ${enabled ? "enabled" : "disabled"}` : "Failed to save pi-dreaming settings",
		"info",
	);
}

function formatMemoryMarkdown(memory: DreamingMemory): string {
	return [
		"---",
		`slug: ${JSON.stringify(memory.slug)}`,
		`name: ${JSON.stringify(memory.name)}`,
		`description: ${JSON.stringify(memory.description)}`,
		`kind: ${JSON.stringify(memory.kind)}`,
		`confidence: ${memory.confidence}`,
		`sensitivity: ${JSON.stringify(memory.sensitivity)}`,
		`tags: ${JSON.stringify(memory.tags)}`,
		`createdAt: ${JSON.stringify(memory.createdAt)}`,
		`updatedAt: ${JSON.stringify(memory.updatedAt)}`,
		`lastSeenAt: ${JSON.stringify(memory.lastSeenAt)}`,
		...(memory.lastUsedAt ? [`lastUsedAt: ${JSON.stringify(memory.lastUsedAt)}`] : []),
		`sourceCount: ${memory.sources.length}`,
		"---",
		"",
		memory.body,
	].join("\n");
}

function formatRunResult(result: DreamingRunResult): string {
	return `${result.status}: ${result.message} (saved=${result.saved}, deleted=${result.deleted}, dropped=${result.dropped})`;
}

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.log(message);
}

function usage(): string {
	return [
		"Usage: /dreaming <command>",
		"Commands:",
		"  status                 Show memory status",
		"  list [active|all]",
		"  show <slug>",
		"  run [--dry-run] [--force]",
		"  forget <slug>",
		"  enable | disable",
	].join("\n");
}
```

### Success Criteria:

#### Automated Verification:
- [x] `extensions/pi-dreaming/index.ts` imports `loadDreamingMemoryStore`, `listActiveMemories`, and `saveDreamingMemoryStore` instead of legacy JSON store helpers.
- [x] `extensions/pi-dreaming/commands.ts` has no `approve` or `reject` dispatch, implementation, or usage strings.
- [x] Command run-result formatting uses `saved`, `deleted`, and `dropped`, with no `candidates` or `archived` references.
- [x] Final code-phase type checking passes: `bun run check`.

#### Manual Verification:
- [ ] `/dreaming status` reports enabled state, saved count, Markdown file count, interval, threshold, and lastRun.
- [ ] `/dreaming list [active|all]` lists Markdown slugs and summaries.
- [ ] `/dreaming show <slug>` renders frontmatter-like metadata plus Markdown body.
- [ ] `/dreaming forget <slug>` deletes the Markdown file and regenerates `_index.md`.
- [ ] `before_agent_start` still appends recall to the existing system prompt.

## Phase 4: Documentation

### Overview
Update public README behavior, storage, and command docs to match Markdown auto-save semantics; depends on Phases 1-3.

### Changes Required:

#### 1. README.md:1-77
**File**: README.md
**Changes**: MODIFY — document Markdown storage, normal-only automatic saves, no candidates, and current `/dreaming` commands.

~~~~md
# pi-memory-dreaming

`pi-memory-dreaming` gives pi an automatic memory system. Once installed, it
learns durable preferences, facts, corrections, workflows, and project context
from your conversations, then reuses saved Markdown memories as background
context in future turns.

You do **not** need to run `/dreaming` during normal use. The slash command is
only for checking status, manually forcing a run, and managing saved Markdown
memories.

## Install

From npm:

```bash
pi install pi-memory-dreaming
```

Or try it for one pi run without installing:

```bash
pi -e pi-memory-dreaming
```

For local development from this repository:

```bash
pi install /absolute/path/to/pi-memory-dreaming
```

Or run the local checkout once without installing:

```bash
pi -e /absolute/path/to/pi-memory-dreaming
```

## Automatic behavior

`pi-dreaming` is enabled by default. It automatically:

- recalls saved Markdown memories before each agent turn and appends them to the
  system prompt as background context;
- attempts memory maintenance after each agent turn;
- also checks on a timer, every 5 minutes by default, and skips work when the
  conversation has not changed or is still below the minimum digest size.

Only normal, high-confidence memories are saved. Secret, forbidden, sensitive,
malformed, or low-confidence observations are dropped instead of being written
to disk. Stale or contradicted memories can be deleted by the maintenance run.

Memories are stored per project under `.pi/dreaming/`:

```text
.pi/dreaming/
  _state.json            # settings and last-run metadata
  _index.md              # generated index with [[slug]] links
  memories/
    <slug>.md            # Markdown memory with frontmatter
```

Memory files and state files use file mode `0600` when supported by the
filesystem.

## Management commands

Use `/dreaming` when you want to inspect or manage the automatic memory system:

```text
/dreaming status
/dreaming list [active|all]
/dreaming show <slug>
/dreaming run [--dry-run] [--force]
/dreaming forget <slug>
/dreaming enable
/dreaming disable
```

## Development

```bash
bun install
bun run check
bun run pack:dry-run
```
~~~~

### Success Criteria:

#### Automated Verification:
- [x] README no longer documents candidates or approve/reject commands: `grep -n "approve\|reject\|candidate" README.md` returns no command/storage references.
- [x] README documents Markdown storage paths: `grep -n "_state.json\|_index.md\|memories/" README.md` returns all three paths.
- [x] Final package verification passes: `bun run check`.
- [x] Package dry-run still passes: `bun run pack:dry-run`.

#### Manual Verification:
- [ ] README automatic behavior describes memory maintenance, normal-only saving, unsafe drops, and stale-memory deletion.
- [ ] README command list matches Phase 3 usage output.
- [ ] README development section still uses Bun commands.

## Ordering Constraints
- Phase 1 must run first because all later phases consume the new types and store APIs.
- Phase 2 depends on Phase 1's store and operation types.
- Phase 3 depends on Phases 1-2 because lifecycle/commands call the new APIs and display new result counters.
- Phase 4 should run last so docs match final command/storage behavior.
- No phases are parallelizable because each phase updates shared public types and call-sites in sequence.

## Verification Notes
- Run `bun run check` after code phases and again after documentation changes because `package.json:29-31` defines TypeScript verification via Bun.
- Verify `.pi/dreaming/_state.json`, `.pi/dreaming/_index.md`, and `.pi/dreaming/memories/<slug>.md` are created by forced manual run.
- Verify dry-run reports counts but does not create/update/delete Markdown or state files except where explicitly skipped by `finishRun` semantics.
- Verify secret/forbidden/sensitive/low-confidence operations are dropped and do not appear on disk.
- Verify `_index.md` does not link to files that failed to write or were deleted.
- Verify `before_agent_start` recall reads Markdown active memories and appends them to the system prompt.
- Verify `/dreaming approve` and `/dreaming reject` are no longer in command dispatch, usage, or README.
- Verify README storage path and command list match implementation.

## Performance Considerations
- Loading active memories reads Markdown files on every recall hook; keep memory files flat and cap prompt entries with `maxActiveMemoriesInPrompt` to preserve current behavior.
- Regenerating `_index.md` on every save is acceptable for expected small memory counts, but the write path should avoid unnecessary rewrites when operations are dropped.
- Slug lookup should use normalized slug maps to avoid repeated scans during a single run.

## Migration Notes
No backwards-compatible migration from `.pi/dreaming/memories.json` is planned. The developer explicitly allowed ignoring the current JSON format. Existing JSON files may remain unused next to the new Markdown store.

## Pattern References
- `extensions/pi-dreaming/index.ts:8-10` — preserve command/lifecycle registration seam.
- `extensions/pi-dreaming/index.ts:72-81` — model recall hook behavior and `lastUsedAt` update.
- `extensions/pi-dreaming/store.ts:57-83` — model local temp-write/rename/chmod persistence style.
- `extensions/pi-dreaming/store.ts:111-218` — model defensive normalization style.
- `extensions/pi-dreaming/dreamer.ts:42-202` — model run orchestration and model error handling.
- `extensions/pi-dreaming/dreamer.ts:268-300` — model safety predicate but strengthen write boundary.
- `extensions/pi-dreaming/dreamer.ts:380-403` — preserve finishRun/lastRun behavior.
- `extensions/pi-dreaming/commands.ts:15-30` — preserve slash-command dispatch style.
- `README.md:38-68` — update public automatic behavior and command surface.

## Developer Context
- Inherited discover decision: user-facing entry remains pi extension `/dreaming` command and lifecycle.
- Inherited discover decision: use current pi session, not ant session retrieval.
- Inherited discover decision: memory maintenance depth, Markdown storage, automatic + manual triggers.
- Inherited discover decision: always auto-save; secrets forbidden.
- Inherited research decision: normal-only save; secret/forbidden/sensitive/low-confidence are not written to Markdown.
- Inherited research decision: `/dreaming approve` and `/dreaming reject` are completely removed.
- Directional checkpoint: preserve narrow extension seam from `package.json:24-27` and `index.ts:8-10` — developer answered “Keep seam”.
- Directional checkpoint: keep or replace store API used by `index.ts:73-80` and `dreamer.ts:42-61` — developer answered “New API”.
- Directional checkpoint: one-call vs multi-step synthesis from `dreamer.ts:123-141` — developer answered “任せます”; plan chooses one-call orchestration to preserve error/finishRun semantics.
- Metadata checkpoint: settings/lastRun location from `types.ts:57-62` and `dreamer.ts:60-74` — developer answered “Separate state”.
- Layout checkpoint: Markdown memory placement — developer answered “任せます。現行は無視してよいです。Claude の Dreaming は参考にします”; public web research found no authoritative Dreaming layout, so plan chooses flat files plus `_index.md`.
- Stale checkpoint: stale/contradicted memory handling from `dreamer.ts:210-218` — developer answered “Delete file”.
- Design checkpoint: developer approved the summarized architecture and scope.
- Decomposition checkpoint: developer approved 4 slices.
- Step 9 review triage: developer chose applied for the blocker in Phase 1 `store.ts`; code fence now destructures and guards regex captures before frontmatter assignment.

## Plan History
- Phase 1: Markdown store foundation — revised: applied Step 9 reviewer fix for noUncheckedIndexedAccess-safe regex capture handling in splitFrontmatter
- Phase 2: Maintenance synthesis — approved as generated (slice-verifier atomicity violations accepted as by-design until Phase 3 callsite update)
- Phase 3: Runtime UX wiring — approved as generated
- Phase 4: Documentation — approved as generated

## References
- `.rpiv/artifacts/research/2026-06-12_23-49-17_pi-session-dreaming-memory-maintenance.md`
- `.rpiv/artifacts/discover/2026-06-12_23-37-59_pi-session-dreaming-memory-maintenance.md`
- `package.json`
- `README.md`
- `extensions/pi-dreaming/index.ts`
- `extensions/pi-dreaming/commands.ts`
- `extensions/pi-dreaming/session.ts`
- `extensions/pi-dreaming/types.ts`
- `extensions/pi-dreaming/store.ts`
- `extensions/pi-dreaming/dreamer.ts`
- `extensions/pi-dreaming/prompts.ts`

## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

_Coverage reviewer cleared all verification notes and pattern references._

| source | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| code | Phase 1 §2 (store.ts) | tsconfig.json:22 | blocker | code-quality | `splitFrontmatter` uses `frontmatter[match[1]] = parseFrontmatterValue(match[2])`, but `noUncheckedIndexedAccess` makes both regex captures `string \| undefined`, so `bun run check` will fail. | Guard or destructure the captures before use, e.g. `const [, key, rawValue] = match; if (!key \|\| rawValue === undefined) continue;`. | applied: destructured regex captures and guarded missing key/rawValue before assigning frontmatter. |
