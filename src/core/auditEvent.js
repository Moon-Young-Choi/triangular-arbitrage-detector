const crypto = require("node:crypto");

const AUDIT_SCHEMA_VERSION = 1;

const AUDIT_COMMON_KEYS = new Set([
  "auditSchema",
  "auditSchemaVersion",
  "eventId",
  "traceId",
  "ts",
  "timestamp",
  "type",
  "mode",
  "exchange",
  "startAsset",
  "cycleId",
  "strategyId",
  "engineState",
  "payload",
]);

const CANONICAL_AUDIT_TYPES = new Set([
  "market.orderbook_update",
  "candidate.detected",
  "candidate.validated",
  "strategy.accepted",
  "strategy.rejected",
  "risk.rejected",
  "execution.plan_created",
  "order.intent",
  "order.submitted",
  "order.ack",
  "order.fill",
  "order.partial",
  "order.cancelled",
  "cycle.done",
  "cycle.aborted",
  "pnl.realized",
  "cli.command",
  "engine.state_changed",
  "position.residual_recorded",
]);

function auditPayload(payload = {}) {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => !AUDIT_COMMON_KEYS.has(key)),
  );
}

function resolveTraceId(payload = {}, eventId) {
  return (
    payload.traceId ||
    payload.cycleId ||
    payload.planId ||
    payload.commandId ||
    payload.identifier ||
    payload.uuid ||
    eventId
  );
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function hasField(record, field) {
  return hasValue(record[field]);
}

function requiredFieldsForType(type, kind) {
  const common = ["eventId", "traceId", "ts", "timestamp", "type", "exchange", "payload"];

  if (type === "cli.command") {
    return [...common, "mode", "engineState", "commandId", "command"];
  }

  if (type === "market.orderbook_update") {
    return [...common, "mode", "engineState", "market"];
  }

  if (type === "engine.state_changed") {
    return [...common, "mode", "engineState"];
  }

  if (
    type.startsWith("candidate.") ||
    type.startsWith("strategy.") ||
    type === "risk.rejected" ||
    type === "execution.plan_created" ||
    type.startsWith("cycle.") ||
    type.startsWith("order.") ||
    type.startsWith("position.") ||
    type === "pnl.realized" ||
    kind === "fills"
  ) {
    return [...common, "mode", "engineState", "startAsset", "cycleId", "strategyId"];
  }

  return common;
}

function auditSchemaForRecord(record, kind) {
  const requiredFields = requiredFieldsForType(record.type, kind);
  const missingRequiredFields = requiredFields.filter((field) => !hasField(record, field));

  return {
    version: AUDIT_SCHEMA_VERSION,
    canonicalType: CANONICAL_AUDIT_TYPES.has(record.type),
    requiredFields,
    missingRequiredFields,
    ok: missingRequiredFields.length === 0,
  };
}

function buildAuditRecord(kind, payload = {}, options = {}) {
  const eventId = payload.eventId || (options.randomUUID || crypto.randomUUID)();
  const timestamp = payload.timestamp || (options.nowIso || new Date().toISOString());
  const ts = payload.ts || timestamp;
  const traceId = resolveTraceId(payload, eventId);
  const record = {
    ...payload,
    eventId,
    traceId,
    ts,
    timestamp,
    type: payload.type || kind,
    mode: payload.mode ?? null,
    exchange: payload.exchange ?? "upbit",
    startAsset: payload.startAsset ?? null,
    cycleId: payload.cycleId ?? null,
    strategyId: payload.strategyId ?? null,
    engineState: payload.engineState ?? null,
    payload: payload.payload !== undefined ? payload.payload : auditPayload(payload),
  };

  record.auditSchemaVersion = AUDIT_SCHEMA_VERSION;
  record.auditSchema = auditSchemaForRecord(record, kind);

  return record;
}

module.exports = {
  AUDIT_COMMON_KEYS,
  AUDIT_SCHEMA_VERSION,
  CANONICAL_AUDIT_TYPES,
  auditPayload,
  auditSchemaForRecord,
  buildAuditRecord,
  requiredFieldsForType,
  resolveTraceId,
};
