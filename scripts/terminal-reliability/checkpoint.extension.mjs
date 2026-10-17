import {
  measure,
  encode,
  scan,
  materialize,
  MAX_CHECKPOINT_BYTES,
} from "./checkpoint.extension.codec.mjs";
import { stateSchema } from "./checkpoint.extension.schema.mjs";
import { digestPages } from "./checkpoint.extension.digest.mjs";
import { PAGE_BYTES } from "./checkpoint.extension.pages.mjs";
import { validatePages } from "./checkpoint.extension.page-custody.mjs";
import {
  reserve,
  accountState,
  STATE_BYTES,
  reservedBytes,
} from "./checkpoint.extension.budget.mjs";
import { validateProjection } from "./checkpoint.extension.validation.mjs";
import {
  applyState,
  prepareState,
  assertQuiescent,
  captureState,
  fingerprint,
  samples,
  validateState,
} from "./checkpoint.extension.state.mjs";

const semanticOptions = (terminal) =>
  JSON.stringify(
    Object.fromEntries(
      [
        "termName",
        "tabStopWidth",
        "convertEol",
        "windowsMode",
        "reflowCursorLine",
        "scrollOnEraseInDisplay",
        "cursorStyle",
        "cursorBlink",
        "ignoreBracketedPasteMode",
        "disableStdin",
        "scrollOnUserInput",
        "scrollSensitivity",
        "fastScrollSensitivity",
      ].map((key) => [key, terminal.options[key]]),
    ),
  );
const stateBytes = (core, state) =>
  accountState(state) + core._inputHandler._parseBuffer.byteLength + 1024 * 1024;
function dataFields(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error("invalid checkpoint envelope");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.keys(descriptors).length !== fields.length ||
    fields.some((key) => !descriptors[key] || !Object.hasOwn(descriptors[key], "value"))
  )
    throw new Error("invalid checkpoint envelope fields");
}
function validateEnvelope(envelope, build, expected, terminal) {
  dataFields(envelope, [
    "schema",
    "build",
    "fingerprint",
    "options",
    "exactCapability",
    "byteLength",
    "pages",
    "digest",
  ]);
  dataFields(envelope.options, ["cols", "rows", "scrollback", "semantic"]);
  const o = envelope.options;
  if (
    envelope.schema !== 2 ||
    envelope.build !== build ||
    envelope.fingerprint !== expected ||
    envelope.exactCapability !== false ||
    o.semantic !== semanticOptions(terminal) ||
    !Number.isInteger(o.cols) ||
    o.cols < 2 ||
    o.cols > 1000 ||
    !Number.isInteger(o.rows) ||
    o.rows < 1 ||
    o.rows > 500 ||
    !Number.isInteger(o.scrollback) ||
    o.scrollback < 0 ||
    o.scrollback > 10000
  )
    throw new Error("incompatible checkpoint envelope");
  if (
    !Number.isSafeInteger(envelope.byteLength) ||
    envelope.byteLength < 1 ||
    envelope.byteLength > MAX_CHECKPOINT_BYTES
  )
    throw new Error("invalid checkpoint page count/budget");
  const pages = validatePages(envelope.pages, envelope.byteLength, PAGE_BYTES);
  if (
    typeof envelope.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(envelope.digest) ||
    digestPages(pages) !== envelope.digest
  )
    throw new Error("checkpoint digest mismatch");
  return { options: o, pages };
}

// Owned compatibility boundary, embedded ONLY in verified temporary artifacts.
export function installExperimentalCheckpoint(Terminal, build) {
  const probe = new Terminal({ allowProposedApi: true });
  const expected = fingerprint(probe._core);
  probe.dispose();
  const metadata = new WeakMap();
  const checkpoints = new WeakMap();
  class ExperimentalTerminal extends Terminal {
    constructor(options) {
      super(options);
      const state = {
        colorTouched: false,
        themeTouched: false,
        customRegistration: false,
        checkpoints: new Set(),
        credit: null,
      };
      metadata.set(this, state);
      this._core._inputHandler.onColor(() => {
        state.colorTouched = true;
      });
      this._core.optionsService.onSpecificOptionChange("theme", () => {
        state.themeTouched = true;
      });
      for (const name of [
        "registerCsiHandler",
        "registerDcsHandler",
        "registerEscHandler",
        "registerOscHandler",
      ]) {
        const original = this._core[name].bind(this._core);
        this._core[name] = (...args) => {
          state.customRegistration = true;
          return original(...args);
        };
      }
      const register = this._core.unicodeService.register.bind(this._core.unicodeService);
      this._core.unicodeService.register = (...args) => {
        state.customRegistration = true;
        return register(...args);
      };
    }
    dispose() {
      const state = metadata.get(this);
      state?.credit?.release();
      if (state) state.credit = null;
      super.dispose();
    }
  }
  function supported(terminal, importing = false) {
    assertQuiescent(terminal._core);
    const meta = metadata.get(terminal);
    if (!meta || meta.customRegistration || fingerprint(terminal._core) !== expected)
      throw new Error("unsupported handler/Unicode registration");
    const osc = terminal._core._inputHandler._parser._oscParser;
    if (
      meta.colorTouched ||
      meta.themeTouched ||
      Object.getPrototypeOf(terminal.options.theme) !== Object.prototype ||
      Reflect.ownKeys(terminal.options.theme).length ||
      (osc._state !== 0 && [4, 10, 11, 12, 104, 110, 111, 112].includes(osc._id))
    )
      throw new Error("palette/query authority unsupported by prototype");
    if (importing && terminal._core.element) throw new Error("import requires detached terminal");
    if (
      terminal.options.convertEol ||
      terminal.options.windowsMode ||
      Object.keys(terminal.options.windowsPty ?? {}).length ||
      Object.keys(terminal.options.windowOptions ?? {}).length
    )
      throw new Error("unsupported parser/window option set");
    return meta;
  }
  function refresh(terminal, state) {
    const meta = metadata.get(terminal);
    const credit = reserve(stateBytes(terminal._core, state));
    meta.credit?.release();
    meta.credit = credit;
    return credit.bytes;
  }
  Terminal.prototype.releaseExperimentalCheckpoint = function (envelope) {
    const held = checkpoints.get(envelope);
    if (held) {
      held.credit.release();
      held.owner.checkpoints.delete(envelope);
      checkpoints.delete(envelope);
    }
  };
  Terminal.prototype.experimentalCheckpointAccounting = function () {
    return {
      profileReservedBytes: reservedBytes(),
      stateReservedBytes: metadata.get(this)?.credit?.bytes ?? 0,
      checkpointSlots: metadata.get(this)?.checkpoints.size ?? 0,
    };
  };
  Terminal.prototype.exportExperimentalCheckpoint = function () {
    const meta = supported(this);
    if (meta.checkpoints.size >= 2)
      throw new Error("checkpoint custody slots exhausted; keep old state and pause capture");
    const scratch = reserve(8 * 1024 * 1024);
    let credit;
    try {
      const state = captureState(this._core);
      refresh(this, state);
      const options = {
        cols: this.cols,
        rows: this.rows,
        scrollback: this.options.scrollback,
        semantic: semanticOptions(this),
      };
      validateState(state, options);
      const schema = stateSchema(samples(this._core), state);
      const byteLength = measure(schema, state);
      credit = reserve(byteLength + Math.ceil(byteLength / PAGE_BYTES) * 256);
      const pages = encode(schema, state, byteLength);
      const envelope = Object.freeze({
        schema: 2,
        build,
        fingerprint: expected,
        options: Object.freeze(options),
        exactCapability: false,
        byteLength,
        pages: Object.freeze(pages),
        digest: digestPages(pages),
      });
      checkpoints.set(envelope, { credit, owner: meta });
      meta.checkpoints.add(envelope);
      return envelope;
    } catch (error) {
      credit?.release();
      throw error;
    } finally {
      scratch.release();
    }
  };
  Terminal.prototype.importExperimentalCheckpoint = function (envelope) {
    const meta = supported(this, true);
    const { options, pages } = validateEnvelope(envelope, build, expected, this);
    const existing = captureState(this._core);
    refresh(this, existing);
    const incomingBytes = envelope.byteLength + pages.length * 256;
    const incoming = checkpoints.has(envelope) ? null : reserve(incomingBytes);
    let staging;
    try {
      // Incoming bytes + future decoded state must fit the declared restore
      // ceiling. Profile also charges source, old target and retained slots.
      staging = reserve(STATE_BYTES - incomingBytes);
      const schema = stateSchema(samples(this._core), existing);
      const { state, allocation } = scan(
        schema,
        pages,
        envelope.byteLength,
        STATE_BYTES - incomingBytes,
      );
      validateState(state, options);
      validateProjection(state, existing);
      const estimate = Math.max(allocation, stateBytes(this._core, state));
      if (estimate + incomingBytes > STATE_BYTES)
        throw new Error("checkpoint restore staging budget exceeded");
      materialize(schema, state);
      prepareState(this._core, state);
      // Commit has no public resize/option events, VT writes or historical
      // responses. All allocations and schema checks precede target mutation.
      const raw = this._core.optionsService.rawOptions;
      raw.scrollback = options.scrollback;
      raw.cols = options.cols;
      raw.rows = options.rows;
      applyState(this._core, state);
      meta.credit?.release();
      staging.shrink(estimate);
      meta.credit = staging;
      staging = null;
    } finally {
      staging?.release();
      incoming?.release();
    }
  };
  return ExperimentalTerminal;
}
