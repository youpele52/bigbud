import { describe, expect, it } from "vitest";

import { CUA_DRIVER_VERSION } from "../cua-driver/release";
import {
  COMPUTER_USE_SUPERVISED_DEV_ENV,
  manifestMatchesVerifiedArtifact,
  resolveSupervisedExecutionGate,
  selectedComputerUseContractProfile,
} from "./selection";
import {
  parseComputerUseTupleManifest,
  proposedComputerUseDriver,
  qualificationAreas,
} from "./tuple";

const qualified = (platform = "darwin", arch = "arm64") => ({
  format: 1,
  id: "synthetic-test-only",
  protocolMajor: 1,
  protocolMinor: 0,
  adapterVersion: 2,
  backend: "mediated-mcp",
  driverVersion: "0.38.0",
  driverSource: proposedComputerUseDriver.source,
  platform,
  arch,
  archiveSha256: "a".repeat(64),
  binarySha256: "b".repeat(64),
  toolSchemaSha256: "c".repeat(64),
  policyFormat: 1,
  policySha256: "d".repeat(64),
  stateFormat: 1,
  stateRoot: "per-user-computer-use-v1",
  hostIdentity: "ai.bigbud.desktop",
  nativeClosure: ["guard", "owner", "worker", "broker"].map((role) => ({
    role,
    sha256: "e".repeat(64),
    codeIdentity: `${role}-identity`,
  })),
  qualificationProfile: "computer-use-stage1-v1",
  qualificationEvidence: Object.fromEntries(qualificationAreas.map((key) => [key, "f".repeat(64)])),
});

const base = {
  profile: "v2" as const,
  platform: "darwin",
  arch: "arm64",
  development: false,
  env: {},
};

describe("computer-use selection", () => {
  it("keeps the legacy contract independent of the pinned Driver", () => {
    // Lean upgrade M1: a Driver bump (0.9.1 or 0.38.0) never selects v2.
    expect(["0.9.1", "0.38.0"]).toContain(CUA_DRIVER_VERSION);
    expect(selectedComputerUseContractProfile).toBe("legacy");
  });

  it("keeps the supervised gate closed for the default profile even with the dev opt-in", () => {
    expect(
      resolveSupervisedExecutionGate({
        ...base,
        profile: selectedComputerUseContractProfile,
        development: true,
        env: { [COMPUTER_USE_SUPERVISED_DEV_ENV]: "1" },
      }),
    ).toEqual({ open: false, reason: "legacy-profile" });
  });

  it("never opens supervised execution under the legacy profile", () => {
    expect(
      resolveSupervisedExecutionGate({
        ...base,
        profile: "legacy",
        development: true,
        env: { [COMPUTER_USE_SUPERVISED_DEV_ENV]: "1" },
        manifest: qualified(),
      }),
    ).toEqual({ open: false, reason: "legacy-profile" });
  });

  it("does not open on the pin alone", () => {
    expect(resolveSupervisedExecutionGate(base)).toEqual({
      open: false,
      reason: "tuple-unqualified",
    });
    // The development opt-in is ignored outside the local dev app.
    expect(
      resolveSupervisedExecutionGate({ ...base, env: { [COMPUTER_USE_SUPERVISED_DEV_ENV]: "1" } }),
    ).toEqual({ open: false, reason: "tuple-unqualified" });
    // Only the exact value "1" opts in.
    expect(
      resolveSupervisedExecutionGate({
        ...base,
        development: true,
        env: { [COMPUTER_USE_SUPERVISED_DEV_ENV]: "true" },
      }),
    ).toEqual({ open: false, reason: "tuple-unqualified" });
  });

  it("opens for an explicit development opt-in", () => {
    expect(
      resolveSupervisedExecutionGate({
        ...base,
        development: true,
        env: { [COMPUTER_USE_SUPERVISED_DEV_ENV]: "1" },
      }),
    ).toEqual({ open: true, basis: "development-opt-in" });
  });

  it("never opens on a manifest: shape alone is not verification", () => {
    // Regression (review P2): a well-shaped manifest for the exact target used
    // to open the gate as "qualified-tuple" without any hash verification.
    expect(resolveSupervisedExecutionGate({ ...base, manifest: qualified() })).toEqual({
      open: false,
      reason: "tuple-unverified",
    });
    // Synthetic hashes never match a verified 0.38 release-table entry.
    expect(manifestMatchesVerifiedArtifact(parseComputerUseTupleManifest(qualified()))).toBe(false);
    expect(
      resolveSupervisedExecutionGate({ ...base, manifest: qualified("darwin", "x64") }),
    ).toEqual({ open: false, reason: "tuple-mismatch" });
    // A manifest does not fall through to the development opt-in either.
    expect(
      resolveSupervisedExecutionGate({
        ...base,
        development: true,
        env: { [COMPUTER_USE_SUPERVISED_DEV_ENV]: "1" },
        manifest: qualified(),
      }),
    ).toEqual({ open: false, reason: "tuple-unverified" });
    // A present but invalid manifest never falls through to the dev opt-in.
    expect(
      resolveSupervisedExecutionGate({
        ...base,
        development: true,
        env: { [COMPUTER_USE_SUPERVISED_DEV_ENV]: "1" },
        manifest: { ...qualified(), binarySha256: "short" },
      }),
    ).toEqual({ open: false, reason: "tuple-unqualified" });
  });
});
