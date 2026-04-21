# Contributing

## Local development

Clone the repo and tell `pi` to use your local copy:

```bash
git clone https://github.com/leohenon/pi-mux.git
cd pi-mux
pi install .
```

No build step, `pi` runs the TypeScript directly. Edit the source, then `/reload` pick up changes. Must be in a `tmux` session.

## Type-checking

```bash
npm install
npx tsc --noEmit
```

## Source

```
src/
  index.ts     event hooks, commands
  heartbeat.ts liveness files
  swap.ts      pool spawn + swap
  mux-menu.ts  /mux UI
```
