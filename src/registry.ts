import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Entry {
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
	const entries = load().filter((e) => e.paneId !== entry.paneId);
	entries.push(entry);
	save(entries);
}

export function remove(paneId: string): void {
	save(load().filter((e) => e.paneId !== paneId));
}

export function prune(): Entry[] {
	const live = livePanes();
	const entries = load().filter((e) => live.has(e.paneId));
	save(entries);
	return entries;
}

function livePanes(): Set<string> {
	try {
		const out = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" });
		return new Set(out.split("\n").filter(Boolean));
	} catch {
		return new Set();
	}
}
