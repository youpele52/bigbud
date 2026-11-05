import assert from "node:assert/strict";
import {
  captureProductionState,
  restoreProductionState,
  parserProfile,
} from "./checkpoint.production.state.mjs";
const write = (terminal, text) => new Promise((done) => terminal.write(text, done));

/** Every malformed wire must leave existing cells, parser tails, modes and live link markers unchanged. */
export async function qualifyAdversarialImports(create) {
  const source = create(),
    target = create();
  try {
    await write(source.terminal, "changed-buffer");
    await write(
      target.terminal,
      "\x1b]8;id=sentinel;https://example.invalid\x1b\\sentinel\x1b]8;;\x1b\\\x1b[3",
    );
    const profile = parserProfile(target.terminal._core);
    const valid = captureProductionState(source.terminal, profile);
    const unchanged = captureProductionState(target.terminal, profile);
    const cases = [
      (s) => {
        s.parser.strings[0].handlers[0][1][0].limit++;
      },
      (s) => {
        s.parser.strings[0].active = [["missing", 0]];
      },
      (s) => {
        s.parser.strings[0].active = [[s.parser.strings[0].handlers[0][0], 999]];
      },
      (s) => {
        s.parser.params.params.pop();
      },
      (s) => {
        s.parser.params.maxLength = 1_000_000;
      },
      (s) => {
        s.parser.fields.currentState = 1000;
      },
      (s) => {
        s.parser.stringCarry = 5;
      },
      (s) => {
        s.parser.utf8Carry = [0, 128, 128];
      },
      (s) => {
        s.parser.strings[0].fields._stack.paused = true;
      },
      (s) => {
        s.buffers[0].lines[0].data[0] = -1;
      },
      (s) => {
        s.buffers[0].lines[0].data.pop();
      },
      (s) => {
        s.buffers[0].maxLength = 100_000_000;
      },
      (s) => {
        s.buffers[0].fields.ybase = 999999;
      },
      (s) => {
        s.buffers[0].fields.scrollBottom = -1;
      },
      (s) => {
        s.buffers[0].fields.extra = true;
      },
      (s) => {
        s.attr.extended._urlId = 42;
      },
      (s) => {
        s.links.entries = [{ id: 1, data: { uri: "x" }, markers: [{ buffer: 9, line: 0 }] }];
        s.links.nextId = 2;
      },
      (s) => {
        s.mouse._activeProtocol = "unknown";
      },
      (s) => {
        s.core.decPrivateModes.applicationCursorKeys = "false";
      },
      (s) => {
        s.geometry[0]++;
      },
      (s) => {
        s.exactCapability = true;
      },
      (s) => {
        s.schema = "unknown";
      },
    ];
    for (const mutate of cases) {
      const value = JSON.parse(valid);
      mutate(value);
      assert.throws(() => restoreProductionState(target.terminal, JSON.stringify(value), profile));
      assert.equal(captureProductionState(target.terminal, profile), unchanged);
    }
    const raw = ["{", "null", "[1]", '{"__proto__":{}}', "[".repeat(33) + "0" + "]".repeat(33)];
    for (const wire of raw) {
      assert.throws(() => restoreProductionState(target.terminal, wire, profile));
      assert.equal(captureProductionState(target.terminal, profile), unchanged);
    }
    let callbacks = 0;
    const getter = {
      get schema() {
        callbacks++;
        return "x";
      },
    };
    for (const value of [
      getter,
      new Proxy(
        {},
        {
          get() {
            callbacks++;
          },
        },
      ),
    ])
      assert.throws(
        () => restoreProductionState(target.terminal, value, profile),
        /wire must be a string/,
      );
    assert.equal(callbacks, 0);
    assert.equal(captureProductionState(target.terminal, profile), unchanged);
    return { refused: cases.length + raw.length + 2, targetUnchanged: true, callerCallbacks: 0 };
  } finally {
    source.dispose();
    target.dispose();
  }
}
