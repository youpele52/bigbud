import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { digestPages } from "./checkpoint.extension.digest.mjs";
import { PAGE_BYTES } from "./checkpoint.extension.pages.mjs";
import { stateSchema } from "./checkpoint.extension.schema.mjs";
import { samples, captureState } from "./checkpoint.extension.state.mjs";
import { scan, materialize, measure, encode } from "./checkpoint.extension.codec.mjs";
import { referenceState } from "./checkpoint.extension.reference.mjs";

export function corruptionChecks(terminal) {
  const snapshot = terminal.exportExperimentalCheckpoint();
  assert(
    Object.isFrozen(snapshot) &&
      Object.isFrozen(snapshot.options) &&
      Object.isFrozen(snapshot.pages),
    "owned custody envelope must not be resized or re-digested to bypass its reservation",
  );
  const before = referenceState(terminal);
  assert.equal(
    snapshot.digest,
    createHash("sha256").update(Buffer.concat(snapshot.pages)).digest("hex"),
    "independent SHA-256",
  );
  const repeated = terminal.exportExperimentalCheckpoint();
  assert.equal(repeated.digest, snapshot.digest, "deterministic binary encoding");
  assert.throws(() => terminal.exportExperimentalCheckpoint(), /slots/);
  terminal.releaseExperimentalCheckpoint(repeated);
  const clone = () => ({
    ...snapshot,
    options: { ...snapshot.options },
    pages: snapshot.pages.map((page) => page.slice()),
  });
  const set32 = (envelope, offset, value) => {
    for (let i = 0; i < 4; i++)
      envelope.pages[Math.floor((offset + i) / PAGE_BYTES)][(offset + i) % PAGE_BYTES] =
        value >>> (i * 8);
  };
  const mutateByte = (offset, byte) => (envelope) => {
    envelope.pages[Math.floor(offset / PAGE_BYTES)][offset % PAGE_BYTES] = byte;
    envelope.digest = digestPages(envelope.pages);
  };
  const schema = stateSchema(samples(terminal._core), captureState(terminal._core));
  const decoded = scan(schema, snapshot.pages, snapshot.byteLength, 128 * 1024 * 1024).state;
  const plane = decoded.buffers[0].lines[0]._data.planes[0];
  const cellOffset = plane.offset ?? plane.uniformOffset;
  const paramOffset = decoded.parser._params._subParamsIdx.planes[0].offset;
  const mutations = [
    (value) => {
      value.build = "corrupt";
    },
    (value) => {
      value.schema = 999;
    },
    (value) => {
      value.fingerprint = "corrupt";
    },
    (value) => {
      value.options.semantic = "corrupt";
    },
    (value) => {
      value.options.cols = 1001;
    },
    (value) => {
      value.options.rows = 500;
    },
    (value) => {
      value.pages.pop();
    },
    (value) => {
      value.pages[0] = new Uint16Array(value.pages[0]);
    },
    (value) => {
      value.byteLength = 128 * 1024 * 1024 + 1;
    },
    mutateByte(0, 255), // Explicit root field type, even with a valid new digest.
    mutateByte(plane.uniformOffset - 6, 255), // Typed payload enum.
    (value) => {
      set32(value, 1, 0xffffffff);
      value.digest = digestPages(value.pages);
    },
    (value) => {
      set32(value, paramOffset, 0xffffffff);
      value.digest = digestPages(value.pages);
    },
    (value) => {
      value.pages[0][value.pages[0].length - 1] ^= 1;
    },
    (value) => {
      Object.defineProperty(value.options, "cols", {
        get() {
          throw new Error("must not invoke checkpoint accessor");
        },
      });
    },
  ];
  // Locate uniform data directly from the typed view's encoding, without
  // changing an application projection or replacing a target service object.
  if (cellOffset !== undefined)
    mutations.push((value) => {
      set32(value, cellOffset, 0x201fffff);
      value.digest = digestPages(value.pages);
    });
  for (const mutate of mutations) {
    const corrupted = clone();
    mutate(corrupted);
    assert.throws(() => terminal.importExperimentalCheckpoint(corrupted));
    assert.deepEqual(referenceState(terminal), before, "corrupt import mutated target");
    assert.equal(
      snapshot.digest,
      digestPages(snapshot.pages),
      "refusal changed old committed checkpoint",
    );
  }
  // Re-encode type-valid but semantically inconsistent states with a valid
  // digest: admission must validate cross-fields, not trust SHA-256 alone.
  for (const mutate of [
    (state) => {
      state.active = 1;
    },
    (state) => {
      state.buffers[0].lines[0]._data[0] = 0x200041;
    },
    (state) => {
      state.buffers[0].lines[0]._data[2] = 0x10000000;
    },
    (state) => {
      state.handler._curAttrData.extended._ext = 6 << 26;
    },
    (state) => {
      state.parser.currentState = 8;
      state.osc.fields._state = 2;
      state.osc.fields._id = 2;
      state.osc.active = []; // Must bind the complete known handler list.
    },
    (state) => {
      state.parser.currentState = 8;
      state.osc.fields._state = 2;
      state.osc.fields._id = 4;
      state.osc.active = [["4", 0]]; // Type-valid but unsupported color authority.
    },
  ]) {
    const state = materialize(
      schema,
      scan(schema, snapshot.pages, snapshot.byteLength, 128 * 1024 * 1024).state,
    );
    mutate(state);
    const byteLength = measure(schema, state);
    const pages = encode(schema, state, byteLength);
    assert.throws(() =>
      terminal.importExperimentalCheckpoint({
        ...snapshot,
        pages,
        byteLength,
        digest: digestPages(pages),
      }),
    );
    assert.deepEqual(referenceState(terminal), before, "semantic refusal mutated target");
    assert.equal(
      snapshot.digest,
      digestPages(snapshot.pages),
      "semantic refusal changed prior checkpoint",
    );
  }
  terminal.releaseExperimentalCheckpoint(snapshot);
}
