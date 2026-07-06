# q-gagarin

Upbit API Node.js playground for REST and WebSocket examples.

## Requirements

- nvm
- Node.js 22
- npm

## Setup

```bash
nvm use
npm install
```

## Scripts

```bash
npm run ticker
npm run ticker:ws
npm run triangles
npm run triangles:live
npm run engine
npm run dashboard
npm run replay:dryrun
npm run baseline
npm run check
npm test
```

The default market is `KRW-BTC`. Override it with `UPBIT_MARKET`:

```bash
UPBIT_MARKET=KRW-ETH npm run ticker
UPBIT_MARKET=KRW-ETH npm run ticker:ws
```

These examples use Upbit public quotation APIs, so no API keys are required.

## Triangular Arbitrage Scanner

Run the read-only universe scanner:

```bash
npm run triangles
```

The scanner loads all Upbit markets dynamically, finds unique 3-asset triangles, builds canonical and reverse route variants for each enabled start asset in a triangle (`KRW`, `BTC`, `USDT` by default), fetches orderbook snapshots, and writes:

- `out/upbit-triangles.json`
- `out/upbit-canonical-cycles.json`
- `out/upbit-canonical-cycle-multipliers.csv`
- `out/upbit-canonical-cycle-multipliers.html`

By default, `netMultiplier` equals `grossMultiplier` because no fee is assumed. To include a taker fee:

```bash
UPBIT_TAKER_FEE_RATE=0.0005 npm run triangles
```

The scanner does not submit orders. Reverse rows are calculated from their own route and current bid/ask snapshots. Report metadata includes `reportSchemaVersion: 2` because cycle rows now include `startAsset`, `endAsset`, and `routeVariantId`.

## Live Dashboard

Recommended live operation uses separate engine and dashboard processes so chart rendering and dashboard JSON work do not share the engine event loop:

```bash
npm run engine
npm run dashboard
```

The dashboard reads `out/runtime/latest-snapshot.json` once for initial state and then follows lightweight deltas from `out/runtime/latest-delta.json`.

For local development you can still start the combined localhost engine and dashboard:

```bash
npm run triangles:live
```

The server prints a URL like:

```text
http://127.0.0.1:3099
```

Use `PORT` to choose another port:

```bash
PORT=4100 npm run triangles:live
```

The browser reads from the local Node.js server only. Upbit market discovery, observation depth-5 and validation depth-30 orderbook WebSocket subscriptions, multiplier calculation, depth-aware candidate validation, caching, latency metrics, and capture saving are handled server-side. Candidate validation rejects mismatched validation depth units, non-default orderbook grouping levels, excessive observation-vs-validation snapshot gaps, and excessive validation leg timestamp skew before an execution plan can be built. Captures are saved under `out/captures/`.

The engine owns exchange connections, orderbook stores, strategy evaluation, dry-run/real execution, private fill tracking, snapshots, deltas, and append-only logs. The dashboard serves static files, reads the engine's runtime files, exposes log APIs, and queues Observe, Dry Run, Real Guarded, Pause, Stop, and Emergency Stop commands for the engine. Each queued command gets a command status record under `out/runtime/command-status/` so the UI can show whether the engine accepted or rejected it.

Dashboard mutation endpoints such as `/api/settings` and `/api/strategy` are rejected in both the separated dashboard process and the combined local development server. Fee, stale-orderbook, and strategy changes must be made as stopped runtime config changes and picked up on the next engine start, not by mutating a running engine from the browser.

Append-only NDJSON logs are written under `out/logs/`:

- `events.ndjson`
- `decisions.ndjson`
- `orders.ndjson`
- `fills.ndjson`
- `errors.ndjson`

Every appended record is normalized with `eventId`, `traceId`, `ts`, `mode`, `exchange`, `startAsset`, `cycleId`, `strategyId`, `engineState`, and a structured `payload` when those fields apply. Records also include `auditSchemaVersion` and `auditSchema.missingRequiredFields`, so dry-run, real-run, command, order, fill, and market-data events can be checked for replay/audit completeness without dropping legacy top-level fields.

Authenticated Upbit REST and private MyOrder WebSocket foundations are present. Real order creation is refused unless `liveTradingEnabled=true`, `Q_GAGARIN_ALLOW_LIVE_TRADING=true`, and the `REAL_GUARDED` readiness checklist passes. The checklist now requires both global dry-run quality and per-`enabledStartAssets` dry-run evidence before real trading can start, with thresholds configured in `executionPolicy.readinessGuards`. `DRY_RUN` uses the same execution-plan shape and writes simulated decision/order/fill events without calling Upbit order creation.

The private MyOrder WebSocket authenticates with a JWT bearer header, subscribes to `myOrder`, normalizes fill and fee fields, sends periodic ping heartbeats, and reconnects after unexpected closes while retaining close code/reason status metadata for readiness and dashboard diagnostics.

Fee and market policy planning are market and side aware. Upbit `orders/chance` responses are normalized into `bidFee`, `askFee`, `makerBidFee`, `makerAskFee`, `source`, `loadedAt`, and `expiresAt` fee policies plus market policies with bid/ask minimum totals. During private cache refresh, the engine loads policies for the required triangle markets, injects fees into live depth validation, preserves them on execution plans, and passes cached market policies into real execution leg checks. Cache counts/errors are exposed in `privateCacheStatus`. Depth validation, execution plans, and dry-run fills can consume `feePolicyByMarket` or a `resolveLegFee` callback; each simulated leg records the resolved `feeSide` and `feeRate`. The scalar `UPBIT_TAKER_FEE_RATE` path remains a scanner and fallback input, not the real-run fee evidence source.

Strategies implement a common contract: `evaluate`, `rank`, `buildExecutionPlan`, and `explain`. Execution candidates are queued only through the active strategy's `buildExecutionPlan`; a top-of-book strategy decision alone cannot bypass rejected depth validation. Strategy decisions and plans carry both `strategyId` and `strategyVersion` for replay and audit comparison.

Real order submission goes through `OrderManager`, which generates and reserves Upbit `identifier` values, enforces the configured per-second order submission limit before REST mutation calls, writes `order.submitted`/`order.submit_failed` audit events, and prevents identifier reuse. After REST ack, `OrderReconciler` prefers private MyOrder fill events from `FillTracker`; if they do not arrive before the reconciliation timeout, it queries REST `getOrder`, tracks the result, and emits an `order.reconciled` event with `private-ws`, `rest-query`, or `ack-only` source metadata.

Dry-run execution reserves and settles per-start-asset capital buckets for `KRW`, `BTC`, and `USDT`, with available, reserved, locked, and residual fields exposed in the runtime snapshot. Authenticated account checks normalize Upbit `balance` and `locked` values into a real balance snapshot for dashboard visibility, readiness evidence, and real-run balance guards. Real plans are rejected before order submission when the requested `startAmount` exceeds the start asset's available exchange balance; locked balances are retained in the rejection context and dashboard snapshot.

Real-run guardrails track realized PnL by start asset and trading day, expose daily loss in the runtime snapshot, and trigger an emergency stop when `executionPolicy.realRunLimits.maxDailyLossByAsset` is reached. Emergency stop state is latched into `RiskGuard`, blocks new plans and per-leg orders with `EMERGENCY_STOP_ACTIVE`, and is visible on the Execution tab.

Latency is split into market-data, decision, execution, and dashboard domains. Market-data and decision latency feed strategy/risk decisions, execution latency is checked against `executionPolicy.executionGuards.maxOrderAckMs` and `maxReconciliationMs`, and dashboard/render latency is displayed only. If an intermediate leg exceeds the execution latency budget, the cycle stops with a residual asset instead of submitting the next leg.

The Logs tab can filter append-only logs by mode, type, start asset, strategy, cycle, and period. It also exposes a dry-run report summary and JSON/CSV export through `/api/dry-run-report`, including complete rate, depth/latency rejection rates, expected-vs-simulated PnL gap, review period, and start-asset/strategy/route/market-state/latency/best-touch breakdowns. The Settings tab shows the real-run readiness score and start-asset evidence. The Execution tab separates latest real-run orders/fills from dry-run logs and shows guard/cache/readiness status, locked balances, residual assets, and real-run PnL by start asset.

Replay support can regenerate dry-run execution plans and the same dry-run review report summary from a saved orderbook tape without touching the exchange:

```bash
TAPE_JSON=out/replay/orderbook-tape.json CYCLES_JSON=out/upbit-canonical-cycles.json npm run replay:dryrun
```

Replay output includes a deterministic `replayManifest` with SHA-256 fingerprints for candidates, execution plans, dry-run executions, and the dry-run report. With the same tape, cycles, strategy, and `REPLAY_NOW_MS`, those fingerprints should remain unchanged across runs.

It can also replay deterministic execution failure scenarios through the real executor path without touching Upbit:

```bash
SCENARIO_JSON=out/replay/partial-fill-scenario.json TAPE_JSON=out/replay/orderbook-tape.json npm run replay:dryrun
```

Scenario files can define per-leg `fillRatio`, `ackDelayMs`, `reconciliationDelayMs`, `privateWsFillDelayMs`, and fill source (`private-ws` or `rest-query`). This is used to reproduce partial fills, zero fills, delayed private WS, REST fallback, and execution latency guard failures.

The default real execution mode is `LIMIT_IOC_AT_OBSERVED_BEST`: each leg reprices from the latest validation depth-30 orderbook, caps the submitted size by the configured best-level touch policy, submits an Upbit limit order with `time_in_force=ioc` at the observed best ask/bid, and uses the actual filled amount for the next leg. Input left unsubmitted by the liquidity cap is recorded as residual asset evidence, separate from IOC partial-fill residuals. Partial fills emit explicit residual events and follow `executionPolicy.partialFillPolicy` (`CONTINUE_IF_ABOVE_MIN` by default, or `ABORT_ON_PARTIAL`). Optional `BEST_IOC` remains disabled unless `enabledExecutionModes` includes `BEST_IOC` and `executionPolicy.allowBestIoc=true`.

Selected Arbitrage Desk points include route, depth validation, strategy result, execution feasibility, fee/profit fields, and TimingTrace latency breakdowns. Browser render timing is measured for display only and is not part of engine execution.

## Baseline and Runtime Config

Runtime mode defaults live in `config/runtime.json`; live trading is disabled by default.

Record baseline dashboard metrics:

```bash
npm run baseline
```

Baseline JSON files are saved under `out/baseline/`. See `BASELINE.md` for current runtime assumptions and dashboard behavior.
