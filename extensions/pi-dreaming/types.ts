export const DREAMING_STORE_VERSION = 1;
export const DEFAULT_DREAMING_INTERVAL_MS = 5 * 60 * 1000;

export type MemoryKind = "preference" | "fact" | "workflow" | "correction" | "project";
export type MemoryStatus = "active" | "candidate" | "archived";
export type MemorySensitivity = "normal" | "sensitive" | "forbidden";
export type DreamingRunReason = "timer" | "agent_end" | "manual" | "startup";

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
	id: string;
	kind: MemoryKind;
	content: string;
	status: MemoryStatus;
	confidence: number;
	sensitivity: MemorySensitivity;
	rationale?: string;
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
	candidateMaxAgeDays: number;
}

export interface DreamingLastRun {
	startedAt: string;
	finishedAt?: string;
	reason: DreamingRunReason;
	signature?: string;
	status: "completed" | "skipped" | "failed";
	message?: string;
}

export interface DreamingStore {
	version: typeof DREAMING_STORE_VERSION;
	settings: DreamingSettings;
	memories: DreamingMemory[];
	lastRun?: DreamingLastRun;
}

export type SynthesisAction = "upsert" | "archive" | "ignore";

export interface DreamingSynthesisCandidate {
	action: SynthesisAction;
	id?: string;
	kind?: MemoryKind;
	content?: string;
	confidence?: number;
	sensitivity?: MemorySensitivity;
	tags?: string[];
	rationale?: string;
	archiveReason?: string;
}

export interface DreamingSynthesisResult {
	memories: DreamingSynthesisCandidate[];
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
	candidates: number;
	archived: number;
	message: string;
}
