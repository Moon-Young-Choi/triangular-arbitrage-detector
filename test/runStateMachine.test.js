const test = require("node:test");
const assert = require("node:assert/strict");
const { RunStateMachine, normalizeCommand, STATES } = require("../src/core/runStateMachine");

test("run state machine accepts safe Start Pause Stop transitions", () => {
  const events = [];
  const machine = new RunStateMachine({ log: (event) => events.push(event) });

  assert.equal(machine.apply("Start"), STATES.RUNNING);
  assert.equal(machine.canAcceptNewOpportunity(), true);
  assert.equal(machine.apply("Pause"), STATES.PAUSED);
  assert.equal(machine.canAcceptNewOpportunity(), false);
  assert.equal(machine.canSubmitFirstLegOrder(), false);
  assert.equal(machine.shouldContinueOrderManagement(), true);
  assert.equal(machine.apply("Start"), STATES.RUNNING);
  assert.equal(machine.apply("Stop"), STATES.STOPPED);
  assert.equal(events.some((event) => event.nextState === STATES.PAUSED), true);
});

test("run state machine rejects invalid commands and transitions", () => {
  const machine = new RunStateMachine();

  assert.throws(() => normalizeCommand("Restart"), /Invalid engine command/);
  assert.throws(() => machine.apply("Pause"), /Cannot Pause while STOPPED/);
  machine.apply("Start");
  assert.throws(() => machine.apply("Start"), /Cannot Start while RUNNING/);
});
