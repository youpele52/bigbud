import { afterEach, describe, expect, it, vi } from "vitest";
import * as canonical from "./canonical";
import { cleanupOutcomeSizer } from "./cleanup.model.encoding.fixture";
import type { OwnerCleanupModel } from "./cleanup.model";
import { hex, id } from "./test.fixture";

type Child = ReturnType<OwnerCleanupModel["snapshot"]>["children"][number];

function childFixture(): Child {
  return {
    ref: {
      parentRootSequence: "249",
      shutdownId: id(241),
      class: 1,
      slot: 0,
      resourceIdentity: id(2),
    },
    id: hex(id(3)),
    state: "reserved",
    effects: 0,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("incremental saturation encoding checks", () => {
  it.each<[string, (child: Child) => void]>([
    ["parent sequence", (child) => (child.ref = { ...child.ref, parentRootSequence: "250" })],
    ["shutdown bytes", (child) => (child.ref.shutdownId[0] = 42)],
    ["class", (child) => (child.ref = { ...child.ref, class: 2 })],
    ["slot", (child) => (child.ref = { ...child.ref, slot: 1 })],
    ["resource bytes", (child) => (child.ref.resourceIdentity[0] = 42)],
    ["child identity", (child) => (child.id = hex(id(4)))],
    ["mutation digest", (child) => (child.digest = hex(id(5)))],
    ["state", (child) => (child.state = "accepted")],
    ["effect count", (child) => (child.effects = 1)],
  ])("re-encodes changes to %s without aliasing mutable snapshots", (_name, change) => {
    const encode = vi.spyOn(canonical, "encodeCanonical");
    const size = cleanupOutcomeSizer();
    const child = childFixture();
    const bytes = size(child);
    expect(size(structuredClone(child))).toBe(bytes);
    expect(encode).toHaveBeenCalledTimes(1);
    change(child);
    expect(size(child)).toBe(bytes);
    expect(encode).toHaveBeenCalledTimes(2);
    expect(size(structuredClone(child))).toBe(bytes);
    expect(encode).toHaveBeenCalledTimes(2);
  });

  it("validates changed references on every attempt, never caching failed encodings", () => {
    const encode = vi.spyOn(canonical, "encodeCanonical");
    const size = cleanupOutcomeSizer();
    const child = childFixture();
    size(child);
    child.ref = { ...child.ref, parentRootSequence: "0" };
    expect(() => size(child)).toThrow("CLEANUP_REF_INVALID");
    expect(() => size(child)).toThrow("CLEANUP_REF_INVALID");
    expect(encode).toHaveBeenCalledTimes(3);
  });

  it("keeps the encoding cache local to each saturation model", () => {
    const encode = vi.spyOn(canonical, "encodeCanonical");
    const first = cleanupOutcomeSizer();
    const second = cleanupOutcomeSizer();
    expect(first(childFixture())).toBe(second(childFixture()));
    expect(encode).toHaveBeenCalledTimes(2);
  });
});
