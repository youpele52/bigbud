import { describe, expect, it } from "vitest";

import { buildMobilePairUrl } from "./MobileRemoteControl";

describe("buildMobilePairUrl", () => {
  it("keeps the hosted mobile app origin separate from the backend origin", () => {
    expect(
      buildMobilePairUrl({
        baseUrl: "https://mobile.bigbud.app",
        pairingId: "pairing-1",
        backendBaseUrl: "https://y-macbook-pro.taildf5249.ts.net",
        secret: "secret-1",
      }),
    ).toBe(
      "https://mobile.bigbud.app/mobile/pair/pairing-1?backend=https%3A%2F%2Fy-macbook-pro.taildf5249.ts.net#secret=secret-1",
    );
  });

  it("normalizes a base url that already includes /mobile", () => {
    expect(
      buildMobilePairUrl({
        baseUrl: "https://mobile.bigbud.app/mobile",
        pairingId: "pairing-1",
        backendBaseUrl: "https://desktop.example",
        secret: "secret-1",
      }),
    ).toBe(
      "https://mobile.bigbud.app/mobile/pair/pairing-1?backend=https%3A%2F%2Fdesktop.example#secret=secret-1",
    );
  });
});
