import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Heartbeat {
	paneId: string;
	sessionFile: string;
	cwd: string;
	pid: number;
	owner: string;
	busy: boolean;
	/** Session display name (user-set via /name) or first user message. */
	label?: string;
}

const DIR = join(homedir(), ".pi-mux", "heartbeats");
const INTERVAL_MS = 2000;
const STALE_MS = 5000;

function filePath(paneId: string): string {
	return join(DIR, `${paneId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

let currentPath: string | undefined;
let currentEntry: Heartbeat | undefined;
let tickHandle: ReturnType<typeof setInterval> | undefined;

export function start(entry: Heartbeat): void {
	mkdirSync(DIR, { recursive: true });
	currentPath = filePath(entry.paneId);
	currentEntry = entry;
	writeCurrent();
	const tick = setInterval(() => {
		if (!currentPath) return;
		const now = new Date();
		try {
			utimesSync(currentPath, now, now);
		} catch {
			writeCurrent();
		}
	}, INTERVAL_MS);
	if (typeof tick.unref === "function") tick.unref();
	tickHandle = tick;
}

export function setBusy(busy: boolean): void {
	if (!currentEntry) return;
	if (currentEntry.busy === busy) return;
	currentEntry = { ...currentEntry, busy };
	writeCurrent();
}

export function setLabel(label: string | undefined): void {
	if (!currentEntry) return;
	const next = label && label.trim() ? label.trim() : undefined;
	if (currentEntry.label === next) return;
	currentEntry = { ...currentEntry, label: next };
	writeCurrent();
}

function writeCurrent(): void {
	if (!currentPath || !currentEntry) return;
	try {
		writeFileSync(currentPath, JSON.stringify(currentEntry));
	} catch {}
}

export function stop(): void {
	if (tickHandle) {
		clearInterval(tickHandle);
		tickHandle = undefined;
	}
	if (currentPath) {
		try {
			unlinkSync(currentPath);
		} catch {}
		currentPath = undefined;
	}
	currentEntry = undefined;
}

/**
 * Return all pi slots with a fresh heartbeat (mtime within STALE_MS). Stops
 * responding when pi is ctrl-z'd, crashed, or otherwise paused — which is
 * the right signal for "is this session actively running and swappable."
 * Opportunistically removes stale files.
 */
export function listActive(): Heartbeat[] {
	const cutoff = Date.now() - STALE_MS;
	const result: Heartbeat[] = [];
	for (const name of readDirSafe()) {
		const full = join(DIR, name);
		let mtimeMs: number;
		try {
			mtimeMs = statSync(full).mtimeMs;
		} catch {
			continue;
		}
		const data = readEntry(full);
		const fresh = mtimeMs >= cutoff;
		if (!data || !pidAlive(data.pid) || !fresh) {
			try {
				unlinkSync(full);
			} catch {}
			continue;
		}
		result.push(data);
	}
	return result;
}

function readDirSafe(): string[] {
	if (!existsSync(DIR)) return [];
	try {
		return readdirSync(DIR);
	} catch {
		return [];
	}
}

function readEntry(full: string): Heartbeat | undefined {
	try {
		const data = JSON.parse(readFileSync(full, "utf8")) as Partial<Heartbeat>;
		if (
			typeof data.paneId === "string" &&
			typeof data.sessionFile === "string" &&
			typeof data.cwd === "string" &&
			typeof data.pid === "number" &&
			typeof data.owner === "string"
		) {
			return {
				paneId: data.paneId,
				sessionFile: data.sessionFile,
				cwd: data.cwd,
				pid: data.pid,
				owner: data.owner,
				busy: typeof data.busy === "boolean" ? data.busy : false,
				label: typeof data.label === "string" ? data.label : undefined,
			};
		}
	} catch {
		try {
			unlinkSync(full);
		} catch {}
	}
	return undefined;
}

function pidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
