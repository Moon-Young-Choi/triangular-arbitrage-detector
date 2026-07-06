const crypto = require("node:crypto");
const { buildExecutionPlan } = require("../execution/executionPlan");

const strategy = {
  id: "topOfBookBaseline",
  name: "Top-of-book baseline",
  version: "1.0.0",
  description: "Ranks existing top-of-book gross/net multipliers without submitting orders.",
  defaultConfig: {
    minNetProfitRate: 0,
  },

  evaluate(context) {
    const row = context.row || {};
    const minNetProfitRate = Number(
      context.config && context.config.minNetProfitRate !== undefined
        ? context.config.minNetProfitRate
        : this.defaultConfig.minNetProfitRate,
    );

    if (row.status !== "available") {
      return {
        strategyId: this.id,
        strategyVersion: this.version,
        accepted: false,
        reason: row.unavailableReason || row.staleReason || "ORDERBOOK_UNAVAILABLE",
      };
    }

    if (!(row.netProfitRate > minNetProfitRate)) {
      return {
        strategyId: this.id,
        strategyVersion: this.version,
        accepted: false,
        reason: "PROFIT_BELOW_THRESHOLD",
      };
    }

    return {
      strategyId: this.id,
      strategyVersion: this.version,
      accepted: true,
      reason: "TOP_OF_BOOK_PROFITABLE",
    };
  },

  rank(rows) {
    return [...rows].sort((left, right) => {
      const leftValue = Number.isFinite(left.netMultiplier) ? left.netMultiplier : -Infinity;
      const rightValue = Number.isFinite(right.netMultiplier) ? right.netMultiplier : -Infinity;

      return rightValue - leftValue || String(left.routeLabel).localeCompare(String(right.routeLabel));
    });
  },

  buildExecutionPlan(context = {}) {
    const decision = context.decision || this.evaluate(context);
    const row = context.row || {};
    const validation = context.depthValidation || {};

    if (!decision.accepted) {
      return null;
    }

    if (validation.validationStatus !== "accepted" && row.validationStatus !== "accepted") {
      return null;
    }

    return buildExecutionPlan({
      ...context,
      row: {
        ...row,
        strategyId: decision.strategyId,
        strategyVersion: decision.strategyVersion,
        strategyAccepted: decision.accepted,
        strategyReason: decision.reason,
      },
    });
  },

  explain(decision) {
    return decision.reason;
  },
};

strategy.hash = crypto
  .createHash("sha256")
  .update(`${strategy.id}:${strategy.version}:${strategy.description}`)
  .digest("hex")
  .slice(0, 12);

module.exports = strategy;
