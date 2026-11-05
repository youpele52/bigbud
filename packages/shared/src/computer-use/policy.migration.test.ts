import { COMPUTER_USE_POLICY_FORMAT } from "@bigbud/contracts/core/settings.computerUsePolicy";
import { describe, expect, it } from "vitest";

import { sealPolicy, verifyPolicy } from "./policy.digest";
import { recoverComputerUsePolicy, type PolicyRecoveryInput } from "./policy.migration";

const input = (settings: unknown, nativeMigrationKnown = false): PolicyRecoveryInput => ({
  settings,
  nativeMigrationKnown,
  authorityId: "authority-2",
});
const sealed = (() => {
  const result = sealPolicy({
    format: COMPUTER_USE_POLICY_FORMAT,
    authorityId: "authority-1",
    revision: "9",
    enabled: true,
    disallowedApps: [{ platform: "macos", kind: "bundle_id", value: "com.apple.Terminal" }],
    defaultDeliveryMode: "background",
    checkInIntervalMs: 120_000,
    actionTimeoutMs: 30_000,
    diagnosticMetadataEnabled: true,
  });
  if (!result.ok) throw new Error("seal");
  return JSON.parse(JSON.stringify(result.group)) as Record<string, unknown>;
})();
const reason = (settings: unknown, known = false) => {
  const recovered = recoverComputerUsePolicy(input(settings, known));
  return recovered.kind === "fail_closed" ? recovered.reason : recovered.kind;
};

describe("recoverComputerUsePolicy", () => {
  it("returns a valid protected group unchanged, even beside legacy fields", () => {
    const recovered = recoverComputerUsePolicy(
      input({ computerUsePolicy: sealed, computerUseEnabled: false }, true),
    );
    expect(recovered).toEqual({ kind: "current", group: sealed });
  });

  it("migrates a recognized legacy format once as intent requiring Resume", () => {
    const recovered = recoverComputerUsePolicy(
      input({ computerUseEnabled: true, computerUseActionTimeoutMs: 10_500 }),
    );
    expect(recovered.kind).toBe("migrated");
    if (recovered.kind !== "migrated") return;
    expect(recovered.requiresResume).toBe(true);
    expect(recovered.group).toMatchObject({
      authorityId: "authority-2",
      revision: "1",
      enabled: true,
      disallowedApps: [],
      defaultDeliveryMode: "foreground",
      checkInIntervalMs: 600_000,
      actionTimeoutMs: 10_500,
      diagnosticMetadataEnabled: false,
    });
    expect(verifyPolicy(recovered.group).ok).toBe(true);
  });

  it("creates a disabled group for a new installation", () => {
    const recovered = recoverComputerUsePolicy(input({ theme: "dark" }));
    expect(recovered.kind === "new_install" && recovered.group.enabled).toBe(false);
  });

  it("fails closed instead of recovering field by field", () => {
    const without = (key: string) => {
      const copy = { ...sealed };
      delete copy[key];
      return copy;
    };
    expect(reason({ computerUsePolicy: without("disallowedApps") })).toBe("corrupt");
    expect(reason({ computerUsePolicy: without("digest") })).toBe("corrupt");
    expect(reason({ computerUsePolicy: { ...sealed, extra: true } })).toBe("corrupt");
    expect(reason({ computerUsePolicy: null })).toBe("corrupt");
    expect(
      reason({ computerUsePolicy: { ...sealed, format: "bigbud.computerUsePolicy.v2" } }),
    ).toBe("unsupported_format");
    expect(reason({ computerUsePolicy: { ...sealed, enabled: false } })).toBe("digest_mismatch");
    expect(reason({ computerUsePolicy: { ...sealed, disallowedApps: [] } })).toBe(
      "digest_mismatch",
    );
    expect(reason({}, true)).toBe("marker_lost");
    expect(reason({ computerUseEnabled: true }, true)).toBe("marker_lost");
    expect(reason({ computerUseEnabled: "yes" })).toBe("unrecognized_legacy");
    expect(reason({ computerUseCheckInIntervalMs: 59_999 })).toBe("unrecognized_legacy");
    expect(reason({ computerUseEnabled: null })).toBe("unrecognized_legacy");
    expect(reason({ computerUseActionTimeoutMs: null })).toBe("unrecognized_legacy");
    expect(reason([])).toBe("corrupt");
    expect(reason("settings")).toBe("corrupt");
    expect(
      recoverComputerUsePolicy({
        settings: {},
        nativeMigrationKnown: false,
        authorityId: "bad id",
      }),
    ).toEqual({ kind: "fail_closed", reason: "invalid_authority" });
  });
});
