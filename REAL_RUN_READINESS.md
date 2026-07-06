# Real Run Readiness

Real trading is disabled by default. `REAL_GUARDED` can start only when the readiness checklist passes.

## Required Checks

- Upbit API key and secret are present.
- Required API permissions are verified or explicitly documented.
- Private MyOrder WebSocket is connected.
- `orders/chance` fee policy cache is fresh.
- Depth validation and dry-run execution are using market/side fee policies for every leg.
- Account balance cache is fresh.
- Requested real-run start amount is covered by the start asset's available balance.
- Observation feed is healthy.
- Validation feed is healthy.
- Validation orderbook depth is 30 and fresh.
- Observation and validation snapshots are within `candidateValidation.maxObservationValidationGapMs`, validation leg timestamps are within `executionPolicy.marketDataGuards.maxLegTimestampSkewMs`, and validation orderbooks use the default, ungrouped level.
- A dry-run report exists.
- Dry-run minimum sample count is met.
- Dry-run rejection profile is acceptable.
- Dry-run simulated complete rate is acceptable.
- Dry-run depth rejection rate is below the configured ceiling.
- Dry-run latency rejection rate is below the configured ceiling.
- Dry-run expected-vs-simulated PnL gap is below the configured ceiling.
- Every enabled start asset has its own dry-run sample evidence.
- Every enabled start asset has at least one simulated attempt.
- Every enabled start asset passes the same dry-run complete-rate, depth-rejection, latency-rejection, and expected-vs-simulated gap gates.
- `liveTradingEnabled` is explicitly `true`.
- `REAL_AUTO` remains disabled unless manually configured.

The engine refreshes private REST permission, account, and `orders/chance` state before evaluating the checklist. The result is written to append-only events and appears in the dashboard Settings tab with a readiness score. Start-asset gates are evaluated from the same dry-run log set as the global dry-run summary, using `enabledStartAssets` from the active runtime config.

Private MyOrder WebSocket status is sourced from the authenticated subscription client. The client sends ping heartbeats, reconnects on unexpected close, and preserves close code/reason metadata; any non-open private WS status blocks new real orders, and a disconnect during active real execution can trigger the emergency-stop guard.

`orders/chance` data is normalized per market with bid, ask, maker bid, and maker ask rates plus freshness metadata and bid/ask minimum-order totals. During private cache refresh, the engine loads policies for the required triangle markets and marks the order-chance cache fresh only when those policy loads complete without errors. Candidate validation, execution plans, and dry-run fills resolve fees by market and order side (`bid` for buy legs, `ask` for sell legs) and retain the resolved `feeSide` and `feeRate` in leg evidence. Real execution receives the same cached market policies for per-leg minimum-total checks before submitting an order. Scalar taker fee configuration is only a fallback and is not enough by itself for real-run readiness.

The account balance cache distinguishes available and locked balances. Real execution receives both maps in its guard context and rejects a plan with `BALANCE_INSUFFICIENT` before any order submission when `startAmount` is greater than the start asset's available balance.

Readiness, dry-run, and real-run evidence is stored as normalized audit events. Each appended row carries `auditSchemaVersion` plus `auditSchema.ok` and `auditSchema.missingRequiredFields`; this makes incomplete context visible before using the log set as evidence for real trading or replay. Dry-run reports can be filtered by period and include market-state, latency-band, and best-level touch-ratio breakdowns, so stale/unavailable/available conditions and fragile liquidity/latency zones can be reviewed separately before allowing real trading.

The replay CLI regenerates the dry-run review summary from saved orderbook tapes by rebuilding strategy decision rows and executing accepted plans through the same dry-run executor. This keeps replay evidence aligned with the dashboard report and readiness gates without touching Upbit order APIs.

Strategy evidence includes both `strategyId` and `strategyVersion`. Execution plans are created through the active strategy's `buildExecutionPlan` contract, and rejected depth validation prevents plan creation even when a top-of-book strategy score is profitable.

## Dry-run Gate Configuration

The dry-run evidence thresholds live under `executionPolicy.readinessGuards` in `config/runtime.json`:

- `minimumDryRunSamples`
- `minimumDryRunSamplesPerStartAsset`
- `maxDryRunRejectionRate`
- `minimumDryRunCompleteRate`
- `maxDryRunDepthRejectionRate`
- `maxDryRunLatencyRejectionRate`
- `maxDryRunExpectedSimulatedGapRate`

These values are validated when runtime config loads and are applied by the engine before `REAL_GUARDED` or `REAL_AUTO` can start.

## Safety Defaults

- Default execution mode is `LIMIT_IOC_AT_OBSERVED_BEST`.
- `BEST_IOC` requires `enabledExecutionModes` to include `BEST_IOC` and `executionPolicy.allowBestIoc=true`.
- Dashboard mode buttons queue `Start` with an explicit run mode (`OBSERVE`, `DRY_RUN`, or `REAL_GUARDED`) plus `Pause`, `Stop`, and emergency `Stop`.
- Real order creation is refused while `liveTradingEnabled=false`.
- `Q_GAGARIN_ALLOW_LIVE_TRADING=true` is required before a config with `liveTradingEnabled=true` can load.
- Every real order rejection includes a machine-readable reason such as `MARKET_DATA_STALE`, `ORDER_CHANCE_STALE`, `PRIVATE_WS_DISCONNECTED`, `ORDER_RATE_LIMIT`, or `ORDER_SUBMIT_FAILED`.
- Real execution reprices from validation depth before every leg and emits state transitions such as `LEG_1_PARTIAL`, `REPRICE_BEFORE_LEG_2`, `CYCLE_RESIDUAL`, and `CYCLE_DONE`.
- Real execution caps each submitted order by the configured best-level touch policy before submission; unsubmitted input from that cap is retained as residual asset evidence.
- Real execution submits through `OrderManager`, reserves a unique Upbit `identifier`, enforces the per-second order submission limit, records `order.submitted`, `order.submit_failed`, and `order.ack`, then reconciles through private MyOrder events or REST `getOrder` fallback before the next leg uses the actual filled amount.
- Realized real-run PnL is recorded by start asset and Asia/Seoul trading day. Reaching `maxDailyLossByAsset` triggers emergency stop, moves the engine to `ERROR`, and causes later plan/order guards to reject with `EMERGENCY_STOP_ACTIVE` until the operator stops the engine.
- Execution latency is budgeted separately from dashboard latency. Slow REST ack or order reconciliation rejects the next leg with `ORDER_ACK_LATENCY` or `ORDER_RECONCILIATION_LATENCY`; browser render latency remains display-only and is never a trading input.
- Partial fills follow `executionPolicy.partialFillPolicy`: `CONTINUE_IF_ABOVE_MIN` continues with the actual fill amount when the next leg can satisfy minimum order constraints, while `ABORT_ON_PARTIAL` stops immediately with a residual asset record.

## Execution Modes

- `LIMIT_IOC_AT_OBSERVED_BEST` is the default. It uses validation depth-30 top of book, `ord_type=limit`, and `time_in_force=ioc`.
- `BEST_IOC` is opt-in only and requires both `enabledExecutionModes: ["LIMIT_IOC_AT_OBSERVED_BEST", "BEST_IOC"]` and `executionPolicy.allowBestIoc=true`.
