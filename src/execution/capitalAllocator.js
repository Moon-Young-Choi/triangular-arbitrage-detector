const { DEFAULT_START_ASSETS } = require("../core/startAssetPolicy");

function numericAmount(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function cloneAssetAmounts(values = {}) {
  return Object.fromEntries(
    Object.entries(values).map(([asset, value]) => [asset, numericAmount(value)]),
  );
}

class CapitalAllocator {
  constructor(options = {}) {
    this.allocationPolicy = options.allocationPolicy || "per-start-asset-bucket";
    this.maxAllocatableByAsset = cloneAssetAmounts(options.maxAllocatableByAsset || {});
    this.buckets = new Map();
    this.allocations = new Map();
    this.nextAllocationSequence = 1;
    const assets = [...new Set([
      ...DEFAULT_START_ASSETS,
      ...Object.keys(options.balances || {}),
      ...Object.keys(options.lockedBalances || {}),
      ...Object.keys(this.maxAllocatableByAsset),
    ])];

    for (const asset of assets) {
      this.buckets.set(asset, {
        startAsset: asset,
        availableBalance: numericAmount((options.balances || {})[asset]),
        reservedBalance: 0,
        lockedBalance: numericAmount((options.lockedBalances || {})[asset]),
        residualBalance: numericAmount((options.residualBalances || {})[asset]),
        maxAllocatableAmount: this.maxAllocatableByAsset[asset] ?? null,
        allocationPolicy: this.allocationPolicy,
      });
    }
  }

  ensureBucket(asset) {
    if (!this.buckets.has(asset)) {
      this.buckets.set(asset, {
        startAsset: asset,
        availableBalance: 0,
        reservedBalance: 0,
        lockedBalance: 0,
        residualBalance: 0,
        maxAllocatableAmount: this.maxAllocatableByAsset[asset] ?? null,
        allocationPolicy: this.allocationPolicy,
      });
    }

    return this.buckets.get(asset);
  }

  maxAllocatableAmount(asset) {
    const bucket = this.ensureBucket(asset);
    const configuredMax = bucket.maxAllocatableAmount === null || bucket.maxAllocatableAmount === undefined
      ? null
      : Number(bucket.maxAllocatableAmount);
    const maxByPolicy = Number.isFinite(configuredMax)
      ? Math.min(bucket.availableBalance, configuredMax)
      : bucket.availableBalance;

    return Math.max(0, maxByPolicy);
  }

  previewAllocation({ startAsset, requestedAmount }) {
    const bucket = this.ensureBucket(startAsset);
    const amount = numericAmount(requestedAmount);
    const maxAllocatableAmount = this.maxAllocatableAmount(startAsset);

    if (!(amount > 0)) {
      return {
        ok: false,
        rejectionReason: "INVALID_ALLOCATION_AMOUNT",
        startAsset,
        requestedAmount: amount,
        maxAllocatableAmount,
        bucket: this.snapshotBucket(startAsset),
      };
    }

    if (amount > bucket.availableBalance) {
      return {
        ok: false,
        rejectionReason: "BALANCE_INSUFFICIENT",
        startAsset,
        requestedAmount: amount,
        availableBalance: bucket.availableBalance,
        maxAllocatableAmount,
        bucket: this.snapshotBucket(startAsset),
      };
    }

    if (amount > maxAllocatableAmount) {
      return {
        ok: false,
        rejectionReason: "MAX_ALLOCATABLE_EXCEEDED",
        startAsset,
        requestedAmount: amount,
        maxAllocatableAmount,
        bucket: this.snapshotBucket(startAsset),
      };
    }

    return {
      ok: true,
      startAsset,
      requestedAmount: amount,
      maxAllocatableAmount,
      bucket: this.snapshotBucket(startAsset),
    };
  }

  reserve({ startAsset, amount, planId, cycleId }) {
    const preview = this.previewAllocation({ startAsset, requestedAmount: amount });

    if (!preview.ok) {
      return preview;
    }

    const bucket = this.ensureBucket(startAsset);
    const allocationId = [planId || "plan", cycleId || "cycle", startAsset, this.nextAllocationSequence++].join(":");

    bucket.availableBalance -= preview.requestedAmount;
    bucket.reservedBalance += preview.requestedAmount;
    this.allocations.set(allocationId, {
      allocationId,
      startAsset,
      amount: preview.requestedAmount,
      planId,
      cycleId,
      createdAt: new Date().toISOString(),
    });

    return {
      ok: true,
      allocationId,
      startAsset,
      reservedAmount: preview.requestedAmount,
      bucket: this.snapshotBucket(startAsset),
    };
  }

  release(allocationId) {
    const allocation = this.allocations.get(allocationId);

    if (!allocation) {
      return { ok: false, rejectionReason: "ALLOCATION_NOT_FOUND", allocationId };
    }

    const bucket = this.ensureBucket(allocation.startAsset);
    bucket.reservedBalance = Math.max(0, bucket.reservedBalance - allocation.amount);
    bucket.availableBalance += allocation.amount;
    this.allocations.delete(allocationId);

    return {
      ok: true,
      allocationId,
      startAsset: allocation.startAsset,
      releasedAmount: allocation.amount,
      bucket: this.snapshotBucket(allocation.startAsset),
    };
  }

  settle(allocationId, outputAmount) {
    const allocation = this.allocations.get(allocationId);

    if (!allocation) {
      return { ok: false, rejectionReason: "ALLOCATION_NOT_FOUND", allocationId };
    }

    const bucket = this.ensureBucket(allocation.startAsset);
    const output = numericAmount(outputAmount);

    bucket.reservedBalance = Math.max(0, bucket.reservedBalance - allocation.amount);
    bucket.availableBalance += output;
    this.allocations.delete(allocationId);

    return {
      ok: true,
      allocationId,
      startAsset: allocation.startAsset,
      reservedAmount: allocation.amount,
      outputAmount: output,
      pnl: output - allocation.amount,
      bucket: this.snapshotBucket(allocation.startAsset),
    };
  }

  recordResidual({ asset, amount }) {
    const bucket = this.ensureBucket(asset);
    const residualAmount = numericAmount(amount);

    bucket.residualBalance += residualAmount;

    return {
      ok: true,
      asset,
      residualAmount,
      bucket: this.snapshotBucket(asset),
    };
  }

  availableBalances() {
    return Object.fromEntries(
      [...this.buckets.entries()].map(([asset, bucket]) => [asset, bucket.availableBalance]),
    );
  }

  snapshotBucket(asset) {
    const bucket = this.ensureBucket(asset);

    return { ...bucket };
  }

  snapshot() {
    return {
      allocationPolicy: this.allocationPolicy,
      buckets: Object.fromEntries(
        [...this.buckets.entries()].map(([asset, bucket]) => [asset, { ...bucket }]),
      ),
      openAllocations: [...this.allocations.values()].map((allocation) => ({ ...allocation })),
    };
  }
}

module.exports = {
  CapitalAllocator,
  cloneAssetAmounts,
};
