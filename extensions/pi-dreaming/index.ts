import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDreamingCommand } from "./commands.js";
import { runDreaming } from "./dreamer.js";
import { buildRecallSystemPrompt } from "./prompts.js";
import { buildSessionDigest, isStaleCtxError } from "./session.js";
import { getActiveMemories, loadDreamingStore, saveDreamingStore } from "./store.js";

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
		const store = loadDreamingStore(ctx.cwd);
		interval = setInterval(() => {
			const currentCtx = ctxRef;
			if (!currentCtx) return;
			void attemptDream(currentCtx, "timer");
		}, store.settings.intervalMs);
		interval.unref?.();
	}

	async function attemptDream(ctx: ExtensionContext, reason: "timer" | "agent_end"): Promise<void> {
		if (running) return;
		const currentGeneration = generation;
		try {
			const store = loadDreamingStore(ctx.cwd);
			const digest = buildSessionDigest(ctx, store.settings.maxDigestChars);
			if (reason === "timer" && lastObservedSignature === digest.signature) return;
			running = true;
			const result = await runDreaming(ctx, { reason });
			if (currentGeneration !== generation || !ctxRef) return;
			if (reason === "timer" && result.status !== "failed") lastObservedSignature = digest.signature;
			if (ctx.hasUI && result.status === "completed" && (result.saved > 0 || result.candidates > 0 || result.archived > 0)) {
				ctx.ui.notify(`pi-dreaming: ${result.message} saved=${result.saved} candidates=${result.candidates}`, "info");
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
		const store = loadDreamingStore(ctx.cwd);
		if (!store.settings.enabled) return;
		const active = getActiveMemories(store);
		const recall = buildRecallSystemPrompt(active, store.settings.maxActiveMemoriesInPrompt);
		if (!recall) return;
		const now = new Date().toISOString();
		for (const memory of active.slice(0, store.settings.maxActiveMemoriesInPrompt)) memory.lastUsedAt = now;
		saveDreamingStore(ctx.cwd, store);
		return { systemPrompt: `${event.systemPrompt}\n\n${recall}` };
	});

	pi.on("agent_end", async (_event, ctx) => {
		void attemptDream(ctx, "agent_end");
	});

	pi.on("session_shutdown", async () => {
		cleanup();
	});
}
