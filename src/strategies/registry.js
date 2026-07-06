const topOfBookBaseline = require("./topOfBookBaseline");
const depthAwareLimitIoc = require("./depthAwareLimitIoc");

class StrategyRegistry {
  constructor(strategies = []) {
    this.strategies = new Map();
    this.aliases = new Map();

    strategies.forEach((strategy) => {
      this.register(strategy);
    });
  }

  register(strategy) {
    for (const field of ["id", "name", "version", "description", "defaultConfig"]) {
      if (strategy[field] === undefined) {
        throw new Error(`Strategy is missing ${field}`);
      }
    }

    for (const field of ["evaluate", "rank", "buildExecutionPlan", "explain"]) {
      if (typeof strategy[field] !== "function") {
        throw new Error(`Strategy ${strategy.id || "unknown"} must implement ${field}()`);
      }
    }

    if (this.strategies.has(strategy.id)) {
      throw new Error(`Duplicate strategy id: ${strategy.id}`);
    }

    if (this.aliases.has(strategy.id)) {
      throw new Error(`Strategy id collides with alias: ${strategy.id}`);
    }

    const aliases = Array.isArray(strategy.aliases) ? [...strategy.aliases] : [];
    aliases.forEach((alias) => {
      if (typeof alias !== "string" || alias.trim() === "") {
        throw new Error(`Strategy ${strategy.id} has an invalid alias`);
      }

      if (this.strategies.has(alias) || this.aliases.has(alias)) {
        throw new Error(`Duplicate strategy alias: ${alias}`);
      }
    });

    const frozen = Object.freeze({ ...strategy, aliases });

    this.strategies.set(strategy.id, frozen);
    aliases.forEach((alias) => {
      this.aliases.set(alias, strategy.id);
    });
  }

  get(id) {
    const strategy = this.strategies.get(id) || this.strategies.get(this.aliases.get(id));

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
    depthAwareLimitIoc,
  ]);
}

module.exports = {
  StrategyRegistry,
  createStrategyRegistry,
};
