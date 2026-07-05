const topOfBookBaseline = require("./topOfBookBaseline");
const depthAwareBestIoc = require("./depthAwareBestIoc");

class StrategyRegistry {
  constructor(strategies = []) {
    this.strategies = new Map();

    strategies.forEach((strategy) => {
      this.register(strategy);
    });
  }

  register(strategy) {
    for (const field of ["id", "name", "version", "description", "defaultConfig", "evaluate", "rank", "buildExecutionPlan", "explain"]) {
      if (strategy[field] === undefined) {
        throw new Error(`Strategy is missing ${field}`);
      }
    }

    if (this.strategies.has(strategy.id)) {
      throw new Error(`Duplicate strategy id: ${strategy.id}`);
    }

    this.strategies.set(strategy.id, Object.freeze({ ...strategy }));
  }

  get(id) {
    const strategy = this.strategies.get(id);

    if (!strategy) {
      throw new Error(`Unknown strategy: ${id}`);
    }

    return strategy;
  }

  list() {
    return [...this.strategies.values()].map((strategy) => ({
      id: strategy.id,
      name: strategy.name,
      version: strategy.version,
      hash: strategy.hash || null,
      description: strategy.description,
      defaultConfig: strategy.defaultConfig,
    }));
  }
}

function createStrategyRegistry() {
  return new StrategyRegistry([
    topOfBookBaseline,
    depthAwareBestIoc,
  ]);
}

module.exports = {
  StrategyRegistry,
  createStrategyRegistry,
};
