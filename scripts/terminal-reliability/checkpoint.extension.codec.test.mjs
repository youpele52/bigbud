import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { measure, encode, scan, materialize } from "./checkpoint.extension.codec.mjs";
import { PAGE_BYTES, TypedSlice, StringSlice } from "./checkpoint.extension.pages.mjs";
import { digestPages } from "./checkpoint.extension.digest.mjs";
import { reserve, reservedBytes, STATE_BYTES } from "./checkpoint.extension.budget.mjs";
import { checkpointTestFixtureFromEnvironment } from "./checkpoint.extension.test-fixture.mjs";
await checkpointTestFixtureFromEnvironment();

test("typed binary planes and UTF16 payload span pages without eager cell/string allocation", () => {
  const schema = {
    kind: "record",
    fields: {
      label: { kind: "string", max: 100000 },
      cells: { kind: "typed", type: "cells", max: 3000, exact: 3000 },
      mode: { kind: "enum", values: ["normal", "alternate"] },
    },
  };
  const source = {
    label: "\ud800X\udc00😀".repeat(12000),
    cells: new Uint32Array(3000),
    mode: "normal",
  };
  for (let i = 0; i < source.cells.length; i++) source.cells[i] = (i * 977) >>> 0;
  const length = measure(schema, source);
  const pages = encode(schema, source, length);
  assert(pages.length > 2);
  assert(
    pages.every((page, index) => page.length === Math.min(PAGE_BYTES, length - index * PAGE_BYTES)),
  );
  assert.equal(digestPages(pages), createHash("sha256").update(Buffer.concat(pages)).digest("hex"));
  const scanned = scan(schema, pages, length, STATE_BYTES);
  assert(scanned.state.cells instanceof TypedSlice);
  assert(scanned.state.label instanceof StringSlice);
  const restored = materialize(schema, scanned.state);
  assert.equal(
    restored.label,
    source.label,
    "isolated surrogates must not be replaced by UTF8 encoding",
  );
  assert.deepEqual(restored.cells, source.cells);
  assert.notEqual(restored.cells.buffer, source.cells.buffer);
  assert.equal(restored.mode, source.mode);
  assert.throws(() => scan(schema, pages, length, 32), /budget/);
  const changed = pages.map((page) => page.slice());
  changed[0][0] = 255;
  assert.throws(() => scan(schema, changed, length, STATE_BYTES), /field type/);
  assert.throws(() => scan(schema, pages, length - 1, STATE_BYTES), /truncated|offset/);
});

test("capture/profile reservations fail before allocation and release exactly once", () => {
  assert.equal(reservedBytes(), 0);
  assert.throws(() => reserve(STATE_BYTES + 1), /budget/);
  const held = Array.from({ length: 4 }, () => reserve(STATE_BYTES));
  try {
    assert.equal(reservedBytes(), 512 * 1024 * 1024);
    assert.throws(() => reserve(1), /budget/);
    held[0].shrink(STATE_BYTES - 100);
    const last = reserve(100);
    last.release();
    last.release();
    assert.equal(reservedBytes(), 512 * 1024 * 1024 - 100);
  } finally {
    for (const token of held) token.release();
  }
  assert.equal(reservedBytes(), 0);
});

test("streaming digest agrees with independent SHA256 at empty and page boundaries", () => {
  for (const size of [0, 55, 56, 63, 64, 65, PAGE_BYTES, PAGE_BYTES + 1]) {
    const bytes = new Uint8Array(size).fill(197);
    const pages =
      size > PAGE_BYTES ? [bytes.slice(0, PAGE_BYTES), bytes.slice(PAGE_BYTES)] : [bytes];
    assert.equal(digestPages(pages), createHash("sha256").update(bytes).digest("hex"));
  }
});
