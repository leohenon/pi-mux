import { execFileSync } from "node:child_process";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { Container } from "@mariozechner/pi-tui";
import type { Focusable, TUI } from "@mariozechner/pi-tui";
import * as heartbeat from "./heartbeat.js";

const POOL = "_pi-mux";

type Scope = "cwd" | "all";
type Mode = "list" | "confirm-kill" | "confirm-kill-all";

export interface MuxMenuOptions {
  tui: TUI;
  theme: Theme;
  currentPaneId: string;
  currentCwd: string;
  done: (result: undefined) => void;
}

export class MuxMenu extends Container implements Focusable {
  focused = true;
  private scope: Scope = "cwd";
  private mode: Mode = "list";
  private selectedIndex = 0;
  private rows: heartbeat.Heartbeat[] = [];
  private pendingConfirmMessage = "";
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly currentPaneId: string;
  private readonly currentCwd: string;
  private readonly done: (result: undefined) => void;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(opts: MuxMenuOptions) {
    super();
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.currentPaneId = opts.currentPaneId;
    this.currentCwd = opts.currentCwd;
    this.done = opts.done;
    this.refresh();
    this.refreshTimer = setInterval(() => {
      this.refresh();
      this.tui.requestRender();
    }, 500);
    if (typeof this.refreshTimer.unref === "function")
      this.refreshTimer.unref();
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private poolPanes = new Set<string>();

  private refresh(): void {
    this.poolPanes = listPoolPanes();
    const all = heartbeat.listActive();
    const inScope =
      this.scope === "all"
        ? all
        : all.filter((e) => e.cwd === this.currentCwd);
    inScope.sort((a, b) => a.paneId.localeCompare(b.paneId));
    this.rows = inScope;
    if (this.selectedIndex >= this.rows.length) {
      this.selectedIndex = Math.max(0, this.rows.length - 1);
    }
  }

  private killTargets(): heartbeat.Heartbeat[] {
    return this.rows.filter((r) => r.paneId !== this.currentPaneId);
  }

  private selectedRow(): heartbeat.Heartbeat | undefined {
    return this.rows[this.selectedIndex];
  }

  handleInput(data: string): void {
    if (this.mode !== "list") {
      this.handleConfirmInput(data);
      return;
    }
    if (data === "\r" || data === "\n" || data === "\u001b" || data === "q") {
      this.done(undefined);
      return;
    }
    if (data === "\t") {
      this.scope = this.scope === "cwd" ? "all" : "cwd";
      this.selectedIndex = 0;
      this.refresh();
      this.tui.requestRender();
      return;
    }
    if (data === "\u001b[A" || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.tui.requestRender();
      return;
    }
    if (data === "\u001b[B" || data === "j") {
      const max = this.rows.length - 1;
      this.selectedIndex = Math.min(max, this.selectedIndex + 1);
      this.tui.requestRender();
      return;
    }
    if (data === "d") {
      const row = this.selectedRow();
      if (!row) return;
      if (row.paneId === this.currentPaneId) return;
      const name = row.label?.trim() || "(empty session)";
      const snippet = name.length > 40 ? `${name.slice(0, 37)}…` : name;
      this.pendingConfirmMessage = `Kill "${snippet}"? [y/N]`;
      this.mode = "confirm-kill";
      this.tui.requestRender();
      return;
    }
    if (data === "D") {
      const targets = this.killTargets();
      if (targets.length === 0) return;
      const scopeLabel =
        this.scope === "cwd" ? "in this folder" : "across all folders";
      this.pendingConfirmMessage = `Kill ${targets.length} backgrounded ${scopeLabel}? [y/N]`;
      this.mode = "confirm-kill-all";
      this.tui.requestRender();
      return;
    }
  }

  private handleConfirmInput(data: string): void {
    const confirmed = data === "y" || data === "Y";
    if (confirmed && this.mode === "confirm-kill") {
      const row = this.selectedRow();
      if (row && row.paneId !== this.currentPaneId) {
        this.killPane(row.paneId);
      }
      this.refresh();
      this.selectedIndex = Math.min(
        this.selectedIndex,
        Math.max(0, this.rows.length - 1),
      );
      this.mode = "list";
      this.tui.requestRender();
      return;
    }
    if (confirmed && this.mode === "confirm-kill-all") {
      for (const row of this.killTargets()) {
        this.killPane(row.paneId);
      }
      this.refresh();
      this.mode = "list";
      this.selectedIndex = 0;
      if (this.rows.length === 0) {
        this.done(undefined);
        return;
      }
      this.tui.requestRender();
      return;
    }
    this.mode = "list";
    this.tui.requestRender();
  }

  private killPane(paneId: string): void {
    try {
      execFileSync("tmux", ["kill-pane", "-t", paneId]);
    } catch {}
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const scopeLabel = this.scope === "cwd" ? "this folder" : "all folders";
    const header = this.theme.bold(
      `pi-mux  ${this.theme.fg(
        "muted",
        `[${this.rows.length} in ${scopeLabel}]`,
      )}`,
    );
    lines.push(truncate(header, width));
    lines.push("");

    if (this.rows.length === 0) {
      lines.push(
        this.theme.fg("muted", "  (no backgrounded pi sessions)"),
      );
    } else {
      for (let i = 0; i < this.rows.length; i++) {
        const row = this.rows[i]!;
        const isCurrent = row.paneId === this.currentPaneId;
        const isSelected = i === this.selectedIndex;
        const inPool = this.poolPanes.has(row.paneId);
        const cursor = isSelected ? this.theme.fg("accent", "› ") : "  ";
        const cwdShort = row.cwd.replace(process.env.HOME ?? "", "~");
        const name = row.label?.trim() || "(empty session)";
        const snippet = name.length > 50 ? `${name.slice(0, 47)}…` : name;
        const label = `${cwdShort}  ${this.theme.fg("muted", snippet)}`;
        const tagParts: string[] = [];
        if (isCurrent) tagParts.push("current");
        else if (inPool) tagParts.push("backgrounded");
        else tagParts.push("open");
        if (row.busy && !isCurrent) tagParts.push("busy");
        const tags = this.theme.fg("muted", ` [${tagParts.join(" · ")}]`);
        let line = cursor + label + tags;
        if (isSelected) line = this.theme.bg("selectedBg", line);
        lines.push(truncate(line, width));
      }
    }

    lines.push("");
    if (this.mode !== "list") {
      lines.push(this.theme.fg("error", this.pendingConfirmMessage));
    } else {
      const hints = [
        "d kill",
        "D kill all",
        "tab scope",
        "q close",
      ].join(this.theme.fg("muted", " · "));
      lines.push(this.theme.fg("muted", hints));
    }

    return lines.map((l) => truncate(l, width));
  }

  invalidate(): void {}
}

function truncate(s: string, width: number): string {
  return s.length > width * 4 ? s.slice(0, width * 4) : s;
}

function listPoolPanes(): Set<string> {
  try {
    const out = execFileSync(
      "tmux",
      ["list-panes", "-t", POOL, "-F", "#{pane_id}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}
