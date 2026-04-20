import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager, SessionSelectorComponent } from "@mariozechner/pi-coding-agent";
import { load, prune, remove, upsert } from "./registry.js";
import { spawnAndSwap } from "./swap.js";

const SELF = fileURLToPath(import.meta.url);

function inTmux(): boolean {
	return Boolean(process.env.TMUX && process.env.TMUX_PANE);
}

const POOL = "_pi-mux";

function currentPaneSession(paneId: string): string | undefined {
	try {
		return execFileSync("tmux", ["display-message", "-t", paneId, "-p", "#{session_name}"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return undefined;
	}
}

function resolveOwner(selfPane: string): string {
	return process.env.PI_MUX_OWNER || selfPane;
}

function signalReady(): void {
	const readyFile = process.env.PI_MUX_READY_FILE;
	if (!readyFile) return;
	try {
		writeFileSync(readyFile, "");
	} catch {}
}

function onShutdown(): void {
	if (!inTmux()) return;
	const self = process.env.TMUX_PANE!;
	const owner = resolveOwner(self);
	const selfSession = currentPaneSession(self);
	const isVisible = selfSession !== undefined && selfSession !== POOL;
	if (isVisible) {
		for (const sib of load()) {
			if (sib.paneId === self) continue;
			if (sib.owner !== owner) continue;
			try {
				execFileSync("tmux", ["kill-pane", "-t", sib.paneId]);
			} catch {}
			remove(sib.paneId);
		}
	}
	remove(self);
}

export default function (pi: ExtensionAPI) {
	process.once("exit", onShutdown);
	for (const sig of ["SIGHUP", "SIGTERM"] as const) {
		process.once(sig, () => {
			onShutdown();
			process.exit(0);
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!inTmux()) return;
		prune();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			ctx.ui.notify("pi-mux active", "info");
			signalReady();
			return;
		}
		const pane = process.env.TMUX_PANE!;
		upsert({
			paneId: pane,
			sessionFile,
			cwd: ctx.cwd,
			pid: process.pid,
			owner: resolveOwner(pane),
		});
		ctx.ui.notify("pi-mux active", "info");
		signalReady();
	});

	pi.on("session_before_switch", async (event, ctx) => {
		if (!inTmux()) return;
		if (event.reason !== "resume") return;
		const target = event.targetSessionFile;
		if (!target) return;
		const existing = load().find((e) => e.sessionFile === target);
		if (existing) {
			ctx.ui.notify("already open in another pi-mux session, use /switch", "error");
			return { cancel: true };
		}
		spawnAndSwap(`pi -e ${SELF} --session ${target}`, ctx.cwd, resolveOwner(process.env.TMUX_PANE!));
		return { cancel: true };
	});

	pi.on("session_before_fork", async (event, ctx) => {
		if (!inTmux()) return;
		const currentFile = ctx.sessionManager.getSessionFile();
		if (!currentFile) return;
		const selected = ctx.sessionManager.getEntry(event.entryId);
		if (!selected || selected.type !== "message" || selected.message.role !== "user") return;
		const sessionDir = ctx.sessionManager.getSessionDir();
		let newPath: string;
		if (!selected.parentId) {
			const sm = SessionManager.create(ctx.cwd, sessionDir);
			sm.newSession({ parentSession: currentFile });
			const created = sm.getSessionFile();
			if (!created) return;
			newPath = created;
		} else {
			const src = SessionManager.open(currentFile, sessionDir);
			const forked = src.createBranchedSession(selected.parentId);
			if (!forked) return;
			newPath = forked;
		}
		spawnAndSwap(`pi -e ${SELF} --session ${newPath}`, ctx.cwd, resolveOwner(process.env.TMUX_PANE!));
		return { cancel: true };
	});

	pi.registerCommand("switch", {
		description: "Switch to a pi session in this folder (swap if live, spawn otherwise)",
		handler: async (_args, ctx) => {
			if (!inTmux()) {
				ctx.ui.notify("not in tmux", "error");
				return;
			}
			const cwd = ctx.cwd;
			const sessionDir = ctx.sessionManager.getSessionDir();
			const currentFile = ctx.sessionManager.getSessionFile();

			const picked = await ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
				const selector = new SessionSelectorComponent(
					(onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
					SessionManager.listAll,
					(sessionPath: string) => done(sessionPath),
					() => done(undefined),
					() => done(undefined),
					() => tui.requestRender(),
					{
						renameSession: async (sessionFilePath, nextName) => {
							const next = (nextName ?? "").trim();
							if (!next) return;
							const mgr = SessionManager.open(sessionFilePath);
							mgr.appendSessionInfo(next);
						},
						showRenameHint: true,
						keybindings,
					},
					currentFile,
				);
				tui.setFocus(selector.getSessionList());
				return selector;
			});

			if (!picked) return;
			if (picked === currentFile) return;

			const self = process.env.TMUX_PANE!;
			const live = prune();
			const liveEntry = live.find((e) => e.cwd === cwd && e.sessionFile === picked && e.paneId !== self);
			if (liveEntry) {
				execFileSync("tmux", ["swap-pane", "-s", liveEntry.paneId, "-t", self]);
				return;
			}
			spawnAndSwap(`pi -e ${SELF} --session ${picked}`, cwd, resolveOwner(self));
		},
	});
}
