# q-gagarin Baseline

This baseline captures the current terminal-operated runtime.

## Current Commands

```bash
npm run check
npm test
npm run triangles
npm run engine
npm run cli
npm run cli:logs
npm run cli:desk
npm run replay:dryrun
npm run baseline
```

- `npm run check` syntax-checks JavaScript under `src`, `scripts`, and `test`.
- `npm test` runs `npm run check` and the Node.js test suite.
- `npm run triangles` runs a read-only Upbit public REST scan and writes reports under `out/`.
- `npm run engine` starts the engine process and writes runtime files under `out/runtime/`.
- `npm run cli` starts the structured slash-command CLI.
- `npm run baseline` records the latest runtime snapshot summary under `out/baseline/`.

## Runtime Assumptions

- Node.js 22 is expected.
- Upbit is the only implemented exchange.
- The engine owns exchange connections, strategies, execution, risk checks, readiness, snapshots, deltas, and append-only logs.
- Browser operation has been removed; operations use `npm run engine` plus one or more `npm run cli` terminals.
- CLI clients read `out/runtime/latest-snapshot.json`, `out/runtime/latest-delta.json`, and `out/logs/*.ndjson` directly.
- CLI control commands write atomic JSON command files under `out/runtime/commands/inbox/`.
- The engine processes each command once, moves it to `out/runtime/commands/processed/`, writes status under `out/runtime/command-status/`, and records command audit rows in `out/logs/commands.ndjson`.
- Live trading is disabled by default in `config/runtime.json`.
- Default start assets are `KRW`, `BTC`, and `USDT`.
- Observation depth is configured as `5`; validation depth is configured as `30`.
- Runtime config changes are draft/stopped-state changes, not running-engine mutations.

## Baseline Metrics

Run:

```bash
npm run baseline
```

The command reads `out/runtime/latest-snapshot.json` by default. Start the engine first if no snapshot exists.

The benchmark writes a file like:

```text
out/baseline/baseline-YYYYMMDD-HHmmss.json
```

Recorded fields include:

- engine state
- market count
- triangle count
- plotted cycle count
- runtime config
- performance budget
- readiness summary
