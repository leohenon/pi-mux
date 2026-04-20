import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { load, prune, upsert } from "./registry.js";
import { spawnAndSwap } from "./swap.js";

const SELF = fileURLToPath(import.meta.url);

function inTmux(): boolean {
	return Boolean(process.env.TMUX && process.env.TMUX_PANE);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!inTmux()) return;
		prune();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			ctx.ui.notify("pi-mux active", "info");
			return;
		}
		upsert({
			paneId: process.env.TMUX_PANE!,
			sessionFile,
			cwd: ctx.cwd,
			pid: process.pid,
		});
		ctx.ui.notify("pi-mux active", "info");
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
		spawnAndSwap(`pi -e ${SELF} --session ${target}`, ctx.cwd);
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
		spawnAndSwap(`pi -e ${SELF} --session ${newPath}`, ctx.cwd);
		return { cancel: true };
	});
}
