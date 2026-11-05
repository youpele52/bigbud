import { describe, expect, it } from "vitest";
import { canEditFilePreview, canReconcileFilePreview } from "./fileEditEligibility";

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
});
