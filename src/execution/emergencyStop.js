class EmergencyStop {
  constructor(options = {}) {
    this.active = options.active === true;
    this.reason = options.reason || null;
    this.source = options.source || null;
    this.triggeredAt = options.triggeredAt || null;
    this.details = options.details || null;
    this.logStore = options.logStore || null;
  }

  trigger(reason, details = {}) {
    if (this.active) {
      return this.snapshot();
    }

    this.active = true;
    this.reason = reason || "EMERGENCY_STOP";
    this.source = details.source || null;
    this.triggeredAt = new Date().toISOString();
    this.details = { ...details };

    if (this.logStore) {
      this.logStore.append("errors", {
        type: "emergency_stop",
        mode: details.mode || "REAL",
        reason: this.reason,
        source: this.source,
        details: this.details,
      }).catch(() => {});
    }

    return this.snapshot();
  }

  clear(details = {}) {
    const previous = this.snapshot();

    this.active = false;
    this.reason = null;
    this.source = null;
    this.triggeredAt = null;
    this.details = null;

    if (this.logStore && previous.active) {
      this.logStore.append("events", {
        type: "emergency_stop.cleared",
        mode: details.mode || "REAL",
        previous,
        reason: details.reason || null,
        source: details.source || null,
      }).catch(() => {});
    }

    return this.snapshot();
  }

  snapshot() {
    return {
      active: this.active,
      reason: this.reason,
      source: this.source,
      triggeredAt: this.triggeredAt,
      details: this.details,
    };
  }
}

module.exports = {
  EmergencyStop,
};
