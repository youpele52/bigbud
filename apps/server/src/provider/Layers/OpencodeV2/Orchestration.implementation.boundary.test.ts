import { expect, it } from "vitest";
import {
  validateV2PreparedBody,
  v2ImmutableJson,
  encodeV2FinalResult,
} from "./Orchestration.implementation.boundary.ts";
import type { V2CanonicalBody } from "./Orchestration.implementation.types.ts";

it("shared compatibility validation rejects ID/workspace/credential authority even when the current general HTTP schema accepts the field", () => {
  for (const extra of [
    { invocationId: "forged" },
    { sourceMessageId: "forged" },
    { workspaceTool: "read_file" },
    { browserAction: {} },
    { callbackToken: "forged" },
  ])
    expect(() =>
      validateV2PreparedBody(
        "list_threads",
        { action: "list_threads", ...extra } as V2CanonicalBody,
        "caller",
      ),
    ).toThrow("outside the narrow");
  expect(() =>
    validateV2PreparedBody(
      "rename_thread",
      { action: "rename", threadId: "different-caller", title: "x" },
      "caller",
    ),
  ).toThrow("outside the narrow");
  expect(
    validateV2PreparedBody(
      "rename_thread",
      { action: "rename", threadId: "caller", targetThreadId: "target", title: "x" },
      "caller",
    ),
  ).toEqual({ action: "rename", threadId: "caller", targetThreadId: "target", title: "x" });
});

it("pure-handler boundary owns immutable JSON and rejects accessors/prototypes/non-finite values and oversized final encoding", () => {
  const original = { nested: { value: 1 } },
    copied = v2ImmutableJson(original);
  original.nested.value = 2;
  expect(copied).toEqual({ nested: { value: 1 } });
  expect(Object.isFrozen(copied)).toBe(true);
  const accessor = Object.defineProperty({}, "token", {
    get() {
      throw new Error("Accessor must never run");
    },
    enumerable: true,
  });
  expect(() => v2ImmutableJson(accessor)).toThrow("accessor rejected");
  const array = Object.defineProperty([1], "0", {
    get() {
      throw new Error("Array accessor must never run");
    },
    enumerable: true,
  });
  expect(() => v2ImmutableJson(array)).toThrow("accessor rejected");
  // oxlint-disable-next-line no-new-array -- a sparse array of this length is the rejected input under test
  expect(() => v2ImmutableJson(new Array(32769))).toThrow("bounded dense plain JSON");
  expect(() => v2ImmutableJson(new Date())).toThrow("prototype rejected");
  expect(() => v2ImmutableJson(Infinity)).toThrow("not plain JSON");
  expect(() => encodeV2FinalResult({ text: "x".repeat(90000) })).toThrow("exceeds bound");
});
