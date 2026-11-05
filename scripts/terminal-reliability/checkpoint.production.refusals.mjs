import assert from "node:assert/strict";
import {
  captureProductionState,
  restoreProductionState,
  parserProfile,
} from "./checkpoint.production.state.mjs";
import { productionOracle } from "./checkpoint.production.fixtures.mjs";
import { qualifyAdversarialImports } from "./checkpoint.production.adversarial.mjs";

/** Refusals protect this local experiment, not arbitrary remote checkpoint payloads. */
export async function qualifyProductionRefusals(create) {
  const instance = create();
  const { terminal } = instance;
  const profile = parserProfile(terminal._core);
  try {
    const snapshot = captureProductionState(terminal, profile);
    const original = productionOracle(terminal);
    assert.throws(
      () =>
        restoreProductionState(
          terminal,
          JSON.stringify({ ...JSON.parse(snapshot), schema: "wrong" }),
          profile,
        ),
      /incompatible/,
    );
    assert.throws(
      () =>
        restoreProductionState(
          terminal,
          JSON.stringify({ ...JSON.parse(snapshot), exactCapability: true }),
          profile,
        ),
      /incompatible/,
    );
    assert.deepEqual(productionOracle(terminal), original);
    const custom = terminal.parser.registerCsiHandler({ final: "z" }, () => true);
    assert.throws(() => captureProductionState(terminal, profile), /unqualified/);
    custom.dispose();
    // Registration containers retain empty lists; use a fresh clean instance for later checks.
  } finally {
    instance.dispose();
  }
  const second = create();
  try {
    const current = second.terminal;
    const expected = parserProfile(current._core);
    const marker = current.registerMarker(0);
    assert.throws(() => captureProductionState(current, expected), /external markers/);
    marker.dispose();
    current.write("pending");
    assert.throws(() => captureProductionState(current, expected), /unsettled/);
    await new Promise((done) => current.write("", done));
    const captured = captureProductionState(current, expected);
    const owned = JSON.stringify(captured);
    await new Promise((done) => current.write("later-source-mutation", done));
    assert.equal(JSON.stringify(captured), owned, "snapshot has no borrowed mutable state");
  } finally {
    second.dispose();
  }
  const adversarial = await qualifyAdversarialImports(create);
  return {
    checks: 6,
    adversarial,
    hostilePayloadDecoderQualified: false,
    productMaximumGeometryQualified: false,
    malformedImportAtomic: true,
  };
}
