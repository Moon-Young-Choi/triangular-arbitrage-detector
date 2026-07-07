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
npm run engine
npm run cli
npm run cli:logs
npm run cli:desk
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

The read-only scanner keeps `netMultiplier` equal to `grossMultiplier` unless you provide a scalar taker fee:

```bash
UPBIT_TAKER_FEE_RATE=0.0005 npm run triangles
```

The scanner does not submit orders. Reverse rows are calculated from their own route and current bid/ask snapshots. Report metadata includes `reportSchemaVersion: 2` because cycle rows now include `startAsset`, `endAsset`, and `routeVariantId`.

## Terminal Operations

q-gagarin is operated from terminal clients. Run the engine in one terminal and one or more CLI clients in other terminals:

```bash
npm run engine
npm run cli
```

The CLI accepts structured slash commands only. It does not interpret natural-language prompts.

```text
qg> /status
qg> /start dry
qg> /start dry --follow
qg> /market
qg> /desk --start KRW --top 20
qg> /opportunity show #1
qg> /execution
qg> /contracts --mode DRY_RUN --follow
qg> /strategy list
qg> /config draft set candidateValidation.minNetProfitRate 0.0002
qg> /config draft diff
qg> /logs --kind orders --follow
qg> /dryrun report --format json
qg> /pause
qg> /stop
```

One-shot commands can run from separate terminals:

```bash
npm run cli -- /status
npm run cli -- /readiness
npm run cli -- /strategy active
npm run cli -- /desk --format csv --start KRW
npm run cli -- /latency
npm run cli -- /balances
npm run cli -- /contracts --mode REAL --limit 5
npm run cli -- /logs --kind errors
npm run cli -- /dryrun report --format csv
```

CLI commands read `out/runtime/latest-snapshot.json`, `out/runtime/latest-delta.json`, and `out/logs/*.ndjson` directly. Start/Pause/Stop/Emergency Stop commands are written atomically under `out/runtime/commands/inbox/`; the engine processes each command once, moves it to `out/runtime/commands/processed/`, writes status under `out/runtime/command-status/`, and keeps `out/logs/commands.ndjson` as an audit log.

## Browser Removal

Browser operation has been removed. `npm run dashboard` and `npm run triangles:live` intentionally print a migration notice and exit; use `npm run engine` plus `npm run cli` instead. There is no HTTP/WebSocket/SSE/static asset path for operations.

The engine owns exchange connections, orderbook stores, strategy evaluation, dry-run/real execution, private fill tracking, snapshots, deltas, and append-only logs. CLI clients read the engine's runtime files directly and queue Observe, Dry Run, Real Guarded, Pause, Stop, and Emergency Stop commands through the atomic command inbox. Each queued command gets a command status record under `out/runtime/command-status/` so CLI clients can show whether the engine accepted or rejected it.

Runtime mutation is still stopped-config-only. Fee, stale-orderbook, strategy, and risk setting changes must be made through `/config` draft commands and picked up on the next engine start, not by mutating a running engine.

Append-only NDJSON logs are written under `out/logs/`:

- `events.ndjson`
- `decisions.ndjson`
- `orders.ndjson`
- `fills.ndjson`
- `errors.ndjson`

Every appended record is normalized with `eventId`, `traceId`, `ts`, `mode`, `exchange`, `startAsset`, `cycleId`, `strategyId`, `engineState`, and a structured `payload` when those fields apply. Records also include `auditSchemaVersion` and `auditSchema.missingRequiredFields`, so dry-run, real-run, command, order, fill, and market-data events can be checked for replay/audit completeness without dropping legacy top-level fields.

Authenticated Upbit REST and private MyOrder WebSocket foundations are present. Real order creation is refused unless `liveTradingEnabled=true`, `Q_GAGARIN_ALLOW_LIVE_TRADING=true`, and the `REAL_GUARDED` readiness checklist passes. The checklist now requires both global dry-run quality and per-`enabledStartAssets` dry-run evidence before real trading can start, with thresholds configured in `executionPolicy.readinessGuards`. `DRY_RUN` uses the same execution-plan shape and writes simulated decision/order/fill events without calling Upbit order creation.

The private MyOrder WebSocket authenticates with a JWT bearer header, subscribes to `myOrder`, normalizes fill and fee fields, sends periodic ping heartbeats, and reconnects after unexpected closes while retaining close code/reason status metadata for readiness and CLI diagnostics.

Fee and market policy planning are market and side aware. Upbit `orders/chance` responses are normalized into `bidFee`, `askFee`, `makerBidFee`, `makerAskFee`, `source`, `loadedAt`, and `expiresAt` fee policies plus market policies with bid/ask minimum totals. During private cache refresh, the engine loads policies for the required triangle markets, injects fees into live depth validation, preserves them on execution plans, and passes cached market/fee policies into real execution leg checks. Cache counts/errors are exposed in `privateCacheStatus`. If an authenticated fee policy is missing, live/replay execution paths fall back to Upbit general-order taker defaults by quote market: KRW `0.05%`, BTC `0.25%`, USDT `0.25%`. Buy legs reserve the fee from the input quote budget (`notional = input / (1 + feeRate)`), while sell legs subtract the fee from gross quote proceeds. Depth validation, execution plans, and dry-run fills can consume `feePolicyByMarket` or a `resolveLegFee` callback; each simulated leg records the resolved `feeSide`, `feeRate`, `feeAmount`, and `feeAsset`. The scalar `UPBIT_TAKER_FEE_RATE` path remains a scanner and explicit fallback input, not the real-run fee evidence source.

Strategies implement a common contract: `evaluate`, `rank`, `buildExecutionPlan`, and `explain`. Execution candidates are queued only through the active strategy's `buildExecutionPlan`; a top-of-book strategy decision alone cannot bypass rejected depth validation. Strategy decisions and plans carry both `strategyId` and `strategyVersion` for replay and audit comparison. `bestLevelResidualIoc` enables `candidateValidation.sizingMode=best-level-residual` through its strategy defaults: it sizes each candidate from the best quote level while leaving at least one Upbit minimum-order residual on the limiting best level, instead of relying on the configured fallback start amount.

Real order submission goes through `OrderManager`, which generates and reserves Upbit `identifier` values, enforces the configured per-second order submission limit before REST mutation calls, writes `order.submitted`/`order.submit_failed` audit events, and prevents identifier reuse. After REST ack, `OrderReconciler` prefers private MyOrder fill events from `FillTracker`; if they do not arrive before the reconciliation timeout, it queries REST `getOrder`, tracks the result, and emits an `order.reconciled` event with `private-ws`, `rest-query`, or `ack-only` source metadata.

Dry-run execution reserves and settles per-start-asset capital buckets for `KRW`, `BTC`, and `USDT`, with available, reserved, locked, and residual fields exposed in the runtime snapshot. Authenticated account checks normalize Upbit `balance` and `locked` values into a real balance snapshot for CLI visibility, readiness evidence, and real-run balance guards. Real plans are rejected before order submission when the requested `startAmount` exceeds the start asset's available exchange balance; locked balances are retained in the rejection context and runtime snapshot.

Real-run guardrails track realized PnL by start asset and trading day, expose daily loss in the runtime snapshot, and trigger an emergency stop when `executionPolicy.realRunLimits.maxDailyLossByAsset` is reached. Emergency stop state is latched into `RiskGuard`, blocks new plans and per-leg orders with `EMERGENCY_STOP_ACTIVE`, and is visible through `/execution`.

Latency is split into market-data, decision, execution, and display/client domains. Market-data and decision latency feed strategy/risk decisions, execution latency is checked against `executionPolicy.executionGuards.maxOrderAckMs` and `maxReconciliationMs`, and display/client latency is informational only. If an intermediate leg exceeds the execution latency budget, the cycle stops with a residual asset instead of submitting the next leg. When `recoverOnRepriceLoss` is enabled on a plan, each intermediate leg is repriced before submission; if the current best bid/ask makes the remaining route worse than the original expected output, the executor skips the next triangle leg and submits a recovery IOC order back to the start asset.

`/contracts` renders executed dry-run and real-run cycles as contract summaries with contract size, asset trend, triangle, route, canonical/reverse direction, per-leg fill prices, fees, slippage, touch ratio, and execution timing. Real leg timing includes order ack, private WS/REST reconciliation, query, and total leg milliseconds; recovered-to-start cycles are included as contract rows. Profit/loss numbers are colored in TTY output; use `--color always`, `--color never`, or `--no-color` to override. `/start dry --follow` and `/start real-guarded --follow` queue Start once, then follow only newly executed contract summaries. `/logs` can filter append-only logs by mode, type, start asset, strategy, cycle, and period. `/dryrun report` exposes a dry-run report summary and JSON/CSV export, including complete rate, depth/latency rejection rates, expected-vs-simulated PnL gap, review period, and start-asset/strategy/route/market-state/latency/best-touch breakdowns. `/readiness` shows the real-run readiness score and start-asset evidence. `/execution` separates latest real-run orders/fills from dry-run logs and shows guard/cache/readiness status, locked balances, residual assets, contract details, and real-run PnL by start asset.

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

Selected Arbitrage Desk rows include route, depth validation, strategy result, execution feasibility, fee/profit fields, and TimingTrace latency breakdowns. Display/client timing is informational only and is not part of engine execution.

## Baseline and Runtime Config

Runtime mode defaults live in `config/runtime.json`; live trading is disabled by default.

Record baseline runtime metrics:

```bash
npm run baseline
```

Baseline JSON files are saved under `out/baseline/`. See `BASELINE.md` for current runtime assumptions.
