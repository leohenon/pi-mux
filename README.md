# pi-mux

[![npm](https://img.shields.io/npm/v/pi-mux?style=flat-square&logo=npm&logoColor=white&label=npm&color=1bb91f)](https://www.npmjs.com/package/pi-mux) [![node](https://img.shields.io/badge/node-%3E%3D18-1bb91f?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) [![tmux](https://img.shields.io/badge/tmux-%3E%3D3.0-1bb91f?style=flat-square&logo=tmux&logoColor=white)](https://github.com/tmux/tmux)

[Pi](https://github.com/badlogic/pi-mono) session multiplexer. Run multiple Pi sessions in one terminal via `tmux`. Switch between them without killing the one you're leaving.

![demo](https://raw.githubusercontent.com/leohenon/pi-mux/HEAD/demo.gif)

## Install

```bash
pi install npm:pi-mux
```

Requires tmux 3.0+. Run Pi inside any `tmux` session. Outside `tmux`, `pi-mux` is a no-op.

## Commands

### `/switch`

Pick a session and jump to it. Whatever you were in stays alive in the background. (Unlike `/resume`, which closes it.)

A spinner marks sessions currently working.

### `/new`

Start a fresh session without closing the one you're in.

### `/fork`

Fork your current session at any previous message, the original stays open.

### `/mux`

Lists every Pi running on your machine. Kill the ones you're done with.

Each row shows cwd, session name, and a tag:

- `[current]` — the Pi you're typing in.
- `[backgrounded]` — parked in `_pi-mux`, brought back via `/switch`.
- `[open]` — running in another tmux pane you can navigate to.
- `[... · busy]` if mid-turn.

## How it works

pi-mux keeps one extra tmux session, `_pi-mux`, holding backgrounded Pis as detached windows. Spawning (`/new`, `/fork`, `/switch` to a non-live session) creates a detached window in the pool, starts Pi there, and swaps its pane into your visible pane. The Pi you just left is now in the pool, still running.

```
tmux
├── your session
│   └── visible pane  ←── pi-mux swaps panes in & out
│
└── _pi-mux            (hidden, auto-managed)
    ├── window: Pi session A
    ├── window: Pi session B
    └── window: Pi session C
```

When a Pi exits, its window closes; tmux auto-destroys the pool when empty. Heartbeat files in `~/.pi-mux/heartbeats/` track each live Pi, so `/switch` and `/mux` can show which sessions are alive and which are busy.

Backgrounded Pis idle at ~0% CPU and use memory equivalent to one Pi session each.

> [!TIP]
> Hide `_pi-mux` from `tmux ls` with: `alias tls="tmux ls 2>/dev/null | grep -v '^_pi-mux:'"`.
> If the pool has leftover windows after a crash, run `tmux kill-session -t _pi-mux` to clear.

## Contributing

Bug reports, feature ideas, and PRs welcome — see [CONTRIBUTING.md](https://github.com/leohenon/pi-mux/blob/HEAD/CONTRIBUTING.md).

## License

MIT
