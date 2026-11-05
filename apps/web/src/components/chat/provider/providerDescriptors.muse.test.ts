import { describe, expect, it } from "vitest";

import { getProviderDescriptor, PROVIDER_OPTIONS } from "./providerDescriptors";

describe("Muse Code descriptor", () => {
  it("is catalog-authoritative, attachment-free and keeps sub-provider identity", () => {
    const descriptor = getProviderDescriptor("muse");
    expect(descriptor.label).toBe("Muse Code");
    expect(descriptor.catalogAuthoritative).toBe(true);
    expect(descriptor.supportsSubProviderID).toBe(true);
    expect(descriptor.customModels).toBeNull();
    expect(descriptor.attachments?.supported).toBe(false);
    expect(descriptor.attachments?.unavailableReason).toContain("does not accept attachments");
    expect(descriptor.settings.setupUrl).toBe("https://dev.meta.ai/docs/muse-code");
    expect(String(descriptor.settings.path.description)).toContain("never signs in for you");
  });

  it("appears in picker options without fabricated availability", () => {
    expect(PROVIDER_OPTIONS.find((option) => option.value === "muse")).toEqual({
      value: "muse",
      label: "Muse Code",
      available: true,
    });
  });
});
