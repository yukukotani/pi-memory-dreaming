import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runDreaming } from "./dreamer.js";
import { getActiveMemories, getCandidateMemories, loadDreamingStore, saveDreamingStore } from "./store.js";
import type { DreamingMemory, DreamingRunResult } from "./types.js";

const COMMAND_NAME = "dreaming";

export function registerDreamingCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Manage pi-dreaming saved memories",
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
	if (command === "approve") return approveMemory(ctx, rest[0]);
	if (command === "reject") return rejectMemory(ctx, rest[0]);
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
	const store = loadDreamingStore(cwd);
	const active = getActiveMemories(store).length;
	const candidates = getCandidateMemories(store).length;
	const archived = store.memories.filter((memory) => memory.status === "archived").length;
	return [
		`pi-dreaming: ${store.settings.enabled ? "enabled" : "disabled"}`,
		`saved=${active}, candidates=${candidates}, archived=${archived}`,
		`interval=${Math.round(store.settings.intervalMs / 1000)}s, autoSaveMinConfidence=${store.settings.autoSaveMinConfidence}`,
		store.lastRun
			? `lastRun=${store.lastRun.status} ${store.lastRun.finishedAt ?? store.lastRun.startedAt} ${store.lastRun.message ?? ""}`
			: "lastRun=(never)",
	].join("\n");
}

function formatList(cwd: string, scope: string): string {
	const store = loadDreamingStore(cwd);
	const memories = scope === "candidates"
		? getCandidateMemories(store)
		: scope === "all"
			? store.memories
			: getActiveMemories(store);
	if (memories.length === 0) return `No ${scope} memories.`;
	return memories.map((memory) => `${memory.id} ${memory.status} ${memory.kind} ${memory.confidence.toFixed(2)} ${memory.content}`).join("\n");
}

function formatShow(cwd: string, id: string | undefined): string {
	if (!id) return "Usage: /dreaming show <memory-id>";
	const memory = findMemory(loadDreamingStore(cwd).memories, id);
	if (!memory) return `Memory not found: ${id}`;
	return JSON.stringify(memory, null, 2);
}

function forgetMemory(ctx: ExtensionCommandContext, id: string | undefined): void {
	if (!id) return notify(ctx, "Usage: /dreaming forget <memory-id>", "warning");
	const store = loadDreamingStore(ctx.cwd);
	const before = store.memories.length;
	store.memories = store.memories.filter((memory) => memory.id !== id);
	if (store.memories.length === before) return notify(ctx, `Memory not found: ${id}`, "warning");
	notify(ctx, saveDreamingStore(ctx.cwd, store) ? `Deleted memory ${id}` : `Failed to delete memory ${id}`, "info");
}

function approveMemory(ctx: ExtensionCommandContext, id: string | undefined): void {
	if (!id) return notify(ctx, "Usage: /dreaming approve <candidate-id>", "warning");
	const store = loadDreamingStore(ctx.cwd);
	const memory = findMemory(store.memories, id);
	if (!memory || memory.status !== "candidate") return notify(ctx, `Candidate not found: ${id}`, "warning");
	if (memory.sensitivity === "forbidden") return notify(ctx, `Refusing to approve forbidden memory ${id}`, "error");
	memory.status = "active";
	memory.updatedAt = new Date().toISOString();
	notify(ctx, saveDreamingStore(ctx.cwd, store) ? `Approved memory ${id}` : `Failed to approve memory ${id}`, "info");
}

function rejectMemory(ctx: ExtensionCommandContext, id: string | undefined): void {
	if (!id) return notify(ctx, "Usage: /dreaming reject <candidate-id>", "warning");
	const store = loadDreamingStore(ctx.cwd);
	const before = store.memories.length;
	store.memories = store.memories.filter((memory) => memory.id !== id || memory.status !== "candidate");
	if (store.memories.length === before) return notify(ctx, `Candidate not found: ${id}`, "warning");
	notify(ctx, saveDreamingStore(ctx.cwd, store) ? `Rejected memory ${id}` : `Failed to reject memory ${id}`, "info");
}

function setEnabled(ctx: ExtensionCommandContext, enabled: boolean): void {
	const store = loadDreamingStore(ctx.cwd);
	store.settings.enabled = enabled;
	notify(
		ctx,
		saveDreamingStore(ctx.cwd, store) ? `pi-dreaming ${enabled ? "enabled" : "disabled"}` : "Failed to save pi-dreaming settings",
		"info",
	);
}

function findMemory(memories: DreamingMemory[], id: string): DreamingMemory | undefined {
	return memories.find((memory) => memory.id === id);
}

function formatRunResult(result: DreamingRunResult): string {
	return `${result.status}: ${result.message} (saved=${result.saved}, candidates=${result.candidates}, archived=${result.archived})`;
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
		"  list [active|candidates|all]",
		"  show <id>",
		"  run [--dry-run] [--force]",
		"  approve <candidate-id>",
		"  reject <candidate-id>",
		"  forget <memory-id>",
		"  enable | disable",
	].join("\n");
}
