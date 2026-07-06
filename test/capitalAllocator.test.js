const test = require("node:test");
const assert = require("node:assert/strict");
const { CapitalAllocator } = require("../src/execution/capitalAllocator");

test("capital allocator reserves and settles per start-asset bucket", () => {
  const allocator = new CapitalAllocator({
    balances: { KRW: 10000, BTC: 0.1 },
    maxAllocatableByAsset: { KRW: 5000 },
  });

  assert.equal(
    allocator.previewAllocation({ startAsset: "KRW", requestedAmount: 6000 }).rejectionReason,
    "MAX_ALLOCATABLE_EXCEEDED",
  );

  const reserved = allocator.reserve({
    startAsset: "KRW",
    amount: 4000,
    planId: "plan-a",
    cycleId: "cycle-a",
  });

  assert.equal(reserved.ok, true);
  assert.equal(allocator.snapshot().buckets.KRW.availableBalance, 6000);
  assert.equal(allocator.snapshot().buckets.KRW.reservedBalance, 4000);

  const settled = allocator.settle(reserved.allocationId, 4300);

  assert.equal(settled.pnl, 300);
  assert.equal(allocator.snapshot().buckets.KRW.availableBalance, 10300);
  assert.equal(allocator.snapshot().buckets.KRW.reservedBalance, 0);
});

test("capital allocator releases failed allocations and tracks residuals", () => {
  const allocator = new CapitalAllocator({
    balances: { USDT: 100 },
  });
  const reserved = allocator.reserve({
    startAsset: "USDT",
    amount: 20,
    planId: "plan-b",
    cycleId: "cycle-b",
  });

  assert.equal(allocator.snapshot().buckets.USDT.availableBalance, 80);
  allocator.release(reserved.allocationId);
  allocator.recordResidual({ asset: "BTC", amount: 0.001 });

  assert.equal(allocator.snapshot().buckets.USDT.availableBalance, 100);
  assert.equal(allocator.snapshot().buckets.USDT.reservedBalance, 0);
  assert.equal(allocator.snapshot().buckets.BTC.residualBalance, 0.001);
});
