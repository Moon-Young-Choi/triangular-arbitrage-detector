const { AppendOnlyLogStore } = require("./appendOnlyLog");
const { EventBus } = require("./eventBus");

class EventLog {
  constructor(options = {}) {
    this.logStore = options.logStore || new AppendOnlyLogStore(options);
    this.eventBus = options.eventBus || new EventBus();
  }

  async append(kind, payload = {}) {
    const record = await this.logStore.append(kind, payload);
    const event = {
      kind,
      record,
    };

    this.eventBus.publish(kind, event);
    this.eventBus.publish("*", event);

    return record;
  }

  readAll(kind, options = {}) {
    return this.logStore.readAll(kind, options);
  }

  ensureFiles() {
    return this.logStore.ensureFiles();
  }

  filePath(kind) {
    return this.logStore.filePath(kind);
  }

  subscribe(topic, handler) {
    return this.eventBus.subscribe(topic, handler);
  }
}

module.exports = {
  EventLog,
};
