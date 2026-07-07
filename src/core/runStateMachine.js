const STATES = Object.freeze({
  STOPPED: "STOPPED",
  STARTING: "STARTING",
  PREPARING: "PREPARING",
  PREPARING_BLOCKED: "PREPARING_BLOCKED",
  RUNNING: "RUNNING",
  PAUSING: "PAUSING",
  PAUSED: "PAUSED",
  STOPPING: "STOPPING",
  ERROR: "ERROR",
});

const COMMANDS = Object.freeze({
  START: "Start",
  PAUSE: "Pause",
  STOP: "Stop",
});

const ALLOWED_COMMANDS = new Set(Object.values(COMMANDS));

function normalizeCommand(command) {
  const text = typeof command === "string" ? command : command && command.command;
  const normalized = String(text || "").trim().toLowerCase();

  if (normalized === "start") return COMMANDS.START;
  if (normalized === "pause") return COMMANDS.PAUSE;
  if (normalized === "stop") return COMMANDS.STOP;

  throw new Error(`Invalid engine command: ${text}`);
}

class RunStateMachine {
  constructor(options = {}) {
    this.state = options.initialState || STATES.STOPPED;
    this.log = options.log || (() => {});
  }

  transition(nextState, reason) {
    const previousState = this.state;
    this.state = nextState;
    this.log({
      type: "state.transition",
      previousState,
      nextState,
      reason,
    });
    return this.state;
  }

  fail(error) {
    return this.transition(STATES.ERROR, error.message || String(error));
  }

  apply(commandInput) {
    const command = normalizeCommand(commandInput);

    if (!ALLOWED_COMMANDS.has(command)) {
      throw new Error(`Invalid engine command: ${command}`);
    }

    if (command === COMMANDS.START) {
      return this.start();
    }

    if (command === COMMANDS.PAUSE) {
      return this.pause();
    }

    return this.stop();
  }

  start() {
    if (this.state === STATES.STOPPED) {
      this.transition(STATES.STARTING, "Start command");
      return this.transition(STATES.PREPARING, "Engine preparing market data");
    }

    if (this.state === STATES.PAUSED) {
      return this.transition(STATES.RUNNING, "Start command resumed paused engine");
    }

    throw new Error(`Cannot Start while ${this.state}`);
  }

  markReady() {
    if (this.state !== STATES.PREPARING) {
      throw new Error(`Cannot mark ready while ${this.state}`);
    }

    return this.transition(STATES.RUNNING, "Engine preparation complete");
  }

  blockPreparation(reason = "Preparation blocked") {
    if (this.state !== STATES.PREPARING) {
      throw new Error(`Cannot block preparation while ${this.state}`);
    }

    return this.transition(STATES.PREPARING_BLOCKED, reason);
  }

  pause() {
    if (this.state !== STATES.RUNNING) {
      throw new Error(`Cannot Pause while ${this.state}`);
    }

    this.transition(STATES.PAUSING, "Pause command");
    return this.transition(STATES.PAUSED, "New executions paused");
  }

  stop() {
    if (
      this.state === STATES.PREPARING ||
      this.state === STATES.PREPARING_BLOCKED ||
      this.state === STATES.RUNNING ||
      this.state === STATES.PAUSED ||
      this.state === STATES.ERROR
    ) {
      this.transition(STATES.STOPPING, "Stop command");
      return this.transition(STATES.STOPPED, "Engine stopped");
    }

    if (this.state === STATES.STOPPED) {
      return this.state;
    }

    throw new Error(`Cannot Stop while ${this.state}`);
  }

  canAcceptNewOpportunity() {
    return this.state === STATES.RUNNING;
  }

  canSubmitFirstLegOrder() {
    return this.state === STATES.RUNNING;
  }

  shouldContinueOrderManagement() {
    return [
      STATES.RUNNING,
      STATES.PAUSING,
      STATES.PAUSED,
      STATES.STOPPING,
      STATES.ERROR,
    ].includes(this.state);
  }

  snapshot() {
    return {
      state: this.state,
      canAcceptNewOpportunity: this.canAcceptNewOpportunity(),
      canSubmitFirstLegOrder: this.canSubmitFirstLegOrder(),
      shouldContinueOrderManagement: this.shouldContinueOrderManagement(),
    };
  }
}

module.exports = {
  STATES,
  COMMANDS,
  normalizeCommand,
  RunStateMachine,
};
