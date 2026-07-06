class EventBus {
  constructor(options = {}) {
    this.handlersByTopic = new Map();
    this.onError = typeof options.onError === "function" ? options.onError : null;
  }

  subscribe(topic, handler) {
    if (!topic || typeof topic !== "string") {
      throw new Error("EventBus topic must be a non-empty string");
    }

    if (typeof handler !== "function") {
      throw new Error("EventBus handler must be a function");
    }

    if (!this.handlersByTopic.has(topic)) {
      this.handlersByTopic.set(topic, new Set());
    }

    const handlers = this.handlersByTopic.get(topic);
    handlers.add(handler);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlersByTopic.delete(topic);
      }
    };
  }

  publish(topic, event) {
    const handlers = [...this.handlersByTopic.get(topic) || []];

    for (const handler of handlers) {
      try {
        handler(event, topic);
      } catch (error) {
        if (this.onError) {
          try {
            this.onError(error, { topic, event });
          } catch (_error) {
            // Event observers must not break the append/publish path.
          }
        }
      }
    }

    return handlers.length;
  }
}

module.exports = {
  EventBus,
};
