import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const POOL = "_pi-mux";
const READY_DIR = join(tmpdir(), "pi-mux-ready");
const KNOWN_SHELLS = new Set(["fish", "zsh", "bash", "sh", "dash", "ksh"]);

/** Resolve shell: PI_MUX_SHELL env → parent-process shell → $SHELL → /bin/sh. */
export function resolveShell(): string {
	const override = process.env.PI_MUX_SHELL;
	if (override) return override;
	const parent = findParentShell();
	if (parent) return parent;
	return process.env.SHELL || "/bin/sh";
}

function findParentShell(): string | undefined {
	let pid = process.ppid;
	for (let hops = 0; hops < 10 && pid > 1; hops++) {
		try {
			const out = execFileSync("ps", ["-p", String(pid), "-o", "comm=,ppid="], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			if (!out) return undefined;
			const match = out.match(/^(\S+)\s+(\d+)$/);
			if (!match) return undefined;
			const comm = match[1]!;
			const nextPpid = Number.parseInt(match[2]!, 10);
			const name = basename(comm).replace(/^-/, "");
			if (KNOWN_SHELLS.has(name)) {
				if (comm.startsWith("/")) return comm;
				try {
					const resolved = execFileSync("/usr/bin/which", [name], {
						encoding: "utf8",
						stdio: ["ignore", "pipe", "ignore"],
					}).trim();
					if (resolved) return resolved;
				} catch {}
				return comm;
			}
			pid = nextPpid;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

interface ShellPlan {
	initInline: string | undefined;
	armCommand: string;
}

function planForShell(shell: string): ShellPlan {
	const name = basename(shell);
	if (name === "fish") {
		return {
			initInline: [
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
			].join("; "),
			armCommand: "set -gx PI_MUX_ARMED 1",
		};
	}
	if (name === "zsh" || name === "bash") {
		const common = [
			`function exit() {`,
			`  local j="$(jobs -p 2>/dev/null)";`,
			`  if [ -n "$j" ]; then`,
			`    for pid in $j; do kill -CONT "$pid" 2>/dev/null; kill -TERM "$pid" 2>/dev/null; done;`,
			`    for pid in $j; do while kill -0 "$pid" 2>/dev/null; do sleep 0.05; done; done;`,
			`  fi;`,
			`  builtin exit "$@";`,
			`}`,
			`function __pi_mux_auto_exit() {`,
			`  if [ "$PI_MUX_ARMED" = "1" ]; then`,
			`    local j="$(jobs -p 2>/dev/null)";`,
			`    if [ -z "$j" ]; then builtin exit; else unset PI_MUX_ARMED; fi;`,
			`  fi;`,
			`}`,
		].join(" ");
		const hookInstall =
			name === "zsh"
				? `autoload -Uz add-zsh-hook; add-zsh-hook precmd __pi_mux_auto_exit`
				: `PROMPT_COMMAND="__pi_mux_auto_exit; $PROMPT_COMMAND"`;
		return {
			initInline: `${common}; ${hookInstall}`,
			armCommand: "export PI_MUX_ARMED=1",
		};
	}
	return { initInline: undefined, armCommand: "export PI_MUX_ARMED=1" };
}

function poolExists(): boolean {
	try {
		execFileSync("tmux", ["has-session", "-t", POOL], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Override pool options that would otherwise kill sessions or leak windows. */
function isolatePoolSession(): void {
	const opts: [string, string][] = [
		["destroy-unattached", "off"],
		["remain-on-exit", "off"],
	];
	for (const [key, value] of opts) {
		try {
			execFileSync("tmux", ["set-option", "-t", POOL, key, value], {
				stdio: "ignore",
			});
		} catch {}
	}
	try {
		execFileSync("tmux", ["set-option", "-t", POOL, "-w", "-g", "remain-on-exit", "off"], {
			stdio: "ignore",
		});
	} catch {}
}

export function spawnAndSwap(command: string, cwd: string, owner: string): string {
	const pane = process.env.TMUX_PANE;
	if (!pane) throw new Error("not in tmux");

	mkdirSync(READY_DIR, { recursive: true });
	const readyFile = join(READY_DIR, randomUUID());

	const shell = resolveShell();
	const envArg = [
		"-e",
		`PI_MUX_OWNER=${owner}`,
		"-e",
		`PI_MUX_READY_FILE=${readyFile}`,
		"-e",
		`PI_MUX_SHELL=${shell}`,
	];
	const plan = planForShell(shell);
	const useCFlag = basename(shell) === "fish" && plan.initInline;
	const shellArgs = useCFlag
		? [shell, "-i", "-C", plan.initInline as string]
		: [shell, "-i"];

	let newPane: string;
	if (!poolExists()) {
		execFileSync("tmux", ["new-session", "-d", "-s", POOL, "-c", cwd, ...envArg, ...shellArgs]);
		isolatePoolSession();
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

	if (!useCFlag && plan.initInline) {
		execFileSync("tmux", ["send-keys", "-t", newPane, ` ${plan.initInline}`, "Enter"]);
		sleepMs(50);
	}
	execFileSync("tmux", ["send-keys", "-t", newPane, ` ${plan.armCommand}; ${command}`, "Enter"]);

	waitForReadyFile(readyFile, 5000);
	try {
		rmSync(readyFile, { force: true });
	} catch {}

	execFileSync("tmux", ["swap-pane", "-s", newPane, "-t", pane]);
	return newPane;
}

function waitForReadyFile(path: string, timeoutMs: number): void {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		sleepMs(10);
	}
}

function sleepMs(ms: number): void {
	const sab = new SharedArrayBuffer(4);
	const view = new Int32Array(sab);
	Atomics.wait(view, 0, 0, ms);
}
