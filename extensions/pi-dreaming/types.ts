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
