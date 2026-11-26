import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { consume, goldens, operandPreimage, type Message } from "./v1.golden.codec.ts";

export function assertGrantDigestCoverage(cases: Record<string, Message>) {
  const digests = goldens("v1.golden.grants");
  for (const [name, frame] of Object.entries(cases)) {
    const first = frame[0];
    if (!first || first[0] !== 3) continue;
    assert.ok(Array.isArray(first[1]), name);
    const operations = (first[1] as Message).filter(([tag]) => tag >= 10);
    assert.equal(operations.length, 1, name);
    const [tag, operand] = operations[0]!;
    assert.ok(Array.isArray(operand), name);
    const fields = operand as Message;
    const normalized =
      tag === 14 && fields.length === 1 && fields[0]?.[0] === 1 && fields[0]?.[1] === ""
        ? []
        : fields;
    assert.deepEqual(
      createHash("sha256").update(operandPreimage(tag, normalized)).digest(),
      consume(digests, name),
      name,
    );
  }
  assert.equal(digests.size, 0, "unused grant digest vectors");
}

export function assertReservedSentinels(tag: number) {
  const schema = readFileSync(new URL("v1.proto", import.meta.url), "utf8").replace(
    /\/\/[^\n]*/g,
    "",
  );
  for (const declaration of [
    "message Frame",
    "message Request",
    "message Reply",
    "enum ErrorCode",
  ]) {
    assert.match(schema, new RegExp(`\\b${declaration}\\s*\\{\\s*reserved ${tag};`));
  }
}

/** Catch a schema allocation that has no positive cross-language wire example yet. */
export function assertOneofCoverage(cases: Record<string, Message>) {
  const source = readFileSync(new URL("v1.proto", import.meta.url), "utf8").replace(
    /\/\/[^\n]*/g,
    "",
  );
  for (const { name, envelope, firstVariant } of [
    { name: "payload", envelope: undefined, firstVariant: 1 },
    { name: "operation", envelope: 3, firstVariant: 10 },
    { name: "outcome", envelope: 4, firstVariant: 10 },
  ]) {
    const block = new RegExp(`\\boneof ${name}\\s*\\{([^}]+)\\}`).exec(source)?.[1];
    assert.ok(block, `missing oneof ${name}`);
    const declared = new Set(
      [...block.matchAll(/=\s*(\d+)\s*;/g)].map((match) => Number(match[1])),
    );
    assert.ok(declared.size > 0, `empty oneof ${name}`);
    const seen = new Set<number>();
    for (const fields of Object.values(cases)) {
      const first = fields[0];
      if (!first) continue;
      const [tag, value] = first;
      if (envelope === undefined) seen.add(tag);
      else if (tag === envelope && Array.isArray(value)) {
        for (const [member] of value as Message) if (member >= firstVariant) seen.add(member);
      }
    }
    assert.deepEqual(seen, declared, `positive golden coverage of ${name}`);
  }
}
