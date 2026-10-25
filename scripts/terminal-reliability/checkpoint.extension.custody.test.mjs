import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyArtifacts, loadVerifiedHeadless } from "./checkpoint.extension.artifacts.mjs";
import { referenceState } from "./checkpoint.extension.reference.mjs";
import {
  custodyRefusalChecks,
  themeRefusalChecks,
} from "./checkpoint.extension.security-cases.mjs";
import { digestPages } from "./checkpoint.extension.digest.mjs";
import { checkpointTestFixtureFromEnvironment } from "./checkpoint.extension.test-fixture.mjs";
const directory = await checkpointTestFixtureFromEnvironment();
const { Terminal } = loadVerifiedHeadless(await verifyArtifacts(directory));

test("intrinsic page custody refuses shadowed SAB, getters, Proxy, iterator, resizable and detached backing", () => {
  const result = custodyRefusalChecks(Terminal, referenceState);
  assert(result.cases >= 14);
  assert.equal(result.callbacks, 0);
  assert.equal(result.unchangedStateAndReservations, true);
});
test("digest uses indexed bytes, never a caller page or page-list iterator", () => {
  const pages = [new Uint8Array([1, 2, 3])];
  const expected = digestPages(pages);
  let calls = 0;
  for (const value of [pages, pages[0]])
    Object.defineProperty(value, Symbol.iterator, {
      get() {
        calls++;
        throw new Error("unexpected caller iterator");
      },
    });
  assert.equal(digestPages(pages), expected);
  assert.equal(calls, 0);
});
test("public theme setter, replacement, revert, in-place change and constructor themes refuse", () => {
  assert.equal(themeRefusalChecks(Terminal, referenceState).cases, 9);
});
