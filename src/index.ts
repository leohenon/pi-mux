import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function inTmux(): boolean {
	return Boolean(process.env.TMUX && process.env.TMUX_PANE);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!inTmux()) return;
		ctx.ui.notify("pi-mux active", "info");
	});
}
