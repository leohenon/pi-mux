import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager, SessionSelectorComponent } from "@mariozechner/pi-coding-agent";
import * as heartbeat from "./heartbeat.js";
import { spawnAndSwap } from "./swap.js";

const SELF = fileURLToPath(import.meta.url);

function inTmux(): boolean {
	return Boolean(process.env.TMUX && process.env.TMUX_PANE);
}

const POOL = "_pi-mux";

function currentPaneSession(paneId: string): string | undefined {
	try {
		return execFileSync("tmux", ["display-message", "-t", paneId, "-p", "#{session_name}"], {
			encoding: "utf8",
		}).trim();
	} catch {
		return undefined;
	}
}

function resolveOwner(selfPane: string): string {
	return process.env.PI_MUX_OWNER || selfPane;
}

function signalReady(): void {
	const readyFile = process.env.PI_MUX_READY_FILE;
	if (!readyFile) return;
	try {
		writeFileSync(readyFile, "");
	} catch {}
}



function relabelSelectorTitle(selector: SessionSelectorComponent, newTitle: string): void {
	try {
		const header = (selector as unknown as { header?: { render?: (w: number) => unknown } }).header;
		if (!header || typeof header.render !== "function") return;
		const origRender = header.render.bind(header);
		header.render = (width: number) => {
			const out = origRender(width);
			if (!Array.isArray(out)) return out;
			return out.map((line) =>
				typeof line === "string" ? line.replace(/Resume Session/g, newTitle) : line,
			);
		};
	} catch {
	}
}

const SPINNER_PLACEHOLDER = "\uE000";
const SPINNER_FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];

interface Spinner {
	current(): string;
	dispose(): void;
}

function createSpinner(tui: { requestRender: () => void }): Spinner {
	let frame = 0;
	const interval = setInterval(() => {
		frame = (frame + 1) % SPINNER_FRAMES.length;
		tui.requestRender();
	}, 80);
	return {
		current: () => SPINNER_FRAMES[frame]!,
		dispose: () => clearInterval(interval),
	};
}

interface SessionLike {
	path: string;
	firstMessage: string;
	name?: string;
}

interface SessionListInternals {
	render?: (w: number) => unknown;
	allSessions?: SessionLike[];
	filteredSessions?: { session: SessionLike }[];
}

function attachSpinner(
	selector: SessionSelectorComponent,
	spinner: Spinner,
	queryBusyPaths: () => Set<string>,
): void {
	const anySel = selector as unknown as {
		sessionList?: SessionListInternals;
		dispose?: () => void;
	};
	const originals = new Map<SessionLike, { name: string | undefined; firstMessage: string }>();
	try {
		const list = anySel.sessionList;
		if (list && typeof list.render === "function") {
			const origRender = list.render.bind(list);
			list.render = (width: number) => {
				syncSessionMarkers(list, queryBusyPaths(), originals);
				const out = origRender(width);
				if (!Array.isArray(out)) return out;
				const glyph = spinner.current();
				return out.map((line) =>
					typeof line === "string" ? line.split(SPINNER_PLACEHOLDER).join(glyph) : line,
				);
			};
		}
	} catch {
	}
	const prevDispose = anySel.dispose?.bind(selector);
	anySel.dispose = () => {
		spinner.dispose();
		prevDispose?.();
	};
}

function syncSessionMarkers(
	list: SessionListInternals,
	busyPaths: Set<string>,
	originals: Map<SessionLike, { name: string | undefined; firstMessage: string }>,
): void {
	const pool = new Set<SessionLike>();
	for (const s of list.allSessions ?? []) pool.add(s);
	for (const node of list.filteredSessions ?? []) pool.add(node.session);
	for (const s of pool) {
		const orig = originals.get(s) ?? { name: s.name, firstMessage: s.firstMessage };
		if (!originals.has(s)) originals.set(s, orig);
		const shouldMark = busyPaths.has(s.path);
		if (shouldMark) {
			if (orig.name !== undefined) s.name = `${SPINNER_PLACEHOLDER} ${orig.name}`;
			else s.firstMessage = `${SPINNER_PLACEHOLDER} ${orig.firstMessage}`;
		} else {
			if (orig.name !== undefined) s.name = orig.name;
			else s.firstMessage = orig.firstMessage;
		}
	}
}

function onShutdown(): void {
	heartbeat.stop();
	if (!inTmux()) return;
	const self = process.env.TMUX_PANE!;
	const owner = resolveOwner(self);
	const selfSession = currentPaneSession(self);
	const isVisible = selfSession !== undefined && selfSession !== POOL;
	if (isVisible) {
		for (const sib of heartbeat.listActive()) {
			if (sib.paneId === self) continue;
			if (sib.owner !== owner) continue;
			try {
				execFileSync("tmux", ["kill-pane", "-t", sib.paneId]);
			} catch {}
		}
	}
}

export default function (pi: ExtensionAPI) {
	process.once("exit", onShutdown);
	for (const sig of ["SIGHUP", "SIGTERM"] as const) {
		process.once(sig, () => {
			onShutdown();
			process.exit(0);
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!inTmux()) return;
		heartbeat.stop();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) {
			ctx.ui.notify("pi-mux active", "info");
			signalReady();
			return;
		}
		const pane = process.env.TMUX_PANE!;
		heartbeat.start({
			paneId: pane,
			sessionFile,
			cwd: ctx.cwd,
			pid: process.pid,
			owner: resolveOwner(pane),
			busy: false,
		});
		ctx.ui.notify("pi-mux active", "info");
		signalReady();
	});

	pi.on("turn_start", async () => {
		heartbeat.setBusy(true);
	});
	pi.on("turn_end", async () => {
		heartbeat.setBusy(false);
	});
	pi.on("agent_end", async () => {
		heartbeat.setBusy(false);
	});

	pi.on("session_before_switch", async (event, ctx) => {
		if (!inTmux()) return;
		if (event.reason !== "resume") return;
		const target = event.targetSessionFile;
		if (!target) return;
		const existing = heartbeat.listActive().find((e) => e.sessionFile === target);
		if (existing) {
			ctx.ui.notify("already open in another pi-mux session, use /switch", "error");
			return { cancel: true };
		}
		spawnAndSwap(`pi -e ${SELF} --session ${target}`, ctx.cwd, resolveOwner(process.env.TMUX_PANE!));
		return { cancel: true };
	});

	pi.on("session_before_fork", async (event, ctx) => {
		if (!inTmux()) return;
		const currentFile = ctx.sessionManager.getSessionFile();
		if (!currentFile) return;
		const selected = ctx.sessionManager.getEntry(event.entryId);
		if (!selected || selected.type !== "message" || selected.message.role !== "user") return;
		const sessionDir = ctx.sessionManager.getSessionDir();
		let newPath: string;
		if (!selected.parentId) {
			const sm = SessionManager.create(ctx.cwd, sessionDir);
			sm.newSession({ parentSession: currentFile });
			const created = sm.getSessionFile();
			if (!created) return;
			newPath = created;
		} else {
			const src = SessionManager.open(currentFile, sessionDir);
			const forked = src.createBranchedSession(selected.parentId);
			if (!forked) return;
			newPath = forked;
		}
		spawnAndSwap(`pi -e ${SELF} --session ${newPath}`, ctx.cwd, resolveOwner(process.env.TMUX_PANE!));
		return { cancel: true };
	});

	pi.registerCommand("switch", {
		description: "Switch to a pi session in this folder (swap if live, spawn otherwise)",
		handler: async (_args, ctx) => {
			if (!inTmux()) {
				ctx.ui.notify("not in tmux", "error");
				return;
			}
			const cwd = ctx.cwd;
			const sessionDir = ctx.sessionManager.getSessionDir();
			const currentFile = ctx.sessionManager.getSessionFile();

			const self = process.env.TMUX_PANE!;
			const queryBusyPaths = (): Set<string> =>
				new Set(
					heartbeat
						.listActive()
						.filter((e) => e.cwd === cwd && e.paneId !== self && e.busy)
						.map((e) => e.sessionFile),
				);

			const picked = await ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
				const spinner = createSpinner(tui);
				const selector = new SessionSelectorComponent(
					(onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
					SessionManager.listAll,
					(sessionPath: string) => done(sessionPath),
					() => done(undefined),
					() => done(undefined),
					() => tui.requestRender(),
					{
						renameSession: async (sessionFilePath, nextName) => {
							const next = (nextName ?? "").trim();
							if (!next) return;
							const mgr = SessionManager.open(sessionFilePath);
							mgr.appendSessionInfo(next);
						},
						showRenameHint: true,
						keybindings,
					},
					currentFile,
				);
			relabelSelectorTitle(selector, "Switch Session");
				attachSpinner(selector, spinner, queryBusyPaths);
				tui.setFocus(selector.getSessionList());
				return selector;
			});

			if (!picked) return;
			if (picked === currentFile) return;

			const live = heartbeat.listActive();
			const liveEntry = live.find((e) => e.cwd === cwd && e.sessionFile === picked && e.paneId !== self);
			if (liveEntry) {
				execFileSync("tmux", ["swap-pane", "-s", liveEntry.paneId, "-t", self]);
				return;
			}
			spawnAndSwap(`pi -e ${SELF} --session ${picked}`, cwd, resolveOwner(self));
		},
	});
}
