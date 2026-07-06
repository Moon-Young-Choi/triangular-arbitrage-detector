const { RealExecutor } = require("../execution/realExecutor");

function nsFromMs(ms) {
  return String(Math.round(Number(ms || 0) * 1e6));
}

function addNs(startNs, deltaMs) {
  return String(BigInt(startNs) + BigInt(Math.round(Number(deltaMs || 0) * 1e6)));
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function memoryLogStore(events) {
  return {
    append(kind, payload) {
      events.push({ kind, ...payload });
      return Promise.resolve(payload);
    },
  };
}

function defaultLegScenario() {
  return {
    fillRatio: 1,
    ackDelayMs: 1,
    reconciliationDelayMs: 1,
    privateWsFillDelayMs: null,
    source: "rest-query",
    paidFee: 0,
  };
}

function scenarioForLeg(scenario = {}, legIndex) {
  const leg = Array.isArray(scenario.legs) ? scenario.legs[legIndex - 1] : null;
  return {
    ...defaultLegScenario(),
    ...(scenario.defaultLeg || {}),
    ...(leg || {}),
  };
}

function fillOrderFromScenario(order, ack, legScenario) {
  const requestedVolume = numeric(order.volume, 0);
  const fillRatio = Math.max(0, Math.min(1, numeric(legScenario.fillRatio, 1)));
  const executedVolume = legScenario.executedVolume !== undefined
    ? numeric(legScenario.executedVolume, 0)
    : requestedVolume * fillRatio;
  const remainingVolume = legScenario.remainingVolume !== undefined
    ? numeric(legScenario.remainingVolume, 0)
    : Math.max(0, requestedVolume - executedVolume);

  return {
    uuid: ack.uuid,
    identifier: ack.identifier,
    market: order.market,
    side: order.side,
    state: executedVolume > 0 && remainingVolume <= 0 ? "done" : "trade",
    price: order.price,
    volume: String(requestedVolume),
    executed_volume: String(executedVolume),
    remaining_volume: String(remainingVolume),
    avg_price: String(legScenario.avgPrice || order.price || order.observedBestPrice || 0),
    paid_fee: String(legScenario.paidFee || 0),
    trade_fee: String(legScenario.tradeFee || legScenario.paidFee || 0),
  };
}

function createReplayOrderManager(scenario = {}, events = []) {
  let legIndex = 0;
  let baseNs = BigInt(1_000_000);

  return {
    createIdentifier() {
      return `replay-leg-${legIndex + 1}`;
    },

    async submitOrder(order) {
      legIndex += 1;
      const legScenario = scenarioForLeg(scenario, legIndex);
      const orderSubmitStartPerfNs = String(baseNs);
      const orderAckPerfNs = addNs(orderSubmitStartPerfNs, legScenario.ackDelayMs);
      const ack = {
        uuid: `replay-uuid-${legIndex}`,
        identifier: order.identifier,
        market: order.market,
        state: "wait",
      };

      events.push({
        type: "replay.order_submitted",
        legIndex,
        order,
        ackDelayMs: legScenario.ackDelayMs,
      });

      return {
        identifier: order.identifier,
        order,
        ack,
        orderSubmitStartPerfNs,
        orderAckPerfNs,
      };
    },

    async reconcileSubmittedOrder({ orderAck, submittedOrder }) {
      const legScenario = scenarioForLeg(scenario, legIndex);
      const order = fillOrderFromScenario(submittedOrder, orderAck, legScenario);
      const reconciliationStartedPerfNs = addNs(nsFromMs(Number(baseNs) / 1e6), legScenario.ackDelayMs);
      const reconciliationDonePerfNs = addNs(reconciliationStartedPerfNs, legScenario.reconciliationDelayMs);
      const privateWsFillReceivePerfNs = legScenario.privateWsFillDelayMs === null ||
        legScenario.privateWsFillDelayMs === undefined
        ? null
        : addNs(String(baseNs), legScenario.privateWsFillDelayMs);
      const orderQueryDonePerfNs = legScenario.source === "rest-query"
        ? reconciliationDonePerfNs
        : null;

      events.push({
        type: "replay.order_reconciled",
        legIndex,
        source: legScenario.source,
        fillRatio: legScenario.fillRatio,
        reconciliationDelayMs: legScenario.reconciliationDelayMs,
      });
      baseNs += BigInt(100_000_000);

      return {
        order,
        source: legScenario.source,
        timedOut: legScenario.source !== "private-ws",
        restQueried: legScenario.source === "rest-query",
        reconciliationStartedPerfNs,
        reconciliationDonePerfNs,
        orderQueryDonePerfNs,
        privateWsFillReceivePerfNs,
      };
    },
  };
}

function replayMarketPolicy(market) {
  return {
    market: {
      id: market,
      bid: { min_total: "0" },
      ask: { min_total: "0" },
      min_total: "0",
    },
  };
}

async function replayRealExecution(plan, options = {}) {
  const events = [];
  const runtimeConfig = {
    ...(options.runtimeConfig || {}),
    liveTradingEnabled: true,
  };
  const logEvents = [];
  const executor = new RealExecutor({
    liveTradingEnabled: true,
    runtimeConfig,
    logStore: memoryLogStore(logEvents),
    restClient: {},
    marketPolicyProvider: options.marketPolicyProvider || replayMarketPolicy,
    orderManager: createReplayOrderManager(options.scenario || {}, events),
  });
  const result = await executor.execute(plan, {
    privateWsConnected: options.privateWsConnected !== false,
    orderChanceFresh: options.orderChanceFresh !== false,
    accountBalanceFresh: options.accountBalanceFresh !== false,
    validationDepthFresh: options.validationDepthFresh !== false,
    getValidationOrderbooks: options.getValidationOrderbooks,
  });

  return {
    result,
    replayEvents: events,
    logEvents,
  };
}

module.exports = {
  createReplayOrderManager,
  replayRealExecution,
};
