import { describe, expect, it } from "vitest";
import {
  canEditFilePreview,
  canReconcileFilePreview,
  fileEditReadOnlyReason,
} from "./fileEditEligibility";

const hash = "a".repeat(64);

describe("file preview edit eligibility", () => {
  it.each([undefined, "local", "ssh:host=dev&transport=agent"])(
    "allows conditional writes for %s",
    (executionTargetId) => {
      expect(
        canEditFilePreview({
          executionTargetId,
          sha256: hash,
          sizeBytes: 512 * 1024,
          truncated: false,
        }),
      ).toBe(true);
    },
  );

  it.each(["ssh:host=dev&transport=direct-ssh", "ssh:dev", "wsl:Ubuntu", "remote-agent:legacy"])(
    "keeps %s read-only",
    (executionTargetId) => {
      expect(
        canEditFilePreview({ executionTargetId, sha256: hash, sizeBytes: 5, truncated: false }),
      ).toBe(false);
    },
  );

  it("rejects incomplete, oversized, or unverified previews", () => {
    for (const input of [
      { sha256: null, sizeBytes: 5, truncated: false },
      { sha256: hash, sizeBytes: null, truncated: false },
      { sha256: hash, sizeBytes: 512 * 1024 + 1, truncated: false },
      { sha256: hash, sizeBytes: 5, truncated: true },
    ])
      expect(canEditFilePreview(input)).toBe(false);
  });

  it("allows full oversized reads for recovery, without enabling new edits", () => {
    const input = { sha256: hash, sizeBytes: 512 * 1024 + 1, truncated: false };
    expect(canReconcileFilePreview(input)).toBe(true);
    expect(canEditFilePreview(input)).toBe(false);
    expect(canReconcileFilePreview({ ...input, truncated: true })).toBe(false);
    expect(canReconcileFilePreview({ ...input, sha256: null })).toBe(false);
  });

  it("follows the server-reported capability over the target ID", () => {
    const preview = { sha256: hash, sizeBytes: 5, truncated: false };
    expect(
      canEditFilePreview({
        ...preview,
        executionTargetId: "ssh:host=dev&transport=direct-ssh",
        edit: { mode: "guarded", maxBytes: 512 * 1024 },
      }),
    ).toBe(true);
    expect(
      canEditFilePreview({
        ...preview,
        executionTargetId: "local",
        edit: { mode: "readOnly", maxBytes: 0, reason: "unsupportedTarget" },
      }),
    ).toBe(false);
    expect(
      canEditFilePreview({ ...preview, sizeBytes: 10, edit: { mode: "guarded", maxBytes: 5 } }),
    ).toBe(false);
  });

  it("explains read-only files from the capability, falling back to direct SSH", () => {
    expect(
      fileEditReadOnlyReason({
        edit: { mode: "readOnly", maxBytes: 0, reason: "directSshPendingOwner" },
      }),
    ).toBe("directSshPendingOwner");
    expect(fileEditReadOnlyReason({ edit: { mode: "guarded", maxBytes: 1 } })).toBeNull();
    expect(fileEditReadOnlyReason({ executionTargetId: "ssh:host=dev&transport=direct-ssh" })).toBe(
      "directSshPendingOwner",
    );
    expect(fileEditReadOnlyReason({ executionTargetId: "local" })).toBeNull();
  });
});
