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

export function spawnAndSwap(command: string, cwd: string, owner: string): string {
	const pane = process.env.TMUX_PANE;
	if (!pane) throw new Error("not in tmux");

	const envArg = ["-e", `PI_MUX_OWNER=${owner}`];
	const shell = process.env.SHELL || "/bin/sh";

	let newPane: string;
	if (!poolExists()) {
		execFileSync("tmux", ["new-session", "-d", "-s", POOL, "-c", cwd, ...envArg, shell, "-i"]);
		newPane = execFileSync("tmux", ["display-message", "-t", POOL, "-p", "#{pane_id}"], {
			encoding: "utf8",
		}).trim();
	} else {
		newPane = execFileSync(
			"tmux",
			["new-window", "-d", "-t", `${POOL}:`, "-c", cwd, ...envArg, "-P", "-F", "#{pane_id}", shell, "-i"],
			{ encoding: "utf8" },
		).trim();
	}

	execFileSync("tmux", ["send-keys", "-t", newPane, ` ${command}; exit`, "Enter"]);
	execFileSync("tmux", ["swap-pane", "-s", newPane, "-t", pane]);
	return newPane;
}
