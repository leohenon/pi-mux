import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export function spawnAndSwap(command: string, cwd: string): string {
	const pane = process.env.TMUX_PANE;
	if (!pane) throw new Error("not in tmux");
	const name = `pi-mux-${randomUUID().slice(0, 8)}`;
	execFileSync("tmux", ["new-session", "-d", "-s", name, "-c", cwd, command]);
	const newPane = execFileSync("tmux", ["display-message", "-t", name, "-p", "#{pane_id}"], {
		encoding: "utf8",
	}).trim();
	execFileSync("tmux", ["swap-pane", "-s", newPane, "-t", pane]);
	return name;
}
