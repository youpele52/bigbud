import { describe, expect, it } from "vitest";
import {
  getProviderReadOnlyMessage,
  isActiveModelSelection,
  isLegacyOpencodeThread,
  isReadOnlyProviderThread,
  KILOCODE_READ_ONLY_MESSAGE,
  requireActiveModelSelection,
} from "./providerLifecycle";

describe("removed provider history admission", () => {
  it.each([
    { modelSelection: { provider: "kilocode" } },
    { session: { provider: "kilocode" } },
    { session: { providerName: "kilocode" } },
  ])("makes saved KiloCode identities read-only: %j", (thread) => {
    expect(isReadOnlyProviderThread(thread)).toBe(true);
    expect(isLegacyOpencodeThread(thread)).toBe(false);
    expect(getProviderReadOnlyMessage("kilocode")).toBe(KILOCODE_READ_ONLY_MESSAGE);
  });

  it("rejects retired selections at runtime boundaries without substituting a model", () => {
    for (const provider of ["kilocode", "opencode"]) {
      const selection = { provider, model: "saved-model" };
      expect(isActiveModelSelection(selection)).toBe(false);
      expect(() => requireActiveModelSelection(selection)).toThrow("Choose an available provider");
      expect(selection).toEqual({ provider, model: "saved-model" });
    }
  });

  it("preserves active selections and V2 editability", () => {
    const selection = { provider: "opencodeV2", model: "current-model" } as const;
    expect(requireActiveModelSelection(selection)).toBe(selection);
    expect(isReadOnlyProviderThread({ modelSelection: selection })).toBe(false);
  });
});
