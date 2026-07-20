# Triangular Arbitrage Detector

**A safety-gated Upbit market scanner and execution research engine for cryptocurrency triangular arbitrage.**

This Node.js project discovers three-asset conversion cycles, evaluates them against live order-book depth, fees, minimum-order rules, and latency constraints, and produces auditable dry-run or replay evidence. It also contains a guarded real-execution path, which is disabled by default and requires explicit runtime authorization plus exchange-readiness checks.

> This repository is an engineering and market-microstructure research project. It does not guarantee executable profit and is not financial advice.

## System overview

```text
Upbit markets and order books
        ↓
triangle discovery and route generation
        ↓
fee-aware depth validation and strategy ranking
        ↓
execution plan
        ├─ observe only
        ├─ dry-run / deterministic replay
        └─ guarded real execution
        ↓
append-only decisions, orders, fills, and performance reports
```

## Key capabilities

- Dynamic discovery of canonical and reverse triangular routes across KRW, BTC, and USDT start assets.
- Bid/ask-aware cycle valuation using current order-book snapshots rather than mid-prices.
- Market- and side-specific fees, minimum-order totals, liquidity caps, slippage, and residual-asset accounting.
- Strategy contract with `evaluate`, `rank`, `buildExecutionPlan`, and `explain` stages.
- Observe, dry-run, replay, and `REAL_GUARDED` operating modes.
- Deterministic tape replay with SHA-256 fingerprints for candidates, plans, executions, and reports.
- Private-order reconciliation through Upbit MyOrder WebSocket with REST fallback.
- Capital reservation, balance guards, daily-loss limits, latency guards, partial-fill policies, and emergency-stop state.
- Append-only NDJSON audit logs and terminal-based operational control.

## Safety model

Live trading is off by default. Real order submission is refused unless all of the following are true:

1. Runtime mode is `REAL_GUARDED`.
2. `Q_GAGARIN_ALLOW_LIVE_TRADING=true`.
3. `Q_GAGARIN_LIVE_TRADING_ENABLED=true`.
4. API credentials, permissions, private WebSocket, order policy, balance cache, and public market feed pass readiness checks.
5. Risk, balance, latency, fee, and minimum-order guards accept the execution plan.

The `Q_GAGARIN_*` environment-variable prefix is retained for backward compatibility with the repository's former name.

## Requirements

- Node.js 22
- npm
- nvm, recommended

## Installation

```bash
nvm use
npm install
npm run check
npm test
```

Public quotation and scanning commands require no API keys. For authenticated features, copy `.env.example` to the ignored local `.env` file and provide credentials there. Never commit exchange keys.

```dotenv
UPBIT_ACCESS_KEY=
UPBIT_SECRET_KEY=
Q_GAGARIN_ALLOW_LIVE_TRADING=false
Q_GAGARIN_LIVE_TRADING_ENABLED=false
```

## Quick start

Run the read-only universe scanner:

```bash
npm run triangles
```

Run the engine and terminal client in separate terminals:

```bash
npm run engine
npm run cli
```

Useful CLI commands include:

```text
/status
/start dry --follow
/market
/desk --start KRW --top 20
/opportunity show #1
/strategy list
/contracts --mode DRY_RUN --follow
/dryrun report --format json
/readiness
/execution
/pause
/stop
```

The client accepts structured slash commands only; it does not interpret natural-language trading instructions.

## Scanner outputs

`npm run triangles` writes ignored local artifacts under `out/`:

- `upbit-triangles.json`
- `upbit-canonical-cycles.json`
- `upbit-canonical-cycle-multipliers.csv`
- `upbit-canonical-cycle-multipliers.html`

The scanner is read-only and does not submit orders. A scalar fee can be supplied for exploratory scans:

```bash
UPBIT_TAKER_FEE_RATE=0.0005 npm run triangles
```

Authenticated execution instead resolves fee and market policy per market through Upbit order-chance data, with documented quote-market fallbacks when an explicit policy is unavailable.

## Replay and failure testing

Saved order-book tapes can reproduce dry-run decisions without contacting the exchange:

```bash
TAPE_JSON=out/replay/orderbook-tape.json \
CYCLES_JSON=out/upbit-canonical-cycles.json \
REPLAY_NOW_MS=1700000000000 \
npm run replay:dryrun
```

Scenario files may inject partial fills, zero fills, delayed private WebSocket events, REST reconciliation, and execution-latency failures:

```bash
SCENARIO_JSON=out/replay/partial-fill-scenario.json \
TAPE_JSON=out/replay/orderbook-tape.json \
npm run replay:dryrun
```

## Execution and audit boundary

- The default real execution mode is limit IOC at the latest observed best bid or ask.
- Every next leg uses the actual filled amount from the preceding leg.
- Liquidity-cap residuals and IOC partial-fill residuals are recorded separately.
- Intermediate-leg latency or adverse repricing can stop the route or trigger an enabled recovery-to-start order.
- Decisions, orders, fills, commands, errors, and reconciliation outcomes are written to append-only NDJSON logs under `out/logs/`.
- Runtime snapshots and atomic command files allow multiple terminal clients without exposing an HTTP control surface.

Generated outputs, credentials, balances, and operational logs are intentionally excluded from Git.

## Project structure

```text
config/       runtime and strategy configuration
scripts/      scanners, engine entry points, replay, and diagnostics
src/          exchange clients, strategies, execution, risk, audit, and CLI modules
test/         unit and integration-oriented tests
BASELINE.md   runtime assumptions and baseline procedure
REAL_RUN_READINESS.md  guarded execution readiness checklist
```

## Validation commands

```bash
npm run check
npm test
npm run baseline
```

Baseline artifacts are written under the ignored `out/baseline/` directory. See [BASELINE.md](BASELINE.md) for the measurement contract and [REAL_RUN_READINESS.md](REAL_RUN_READINESS.md) before enabling any authenticated execution path.
