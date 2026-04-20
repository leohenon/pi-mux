import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
}
