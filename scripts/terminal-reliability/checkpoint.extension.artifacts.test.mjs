import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkpointTestFixtureFromEnvironment } from "./checkpoint.extension.test-fixture.mjs";
import {
  verifyArtifacts,
  verifiedArtifactSource,
  hash,
  inputs,
  buildHash,
} from "./checkpoint.extension.artifacts.mjs";
const fixture = await checkpointTestFixtureFromEnvironment();

test("trusted deterministic derivation rejects coordinated output + manifest substitution", async () => {
  // The wrapper's owner can reclaim these copies even if this harness is hard-killed.
  const directory = mkdtempSync(join(fixture, "artifact-mutations-"));
  try {
    for (const name of [
      "headless.cjs",
      "browser.cjs",
      "headless.experimental.cjs",
      "browser.experimental.cjs",
      "manifest.json",
    ])
      copyFileSync(join(fixture, name), join(directory, name));
    // Positive fixture is the REAL production experiment generator; unrelated
    // throwing code with a matching adjacent hash is never considered valid.
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    const originals = Object.fromEntries(
      ["headless", "browser"].map((kind) => [
        kind,
        readFileSync(join(directory, `${kind}.experimental.cjs`), "utf8"),
      ]),
    );
    const accepted = await verifyArtifacts(directory);
    assert.equal(accepted.exactCapability, false);
    const malicious =
      "globalThis.__bigbudUnexpectedArtifactExecution = true; throw new Error('must not execute');";
    for (const kinds of [["headless"], ["browser"], ["headless", "browser"]]) {
      const altered = structuredClone(manifest);
      for (const kind of kinds) {
        writeFileSync(join(directory, `${kind}.experimental.cjs`), malicious);
        altered.outputs[kind] = hash(malicious);
      }
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(altered));
      await assert.rejects(verifyArtifacts(directory), /reviewed source-derived output mismatch/);
      assert.equal(globalThis.__bigbudUnexpectedArtifactExecution, undefined);
      // Accepted execution strings are immutable snapshots; replacing files
      // after verification cannot redirect a runner's subsequent execution.
      for (const kind of kinds)
        assert.equal(verifiedArtifactSource(accepted, kind), originals[kind]);
      for (const kind of kinds)
        writeFileSync(join(directory, `${kind}.experimental.cjs`), originals[kind]);
    }
    for (const kind of ["headless", "browser"]) {
      const altered = structuredClone(manifest);
      writeFileSync(
        join(directory, `${kind}.experimental.cjs`),
        readFileSync(join(directory, `${kind}.cjs`)),
      );
      altered.outputs[kind] = inputs[kind]; // Valid known vendor hash is NOT a valid extension hash.
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(altered));
      await assert.rejects(verifyArtifacts(directory), /reviewed source-derived output mismatch/);
      writeFileSync(join(directory, `${kind}.experimental.cjs`), originals[kind]);
    }
    for (const mutate of [
      (value) => {
        value.sources[0].sha256 = "corrupt";
      },
      (value) => {
        value.build = "corrupt";
      },
      (value) => {
        value.bundler = "unknown";
      },
      (value) => {
        value.toolchain.version = value.bundler === "1.3.9" ? "1.3.14" : "1.3.9";
        value.bundler = value.toolchain.version;
        value.build = buildHash(value.sources, value.toolchain);
      },
      (value) => {
        value.toolchain.policy.supported = "^1.3.14";
        value.build = buildHash(value.sources, value.toolchain);
      },
      (value) => {
        value.toolchain.options.minify = false;
      },
      (value) => {
        value.inputs.headless = "corrupt";
      },
      (value) => {
        value.outputs.browser = inputs.browser;
      },
    ]) {
      const altered = structuredClone(manifest);
      mutate(altered);
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(altered));
      await assert.rejects(
        verifyArtifacts(directory),
        /manifest|reviewed source-derived output mismatch/,
      );
    }
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
    assert.equal((await verifyArtifacts(directory)).build, manifest.build);
    assert.throws(
      () => verifiedArtifactSource({ ...manifest }, "headless"),
      /trusted verification/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
