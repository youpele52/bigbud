import { describe, expect, it } from "vitest";
import { CUA_DRIVER_VERSION } from "../cua-driver/release";
import {
  parseComputerUseTupleManifest,
  proposedComputerUseDriver,
  qualificationAreas,
  selectedComputerUseTuple,
} from "./tuple";

const manifest = () => ({
  format: 1,
  id: "synthetic-test-only",
  protocolMajor: 1,
  protocolMinor: 0,
  adapterVersion: 2,
  backend: "mediated-mcp",
  driverVersion: "0.38.0",
  driverSource: proposedComputerUseDriver.source,
  platform: "darwin",
  arch: "arm64",
  archiveSha256: "a".repeat(64),
  binarySha256: "b".repeat(64),
  toolSchemaSha256: "c".repeat(64),
  policyFormat: 1,
  policySha256: "d".repeat(64),
  stateFormat: 1,
  stateRoot: "per-user-computer-use-v1",
  hostIdentity: "synthetic-host",
  nativeClosure: ["guard", "owner", "worker", "broker"].map((role) => ({
    role,
    sha256: "e".repeat(64),
    codeIdentity: "synthetic-code",
  })),
  qualificationProfile: "computer-use-stage1-v1",
  qualificationEvidence: Object.fromEntries(qualificationAreas.map((key) => [key, "f".repeat(64)])),
});

describe("dormant tuple identity", () => {
  it("retains the legacy selected release without making supervised claims", () => {
    expect(CUA_DRIVER_VERSION).toBe("0.38.0");
    expect(selectedComputerUseTuple).toEqual({
      kind: "legacy",
      driverVersion: "0.38.0",
      supervised: false,
    });
  });
  it("accepts only complete detached identity shape, not a qualification assertion", () => {
    const input = manifest();
    const parsed = parseComputerUseTupleManifest(input);
    input.nativeClosure[0]!.sha256 = "0".repeat(64);
    input.qualificationEvidence.capture = "0".repeat(64);
    expect(parsed.nativeClosure[0]!.sha256).toBe("e".repeat(64));
    expect(parsed.qualificationEvidence.capture).toBe("f".repeat(64));
    expect(Object.isFrozen(parsed.nativeClosure[0])).toBe(true);
    expect(selectedComputerUseTuple.supervised).toBe(false);
  });
  it.each(Object.keys(manifest()))("rejects a missing tuple field %s", (key) => {
    const input = { ...manifest() } as Record<string, unknown>;
    delete input[key];
    expect(() => parseComputerUseTupleManifest(input)).toThrow();
  });
  it("does not infer a missing route/control qualification or worker closure", () => {
    for (const key of qualificationAreas) {
      const input = manifest();
      delete input.qualificationEvidence[key];
      expect(() => parseComputerUseTupleManifest(input)).toThrow();
    }
    for (const role of ["guard", "owner", "worker", "broker"]) {
      const input = manifest();
      input.nativeClosure = input.nativeClosure.filter((entry) => entry.role !== role);
      expect(() => parseComputerUseTupleManifest(input)).toThrow();
    }
  });
  it("rejects incompatible pins/formats/roots/hashes rather than downgrading", () => {
    for (const patch of [
      { backend: "native-sdk" },
      { driverVersion: "0.9.1" },
      { driverSource: "0".repeat(40) },
      { protocolMajor: 2 },
      { adapterVersion: 1 },
      { stateRoot: "/tmp/profile" },
      { policyFormat: 2 },
      { archiveSha256: "unverified" },
      { extra: true },
    ])
      expect(() => parseComputerUseTupleManifest({ ...manifest(), ...patch })).toThrow();
  });
});
