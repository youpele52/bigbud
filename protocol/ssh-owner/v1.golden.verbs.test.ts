import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { assertDecoded, consume, encode, frame, framePayload, goldens } from "./v1.golden.codec.ts";
import { errorCases } from "./v1.golden.errors.ts";

const source = readFileSync(new URL("v1.proto", import.meta.url), "utf8");
const verbs = readFileSync(new URL("v1.golden.verbs", import.meta.url), "utf8");

const declaredOperations = (() => {
  const block = /\boneof operation\s*\{([^}]+)\}/.exec(source)?.[1];
  assert.ok(block, "missing oneof operation");
  return [...block.matchAll(/\b([a-z][a-z0-9_]*)\s*=\s*(\d+)\s*;/g)].map((match) => ({
    name: match[1]!,
    field: Number(match[2]),
  }));
})();

const mapping = (() => {
  const values = new Map<string, string>();
  for (const line of verbs.trimEnd().split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-z][a-z0-9_]*)=([a-z][a-z0-9_]*)$/.exec(line);
    assert.ok(match, line);
    const [, proof, production] = match;
    assert.ok(proof && production && !values.has(proof), line);
    values.set(proof, production);
  }
  return values;
})();

const reservedFutures = [
  "subscribe_status",
  "terminal_inspect",
  "git_remote_transport",
  "probe_provider",
] as const;

test("frozen production verbs cover every proof_* operation exactly once", () => {
  // The product verbs keep their existing names and field numbers.
  assert.deepEqual(
    declaredOperations.filter(({ name }) => !name.startsWith("proof_")),
    [
      { name: "inspect_trust", field: 10 },
      { name: "approve_trust", field: 11 },
      { name: "connect", field: 12 },
      { name: "disconnect", field: 13 },
      { name: "list_folders", field: 14 },
      { name: "list_aliases", field: 76 },
    ],
  );

  const proofNames = declaredOperations
    .filter(({ name }) => name.startsWith("proof_"))
    .map(({ name }) => name)
    .toSorted();
  assert.deepEqual([...mapping.keys()].toSorted(), proofNames);

  const productionNames = [...mapping.values()];
  assert.equal(new Set(productionNames).size, productionNames.length);
  for (const [proof, production] of mapping) {
    assert.match(production, /^[a-z][a-z0-9_]*$/, proof);
    assert.ok(!production.startsWith("proof_"), proof);
    assert.ok(!proofNames.includes(production), proof);
  }
});

test("every declared operation field number is unique", () => {
  const fields = declaredOperations.map(({ field }) => field);
  assert.equal(new Set(fields).size, fields.length);
  assert.ok(fields.every((field) => field >= 10 && field <= 127));
});

test("reserved future production names are recorded and remain unallocated", () => {
  const section = /Reserved future production names[^:]*:([\s\S]*)$/.exec(
    source.slice(0, source.indexOf("oneof operation")),
  )?.[1];
  assert.ok(section, "missing reserved future names");
  const documented = new Set(
    [...section.matchAll(/\b([a-z][a-z0-9_]*)\b/g)].map((match) => match[1]!),
  );
  for (const name of reservedFutures) assert.ok(documented.has(name), name);
  const allocated = new Set([...mapping.values(), ...declaredOperations.map(({ name }) => name)]);
  for (const name of reservedFutures) assert.ok(!allocated.has(name), name);
});

test("the three additive typed-error frames match the ErrorCode values", () => {
  const values = goldens("v1.golden.frames");
  // The cases encode ErrorCode 28, 29 and 30; see `v1.golden.errors.ts`.
  for (const name of [
    "error_session_quota",
    "error_windows_password_unsupported",
    "error_keyboard_interactive_unsupported",
  ] as const) {
    const fields = errorCases[name];
    const expected = consume(values, name);
    assert.deepEqual(frame(encode(fields)), expected, name);
    assertDecoded(framePayload(expected), fields);
  }
});
