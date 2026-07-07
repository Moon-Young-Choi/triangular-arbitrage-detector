const test = require("node:test");
const assert = require("node:assert/strict");
const {
  UpbitRateLimitScheduler,
  parseRemainingReq,
} = require("../src/exchanges/upbit/rateLimitScheduler");

test("Upbit rate-limit scheduler preserves FIFO within the same priority", async () => {
  const scheduler = new UpbitRateLimitScheduler({
    groupLimits: {
      orderbook: { perSecond: 10 },
    },
  });
  const calls = [];

  await Promise.all([
    scheduler.scheduleRest("orderbook", "normal", "first", async () => {
      calls.push("first");
      return { data: 1 };
    }),
    scheduler.scheduleRest("orderbook", "normal", "second", async () => {
      calls.push("second");
      return { data: 2 };
    }),
  ]);

  assert.deepEqual(calls, ["first", "second"]);
  scheduler.stop();
});

test("Upbit rate-limit scheduler prioritizes critical work ahead of warmup work", async () => {
  const scheduler = new UpbitRateLimitScheduler({
    groupLimits: {
      orderbook: { perSecond: 1 },
    },
  });
  const calls = [];

  const first = scheduler.scheduleRest("orderbook", "warmup", "first", async () => {
    calls.push("first");
    return { data: 1 };
  });
  const warmup = scheduler.scheduleRest("orderbook", "warmup", "warmup", async () => {
    calls.push("warmup");
    return { data: 2 };
  });
  const critical = scheduler.scheduleRest("orderbook", "critical", "critical", async () => {
    calls.push("critical");
    return { data: 3 };
  });

  await Promise.all([first, warmup, critical]);
  assert.deepEqual(calls, ["first", "critical", "warmup"]);
  scheduler.stop();
});

test("Upbit order capacity reservations require three available order slots", () => {
  const scheduler = new UpbitRateLimitScheduler({
    groupLimits: {
      order: { perSecond: 8 },
    },
    orderReservationTtlMs: 1000,
  });

  const reservation = scheduler.reserveOrderCapacity({ count: 3, traceId: "plan-1" });
  assert.equal(scheduler.orderCapacitySnapshot().reserved, 3);
  assert.equal(scheduler.orderCapacitySnapshot().available, 5);
  assert.throws(
    () => scheduler.reserveOrderCapacity({ count: 6, traceId: "plan-2" }),
    /ORDER_CAPACITY_UNAVAILABLE/,
  );

  reservation.commit();
  assert.equal(reservation.remaining, 2);
  reservation.release();
  assert.equal(scheduler.orderCapacitySnapshot().reserved, 0);
  scheduler.stop();
});

test("Remaining-Req parser extracts Upbit group and second capacity", () => {
  assert.deepEqual(parseRemainingReq("group=default; min=1800; sec=29"), {
    group: "default",
    min: 1800,
    sec: 29,
  });
});
