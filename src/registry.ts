import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Entry {
	tmuxSession: string;
	paneId: string;
	sessionFile: string;
	cwd: string;
	pid: number;
}

const FILE = join(homedir(), ".pi-mux", "registry.json");

export function load(): Entry[] {
	if (!existsSync(FILE)) return [];
	try {
		const data = JSON.parse(readFileSync(FILE, "utf8"));
		return Array.isArray(data?.entries) ? data.entries : [];
	} catch {
		return [];
	}
}

export function save(entries: Entry[]): void {
	mkdirSync(dirname(FILE), { recursive: true });
	writeFileSync(FILE, JSON.stringify({ entries }, null, 2));
}

export function upsert(entry: Entry): void {
	const entries = load().filter((e) => e.tmuxSession !== entry.tmuxSession);
	entries.push(entry);
	save(entries);
}

export function remove(tmuxSession: string): void {
	save(load().filter((e) => e.tmuxSession !== tmuxSession));
}

export function prune(): Entry[] {
	const live = listTmuxSessions();
	const entries = load().filter((e) => live.has(e.tmuxSession));
	save(entries);
	return entries;
}

function listTmuxSessions(): Set<string> {
	try {
		const out = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
		return new Set(out.split("\n").filter(Boolean));
	} catch {
		return new Set();
	}
}
