import { describe, expect, it } from "vitest";
import { normalizeComputerUsePermissionMessage } from "./computerUsePermissionMessage";

describe("normalizeComputerUsePermissionMessage", () => {
  it("preserves mixed permission statuses in separate emoji-free lines", () => {
    expect(
      normalizeComputerUsePermissionMessage(
        "✅ Accessibility: granted. ❌ Screen Recording: not granted. ℹ️ Embedded mode: status reflects the HOST app's TCC grant.",
      ),
    ).toBe(
      "Accessibility: granted.\nScreen Recording: not granted.\nEmbedded mode: status reflects the HOST app's TCC grant.",
    );
  });

  it("normalizes one driver status per line without changing unmarked content", () => {
    expect(
      normalizeComputerUsePermissionMessage(
        "✅ Accessibility: granted.\n❌ Screen Recording: not granted.\nℹ️ Open System Settings.",
      ),
    ).toBe("Accessibility: granted.\nScreen Recording: not granted.\nOpen System Settings.");
  });
});
