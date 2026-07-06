const { DEFAULT_START_ASSETS } = require("../core/startAssetPolicy");

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeAccount(account = {}) {
  const asset = account.currency || account.asset;

  return {
    asset,
    availableBalance: safeNumber(account.balance ?? account.availableBalance),
    lockedBalance: safeNumber(account.locked ?? account.lockedBalance),
    avgBuyPrice: account.avg_buy_price ?? account.avgBuyPrice ?? null,
    unitCurrency: account.unit_currency ?? account.unitCurrency ?? null,
  };
}

class BalanceTracker {
  constructor(options = {}) {
    this.startAssets = options.startAssets || DEFAULT_START_ASSETS;
    this.accounts = new Map();
    this.residualBalancesByAsset = new Map();
    this.residualEvents = [];
    this.maxResidualEvents = options.maxResidualEvents || 100;
    this.updatedAt = null;

    if (Object.hasOwn(options, "accounts")) {
      this.updateFromAccounts(options.accounts || []);
    } else {
      for (const asset of this.startAssets) {
        this.accounts.set(asset, {
          asset,
          availableBalance: 0,
          lockedBalance: 0,
          avgBuyPrice: null,
          unitCurrency: null,
        });
      }
    }

    for (const [asset, amount] of Object.entries(options.residualBalances || {})) {
      this.residualBalancesByAsset.set(asset, safeNumber(amount));
    }
  }

  updateFromAccounts(accounts = [], updatedAt = new Date().toISOString()) {
    this.accounts.clear();

    for (const account of accounts) {
      const normalized = normalizeAccount(account);
      if (normalized.asset) {
        this.accounts.set(normalized.asset, normalized);
      }
    }

    for (const asset of this.startAssets) {
      if (!this.accounts.has(asset)) {
        this.accounts.set(asset, {
          asset,
          availableBalance: 0,
          lockedBalance: 0,
          avgBuyPrice: null,
          unitCurrency: null,
        });
      }
    }

    this.updatedAt = updatedAt;
    return this.snapshot();
  }

  availableBalances() {
    return Object.fromEntries(
      [...this.accounts.entries()].map(([asset, account]) => [asset, account.availableBalance]),
    );
  }

  lockedBalances() {
    return Object.fromEntries(
      [...this.accounts.entries()].map(([asset, account]) => [asset, account.lockedBalance]),
    );
  }

  residualBalances() {
    return Object.fromEntries(
      [...this.residualBalancesByAsset.entries()].map(([asset, amount]) => [asset, amount]),
    );
  }

  recordResidual(input = {}) {
    const asset = input.asset || input.residualAsset;
    const amount = safeNumber(input.amount ?? input.residualAmount);

    if (!asset || !(amount > 0)) {
      return {
        ok: false,
        rejectionReason: "INVALID_RESIDUAL",
        asset,
        amount,
      };
    }

    if (!this.accounts.has(asset)) {
      this.accounts.set(asset, {
        asset,
        availableBalance: 0,
        lockedBalance: 0,
        avgBuyPrice: null,
        unitCurrency: null,
      });
    }

    const previous = this.residualBalancesByAsset.get(asset) || 0;
    const next = previous + amount;
    const event = {
      type: "position.residual_recorded",
      asset,
      amount,
      balance: next,
      planId: input.planId,
      cycleId: input.cycleId,
      startAsset: input.startAsset,
      strategyId: input.strategyId,
      legIndex: input.legIndex,
      reason: input.reason || null,
      source: input.source || "real-execution",
      recordedAt: input.recordedAt || new Date().toISOString(),
    };

    this.residualBalancesByAsset.set(asset, next);
    this.residualEvents.push(event);

    if (this.residualEvents.length > this.maxResidualEvents) {
      this.residualEvents = this.residualEvents.slice(-this.maxResidualEvents);
    }

    return {
      ok: true,
      asset,
      residualAmount: amount,
      residualBalance: next,
      event,
    };
  }

  snapshot() {
    return {
      updatedAt: this.updatedAt,
      accounts: Object.fromEntries(
        [...this.accounts.entries()].map(([asset, account]) => [asset, { ...account }]),
      ),
      availableBalances: this.availableBalances(),
      lockedBalances: this.lockedBalances(),
      residualBalances: this.residualBalances(),
      residualEvents: this.residualEvents.slice(),
    };
  }
}

module.exports = {
  BalanceTracker,
  normalizeAccount,
};
