import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { envelopeTags, messageFields } from "./protocol.fields";

const read = (file: string) =>
  readFileSync(new URL(`../../../../protocol/computer-use/${file}.proto`, import.meta.url), "utf8");
const snake = (name: string) =>
  name.replace(/[A-Z]/g, (letter, index) => `${index ? "_" : ""}${letter.toLowerCase()}`);

describe("computer-use schema ownership", () => {
  it("maps every message/field/type and envelope number from the owning proto files", () => {
    const messages: Record<string, Record<string, readonly [number, string]>> = {};
    for (const file of ["common", "policy", "episode", "control", "execution", "outcome"]) {
      const source = read(file).replace(/\/\/[^\n]*/g, "");
      for (const [, name, body] of source.matchAll(/message\s+(\w+)\s*\{([^}]+)\}/g)) {
        messages[snake(name!)] = Object.fromEntries(
          [...body!.matchAll(/(string|uint32|uint64|bytes)\s+(\w+)\s*=\s*(\d+);/g)].map(
            ([, type, field, id]) => [
              field,
              [Number(id), { string: "s", uint32: "u32", uint64: "u64", bytes: "b" }[type!]],
            ],
          ),
        );
      }
    }
    const codec = Object.fromEntries(
      Object.entries(messageFields).map(([kind, fields]) => [
        kind,
        Object.fromEntries(Object.entries(fields).map(([name, [id, type]]) => [name, [id, type]])),
      ]),
    );
    expect(codec).toEqual(messages);
    const tags = Object.fromEntries(
      [...read("v1").matchAll(/\w+\.\w+\s+(\w+)\s*=\s*(\d+);/g)].map(([, name, id]) => [
        name,
        Number(id),
      ]),
    );
    expect(envelopeTags).toEqual(tags);
  });
});
