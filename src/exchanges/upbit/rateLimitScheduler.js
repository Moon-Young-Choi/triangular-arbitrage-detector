const crypto = require("node:crypto");

const PRIORITY_WEIGHT = Object.freeze({
  critical: 0,
  trading: 1,
  normal: 2,
  warmup: 3,
});

const DEFAULT_GROUP_LIMITS = Object.freeze({
  market: { perSecond: 10 },
  candle: { perSecond: 10 },
  trade: { perSecond: 10 },
  ticker: { perSecond: 10 },
  orderbook: { perSecond: 10 },
  "exchange.default": { perSecond: 30 },
  order: { perSecond: 8 },
  "order-test": { perSecond: 8 },
  "order-cancel-all": { perSecond: 0.5 },
  "websocket-connect": { perSecond: 5 },
  "websocket-message": { perSecond: 5, perMinute: 100 },
});

const PATH_GROUP_RULES = [
  { method: "POST", pattern: /^\/orders$/u, group: "order" },
  { method: "POST", pattern: /^\/orders\/test$/u, group: "order-test" },
  { method: "DELETE", pattern: /^\/orders\/open$/u, group: "order-cancel-all" },
  { method: "*", pattern: /^\//u, group: "exchange.default" },
];

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nowSecond(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000);
}

function nowMinute(nowMs = Date.now()) {
  return Math.floor(nowMs / 60000);
}

function normalizePriority(priority) {
  const normalized = String(priority || "normal").toLowerCase();
  return Object.prototype.hasOwnProperty.call(PRIORITY_WEIGHT, normalized) ? normalized : "normal";
}

function parseRetryAfterMs(headers = {}, fallbackMs = 1000) {
  const value = headers["retry-after"] || headers["Retry-After"];
  if (value === undefined || value === null) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(fallbackMs, seconds * 1000);
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return Math.max(fallbackMs, timestamp - Date.now());
  return fallbackMs;
}

function parseRemainingReq(header) {
  if (!header || typeof header !== "string") return null;
  const fields = {};
  for (const part of header.split(";")) {
    const [rawKey, rawValue] = part.split("=");
    const key = String(rawKey || "").trim();
    const value = String(rawValue || "").trim();
    if (key) fields[key] = value;
  }
  return {
    group: fields.group || null,
    sec: Number.isFinite(Number(fields.sec)) ? Number(fields.sec) : null,
    min: Number.isFinite(Number(fields.min)) ? Number(fields.min) : null,
  };
}

function groupForExchangeRequest(method, pathname) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const normalizedPath = String(pathname || "/");
  const rule = PATH_GROUP_RULES.find((entry) => (
    (entry.method === "*" || entry.method === normalizedMethod) &&
    entry.pattern.test(normalizedPath)
  ));
  return rule ? rule.group : "exchange.default";
}

class RateLimitGroup {
  constructor(name, config = {}) {
    this.name = name;
    this.perSecond = Number(config.perSecond || 0);
    this.perMinute = Number(config.perMinute || 0);
    this.queue = [];
    this.inFlight = 0;
    this.sequence = 0;
    this.secondBucket = nowSecond();
    this.secondUsed = 0;
    this.minuteBucket = nowMinute();
    this.minuteUsed = 0;
    this.remainingSec = null;
    this.remainingSecUpdatedAt = null;
    this.cooldownUntil = 0;
    this.processing = false;
  }

  enqueue(task) {
    const entry = {
      ...task,
      priority: normalizePriority(task.priority),
      sequence: this.sequence,
    };
    this.sequence += 1;
    this.queue.push(entry);
    return entry;
  }

  hasCapacity(nowMs = Date.now()) {
    this.rollBuckets(nowMs);
    if (nowMs < this.cooldownUntil) return false;
    if (this.perSecond > 0 && this.secondUsed >= this.perSecond) return false;
    if (this.perMinute > 0 && this.minuteUsed >= this.perMinute) return false;
    if (this.remainingSec !== null && this.remainingSec <= 0) return false;
    return true;
  }

  consume(nowMs = Date.now()) {
    this.rollBuckets(nowMs);
    this.secondUsed += 1;
    this.minuteUsed += 1;
    if (this.remainingSec !== null) {
      this.remainingSec = Math.max(0, this.remainingSec - 1);
    }
  }

  nextDelayMs(nowMs = Date.now()) {
    this.rollBuckets(nowMs);
    if (nowMs < this.cooldownUntil) return Math.max(1, this.cooldownUntil - nowMs);
    if (this.perSecond > 0 && this.secondUsed >= this.perSecond) {
      return Math.max(1, (this.secondBucket + 1) * 1000 - nowMs);
    }
    if (this.remainingSec !== null && this.remainingSec <= 0) {
      return Math.max(1, (nowSecond(nowMs) + 1) * 1000 - nowMs);
    }
    if (this.perMinute > 0 && this.minuteUsed >= this.perMinute) {
      return Math.max(1, (this.minuteBucket + 1) * 60000 - nowMs);
    }
    return 1;
  }

  rollBuckets(nowMs = Date.now()) {
    const second = nowSecond(nowMs);
    if (second !== this.secondBucket) {
      this.secondBucket = second;
      this.secondUsed = 0;
      this.remainingSec = null;
      this.remainingSecUpdatedAt = null;
    }

    const minute = nowMinute(nowMs);
    if (minute !== this.minuteBucket) {
      this.minuteBucket = minute;
      this.minuteUsed = 0;
    }
  }

  updateRemaining(remaining, nowMs = Date.now()) {
    if (!remaining || remaining.sec === null) return;
    this.rollBuckets(nowMs);
    this.remainingSec = Math.max(0, remaining.sec);
    this.remainingSecUpdatedAt = nowMs;
  }

  applyCooldown(durationMs, nowMs = Date.now()) {
    const duration = Math.max(0, Number(durationMs) || 0);
    this.cooldownUntil = Math.max(this.cooldownUntil, nowMs + duration);
  }

  pickNext() {
    if (this.queue.length === 0) return null;
    let bestIndex = 0;
    let best = this.queue[0];

    for (let index = 1; index < this.queue.length; index += 1) {
      const candidate = this.queue[index];
      const candidateWeight = PRIORITY_WEIGHT[candidate.priority];
      const bestWeight = PRIORITY_WEIGHT[best.priority];
      if (
        candidateWeight < bestWeight ||
        (candidateWeight === bestWeight && candidate.sequence < best.sequence)
      ) {
        best = candidate;
        bestIndex = index;
      }
    }

    this.queue.splice(bestIndex, 1);
    return best;
  }

  snapshot(nowMs = Date.now()) {
    this.rollBuckets(nowMs);
    const queuedByPriority = {};
    for (const item of this.queue) {
      queuedByPriority[item.priority] = (queuedByPriority[item.priority] || 0) + 1;
    }
    return {
      group: this.name,
      queued: this.queue.length,
      queuedByPriority,
      inFlight: this.inFlight,
      perSecond: this.perSecond,
      perMinute: this.perMinute || null,
      secondUsed: this.secondUsed,
      minuteUsed: this.minuteUsed,
      remainingSec: this.remainingSec,
      cooldownUntil: this.cooldownUntil ? new Date(this.cooldownUntil).toISOString() : null,
      cooldownMs: Math.max(0, this.cooldownUntil - nowMs),
    };
  }
}

class OrderCapacityReservation {
  constructor(scheduler, options = {}) {
    this.scheduler = scheduler;
    this.id = options.id || crypto.randomUUID();
    this.count = options.count;
    this.remaining = options.count;
    this.traceId = options.traceId || this.id;
    this.cycleId = options.cycleId || null;
    this.createdAtMs = Date.now();
    this.expiresAtMs = this.createdAtMs + Math.max(1, Number(options.ttlMs) || 3000);
    this.firstCommittedAtMs = null;
    this.released = false;
  }

  commit(count = 1) {
    if (this.released) {
      const error = new Error("ORDER_CAPACITY_RESERVATION_RELEASED");
      error.code = "ORDER_CAPACITY_RESERVATION_RELEASED";
      throw error;
    }
    const amount = Math.max(1, Number(count) || 1);
    if (this.remaining < amount) {
      const error = new Error("ORDER_CAPACITY_RESERVATION_EXHAUSTED");
      error.code = "ORDER_CAPACITY_RESERVATION_EXHAUSTED";
      throw error;
    }
    if (this.firstCommittedAtMs === null) {
      this.firstCommittedAtMs = Date.now();
    }
    this.remaining -= amount;
    if (this.remaining === 0) {
      this.release();
    }
    return this.remaining;
  }

  release() {
    if (this.released) return false;
    this.released = true;
    this.scheduler.releaseOrderCapacity(this.id);
    return true;
  }

  snapshot(nowMs = Date.now()) {
    return {
      id: this.id,
      count: this.count,
      remaining: this.remaining,
      traceId: this.traceId,
      cycleId: this.cycleId,
      createdAt: new Date(this.createdAtMs).toISOString(),
      expiresAt: new Date(this.expiresAtMs).toISOString(),
      firstCommittedAt: this.firstCommittedAtMs ? new Date(this.firstCommittedAtMs).toISOString() : null,
      expired: this.firstCommittedAtMs === null && nowMs >= this.expiresAtMs,
      released: this.released,
    };
  }
}

class UpbitRateLimitScheduler {
  constructor(options = {}) {
    const groupLimits = {
      ...DEFAULT_GROUP_LIMITS,
      ...(options.groupLimits || {}),
    };
    this.groups = new Map(
      Object.entries(groupLimits).map(([name, config]) => [name, new RateLimitGroup(name, config)]),
    );
    this.recentThrottles = [];
    this.orderReservations = new Map();
    this.orderReservationTtlMs = Number(options.orderReservationTtlMs || 3000);
    this.maxRecentThrottles = Number(options.maxRecentThrottles || 50);
    this.retryJitterMs = Number(options.retryJitterMs || 100);
    this.stopped = false;
  }

  ensureGroup(group) {
    const name = group || "exchange.default";
    if (!this.groups.has(name)) {
      const config = name.startsWith("websocket-message:")
        ? DEFAULT_GROUP_LIMITS["websocket-message"]
        : DEFAULT_GROUP_LIMITS[name] || { perSecond: 1 };
      this.groups.set(name, new RateLimitGroup(name, config));
    }
    return this.groups.get(name);
  }

  enqueue(options = {}) {
    const groupName = options.group || "exchange.default";
    const group = this.ensureGroup(groupName);
    const task = group.enqueue({
      priority: options.priority || "normal",
      operation: options.operation || groupName,
      metadata: options.metadata || {},
      execute: options.execute,
      resolve: null,
      reject: null,
    });

    const promise = new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
    });

    this.processGroup(group);
    return promise;
  }

  async processGroup(group) {
    if (group.processing || this.stopped) return;
    group.processing = true;

    try {
      while (!this.stopped && group.queue.length > 0) {
        const nowMs = Date.now();
        if (!group.hasCapacity(nowMs)) {
          await sleep(group.nextDelayMs(nowMs));
          continue;
        }

        const task = group.pickNext();
        if (!task) continue;
        group.consume(Date.now());
        group.inFlight += 1;

        try {
          const result = await task.execute();
          this.observeResponse(group.name, result);
          task.resolve(result);
        } catch (error) {
          this.observeError(group.name, error);
          task.reject(error);
        } finally {
          group.inFlight = Math.max(0, group.inFlight - 1);
        }
      }
    } finally {
      group.processing = false;
      if (!this.stopped && group.queue.length > 0) {
        setTimeout(() => this.processGroup(group), group.nextDelayMs());
      }
    }
  }

  schedule(group, priority, operation, execute, metadata = {}) {
    return this.enqueue({ group, priority, operation, execute, metadata });
  }

  scheduleRest(group, priority, operation, execute, metadata = {}) {
    return this.enqueue({ group, priority, operation, execute, metadata });
  }

  scheduleWebSocketConnect(priority, operation, execute, metadata = {}) {
    return this.enqueue({
      group: "websocket-connect",
      priority,
      operation,
      execute,
      metadata,
    });
  }

  scheduleWebSocketMessage(connectionKey, priority, operation, execute, metadata = {}) {
    return this.enqueue({
      group: connectionKey ? `websocket-message:${connectionKey}` : "websocket-message",
      priority,
      operation,
      execute,
      metadata: {
        connectionKey,
        ...metadata,
      },
    });
  }

  observeResponse(groupName, response) {
    const headers = response && response.headers;
    const remainingHeader = headers && (headers["remaining-req"] || headers["Remaining-Req"]);
    const remaining = parseRemainingReq(remainingHeader);
    if (!remaining) return;
    const targetGroup = remaining.group === "default"
      ? "exchange.default"
      : remaining.group || groupName;
    this.ensureGroup(targetGroup).updateRemaining(remaining);
  }

  observeError(groupName, error) {
    const status = error && error.response && error.response.status;
    if (status !== 429 && status !== 418) return;
    const group = this.ensureGroup(groupName);
    const fallbackMs = status === 418 ? 10000 : 1000;
    const retryAfterMs = parseRetryAfterMs(error.response.headers || {}, fallbackMs);
    const jitter = Math.floor(Math.random() * Math.max(1, this.retryJitterMs));
    group.applyCooldown(retryAfterMs + jitter);
    this.recentThrottles.push({
      group: groupName,
      status,
      at: new Date().toISOString(),
      cooldownMs: retryAfterMs + jitter,
      message: error.message,
    });
    if (this.recentThrottles.length > this.maxRecentThrottles) {
      this.recentThrottles.splice(0, this.recentThrottles.length - this.maxRecentThrottles);
    }
  }

  orderCapacitySnapshot(nowMs = Date.now()) {
    this.expireOrderReservations(nowMs);
    const group = this.ensureGroup("order");
    group.rollBuckets(nowMs);
    const limit = Math.max(0, group.perSecond);
    const reserved = [...this.orderReservations.values()]
      .reduce((sum, reservation) => sum + Math.max(0, reservation.remaining), 0);
    const queued = group.queue.length + group.inFlight;
    const available = Math.max(0, limit - group.secondUsed - reserved - queued);
    return {
      limitPerSecond: limit,
      secondUsed: group.secondUsed,
      available,
      reserved,
      queued,
      ttlMs: this.orderReservationTtlMs,
      reservations: [...this.orderReservations.values()].map((reservation) => reservation.snapshot(nowMs)),
    };
  }

  reserveOrderCapacity(options = {}) {
    const count = Math.max(1, Number(options.count || 1));
    const ttlMs = Number(options.ttlMs || this.orderReservationTtlMs);
    const nowMs = Date.now();
    const capacity = this.orderCapacitySnapshot(nowMs);
    if (capacity.available < count) {
      const error = new Error("ORDER_CAPACITY_UNAVAILABLE");
      error.code = "ORDER_CAPACITY_UNAVAILABLE";
      error.available = capacity.available;
      error.required = count;
      throw error;
    }

    const reservation = new OrderCapacityReservation(this, {
      id: options.id,
      count,
      ttlMs,
      traceId: options.traceId,
      cycleId: options.cycleId,
    });
    this.orderReservations.set(reservation.id, reservation);
    return reservation;
  }

  releaseOrderCapacity(id) {
    return this.orderReservations.delete(id);
  }

  expireOrderReservations(nowMs = Date.now()) {
    for (const [id, reservation] of this.orderReservations.entries()) {
      if (
        reservation.released ||
        (reservation.firstCommittedAtMs === null && nowMs >= reservation.expiresAtMs)
      ) {
        reservation.released = true;
        this.orderReservations.delete(id);
      }
    }
  }

  stop() {
    this.stopped = true;
    for (const group of this.groups.values()) {
      for (const task of group.queue.splice(0)) {
        task.reject(new Error("RATE_LIMIT_SCHEDULER_STOPPED"));
      }
    }
    this.orderReservations.clear();
  }

  snapshot(nowMs = Date.now()) {
    this.expireOrderReservations(nowMs);
    return {
      groups: Object.fromEntries(
        [...this.groups.entries()].map(([name, group]) => [name, group.snapshot(nowMs)]),
      ),
      recentThrottles: this.recentThrottles.slice(-20),
      orderCapacity: this.orderCapacitySnapshot(nowMs),
    };
  }
}

module.exports = {
  DEFAULT_GROUP_LIMITS,
  PRIORITY_WEIGHT,
  UpbitRateLimitScheduler,
  groupForExchangeRequest,
  parseRemainingReq,
};
