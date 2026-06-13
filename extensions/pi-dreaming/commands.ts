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
