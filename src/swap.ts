import { execFileSync } from "node:child_process";
import { basename } from "node:path";

const POOL = "_pi-mux";

function shellInitForShell(shell: string): string | undefined {
	const name = basename(shell);
	if (name === "fish") {
		return [
			"function exit",
			"  set -l j (jobs -p)",
			'  if test -n "$j"',
			"    for pid in $j; kill -CONT $pid 2>/dev/null; kill -TERM $pid 2>/dev/null; end",
			"    for pid in $j; while kill -0 $pid 2>/dev/null; sleep 0.05; end; end",
			"  end",
			"  builtin exit $argv",
			"end",
			"function __pi_mux_auto_exit --on-event fish_postexec",
			'  if test "$PI_MUX_ARMED" = "1"',
			"    set -l j (jobs -p)",
			'    if test -z "$j"',
			"      builtin exit",
			"    else",
			"      set -e PI_MUX_ARMED",
			"    end",
			"  end",
			"end",
		].join("; ");
	}
	return undefined;
}

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
	const init = shellInitForShell(shell);

	const shellArgs = init ? [shell, "-i", "-C", init] : [shell, "-i"];

	let newPane: string;
	if (!poolExists()) {
		execFileSync("tmux", ["new-session", "-d", "-s", POOL, "-c", cwd, ...envArg, ...shellArgs]);
		newPane = execFileSync("tmux", ["display-message", "-t", POOL, "-p", "#{pane_id}"], {
			encoding: "utf8",
		}).trim();
	} else {
		newPane = execFileSync(
			"tmux",
			["new-window", "-d", "-t", `${POOL}:`, "-c", cwd, ...envArg, "-P", "-F", "#{pane_id}", ...shellArgs],
			{ encoding: "utf8" },
		).trim();
	}

	execFileSync("tmux", ["send-keys", "-t", newPane, ` set -gx PI_MUX_ARMED 1; ${command}`, "Enter"]);

	waitForPaneCommand(newPane, "node", 2000);
	sleepMs(150);

	execFileSync("tmux", ["swap-pane", "-s", newPane, "-t", pane]);
	return newPane;
}

function waitForPaneCommand(paneId: string, target: string, timeoutMs: number): void {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const cmd = execFileSync("tmux", ["display-message", "-t", paneId, "-p", "#{pane_current_command}"], {
				encoding: "utf8",
			}).trim();
			if (cmd === target) return;
		} catch {
			return;
		}
		sleepMs(10);
	}
}

function sleepMs(ms: number): void {
	const sab = new SharedArrayBuffer(4);
	const view = new Int32Array(sab);
	Atomics.wait(view, 0, 0, ms);
}
