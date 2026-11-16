import * as Effect from "effect/Effect";
import { expect, it, vi } from "vitest";
import { createLegacyMobilePairing } from "./mobileOwnerPairing.legacy.ts";
const input = {
  scope: "thread-control" as const,
  baseUrl: "http://192.0.2.1/mobile",
  backendBaseUrl: "http://192.0.2.1",
};
const result = {
  pairingId: "fixture",
  scope: input.scope,
  expiresAt: "2099-01-01T00:00:00Z",
  pairUrl: "http://192.0.2.1/mobile/pair/fixture#secret=fixture",
  secret: "fixture",
};
it("remote legacy RPC refuses before even constructing an issuer effect", async () => {
  const issue = vi.fn((_value: Parameters<typeof createLegacyMobilePairing>[2]) =>
    Effect.succeed(result),
  );
  await expect(
    Effect.runPromise(createLegacyMobilePairing("remote", issue, input)),
  ).rejects.toThrow("bigbud mobile pair");
  expect(issue).not.toHaveBeenCalled();
});
it.each(["desktop", "web"] as const)(
  "preserves %s legacy issuance and exact original input",
  async (mode) => {
    const issue = vi.fn((_value: Parameters<typeof createLegacyMobilePairing>[2]) =>
      Effect.succeed(result),
    );
    expect(await Effect.runPromise(createLegacyMobilePairing(mode, issue, input))).toBe(result);
    expect(issue).toHaveBeenCalledOnce();
    expect(issue.mock.calls[0]?.[0]).toBe(input);
  },
);
