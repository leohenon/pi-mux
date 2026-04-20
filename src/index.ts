import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { prune, upsert } from "./registry.js";

function inTmux(): boolean {
	return Boolean(process.env.TMUX && process.env.TMUX_PANE);
}

function currentTmuxSession(): string | undefined {
	try {
		const out = execFileSync(
			"tmux",
			["display-message", "-p", "-t", process.env.TMUX_PANE!, "-F", "#{session_name}"],
			{ encoding: "utf8" },
		);
		return out.trim() || undefined;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!inTmux()) return;
		prune();
		const sessionFile = ctx.sessionManager.getSessionFile();
		const tmuxSession = currentTmuxSession();
		if (!sessionFile || !tmuxSession) {
			ctx.ui.notify("pi-mux active", "info");
			return;
		}
		upsert({
			tmuxSession,
			paneId: process.env.TMUX_PANE!,
			sessionFile,
			cwd: ctx.cwd,
			pid: process.pid,
		});
		ctx.ui.notify("pi-mux active", "info");
	});
}
