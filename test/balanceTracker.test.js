const test = require("node:test");
const assert = require("node:assert/strict");
const { BalanceTracker, normalizeAccount } = require("../src/execution/balanceTracker");

test("balance tracker normalizes available and locked account balances", () => {
  assert.deepEqual(normalizeAccount({
    currency: "KRW",
    balance: "1000.5",
    locked: "25",
    avg_buy_price: "0",
    unit_currency: "KRW",
  }), {
    asset: "KRW",
    availableBalance: 1000.5,
    lockedBalance: 25,
    avgBuyPrice: "0",
    unitCurrency: "KRW",
  });

  const tracker = new BalanceTracker({
    accounts: [
      { currency: "KRW", balance: "1000", locked: "10" },
      { currency: "BTC", balance: "0.1", locked: "0.02" },
    ],
  });
  const snapshot = tracker.snapshot();

  assert.equal(snapshot.accounts.KRW.availableBalance, 1000);
  assert.equal(snapshot.accounts.KRW.lockedBalance, 10);
  assert.equal(snapshot.availableBalances.BTC, 0.1);
  assert.equal(snapshot.lockedBalances.BTC, 0.02);
  assert.equal(snapshot.accounts.USDT.availableBalance, 0);
  assert.ok(snapshot.updatedAt);
});

test("balance tracker records residual assets separately from exchange balances", () => {
  const tracker = new BalanceTracker({
    accounts: [
      { currency: "KRW", balance: "1000", locked: "10" },
    ],
  });

  const recorded = tracker.recordResidual({
    asset: "BTC",
    amount: "0.001",
    planId: "plan-residual",
    cycleId: "cycle-residual",
    startAsset: "KRW",
    legIndex: 1,
    reason: "PARTIAL_FILL_ABORTED_BY_POLICY",
  });
  const snapshot = tracker.snapshot();

  assert.equal(recorded.ok, true);
  assert.equal(snapshot.accounts.BTC.availableBalance, 0);
  assert.equal(snapshot.residualBalances.BTC, 0.001);
  assert.equal(snapshot.availableBalances.BTC, 0);
  assert.equal(snapshot.residualEvents.length, 1);
  assert.equal(snapshot.residualEvents[0].type, "position.residual_recorded");
  assert.equal(snapshot.residualEvents[0].reason, "PARTIAL_FILL_ABORTED_BY_POLICY");
});
