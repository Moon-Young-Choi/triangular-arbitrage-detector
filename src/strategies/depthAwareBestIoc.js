const crypto = require("node:crypto");

const strategy = {
  id: "depthAwareBestIoc",
  name: "Depth-aware best IOC",
  version: "0.1.0",
  description: "Skeleton strategy for depth-validated limit IOC plans at observed best price.",
  defaultConfig: {
    requireDepthValidation: true,
  },

  evaluate(context) {
    const validation = context.depthValidation;

    if (!validation || validation.validationStatus !== "accepted") {
      return {
        strategyId: this.id,
        accepted: false,
        reason: validation ? validation.validationReason : "VALIDATION_UNAVAILABLE",
      };
    }

    return {
      strategyId: this.id,
      accepted: true,
      reason: "DEPTH_VALIDATED",
    };
  },

  rank(rows) {
    return [...rows].sort((left, right) => {
      const leftValue = Number.isFinite(left.netProfitRate) ? left.netProfitRate : -Infinity;
      const rightValue = Number.isFinite(right.netProfitRate) ? right.netProfitRate : -Infinity;

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
