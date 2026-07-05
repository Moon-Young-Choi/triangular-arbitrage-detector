const crypto = require("node:crypto");

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
        accepted: false,
        reason: row.unavailableReason || row.staleReason || "ORDERBOOK_UNAVAILABLE",
      };
    }

    if (!(row.netProfitRate > minNetProfitRate)) {
      return {
        strategyId: this.id,
        accepted: false,
        reason: "PROFIT_BELOW_THRESHOLD",
      };
    }

    return {
      strategyId: this.id,
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

  buildExecutionPlan() {
    return null;
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
