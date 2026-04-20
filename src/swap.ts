import { execFileSync } from "node:child_process";

const POOL = "_pi-mux";

function poolExists(): boolean {
	try {
		execFileSync("tmux", ["has-session", "-t", POOL], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export function spawnAndSwap(command: string, cwd: string): string {
	const pane = process.env.TMUX_PANE;
	if (!pane) throw new Error("not in tmux");

	let newPane: string;
	if (!poolExists()) {

		execFileSync("tmux", ["new-session", "-d", "-s", POOL, "-c", cwd, command]);
		newPane = execFileSync("tmux", ["display-message", "-t", POOL, "-p", "#{pane_id}"], {
			encoding: "utf8",
		}).trim();
	} else {

		newPane = execFileSync(
			"tmux",
			["new-window", "-d", "-t", `${POOL}:`, "-c", cwd, "-P", "-F", "#{pane_id}", command],
			{ encoding: "utf8" },
		).trim();
	}
	execFileSync("tmux", ["swap-pane", "-s", newPane, "-t", pane]);
	return newPane;
}
