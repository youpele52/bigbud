import { expect, it } from "vitest";
import {
  decodeMobileOwnerPairingInput,
  decodeMobileOwnerPairingResult,
} from "./mobileOwnerPairing.protocol.ts";
const input = {
  authorityId: "a".repeat(32),
  scope: "approve-only" as const,
  backendOrigin: "https://fixture.ts.net",
};
const result = {
  pairingId: "fixture-pair",
  scope: input.scope,
  expiresAt: "2099-01-01T00:00:00Z",
  secret: "fixture-secret",
  pairUrl:
    "https://fixture.ts.net/mobile/pair/fixture-pair?backend=https%3A%2F%2Ffixture.ts.net#secret=fixture-secret",
};
it("requires explicit authority/scope and a canonical credential-free HTTPS origin", () => {
  expect(decodeMobileOwnerPairingInput(input)).toEqual(input);
  for (const change of [
    { authorityId: "../other" },
    { scope: "admin" },
    { token: "private" },
    { backendOrigin: "http://fixture.ts.net" },
    { backendOrigin: "https://u:p@fixture.ts.net" },
    { backendOrigin: "https://fixture.ts.net/" },
    { backendOrigin: "https://fixture.ts.net/mobile" },
    { backendOrigin: "https://fixture.ts.net?q=secret" },
    { backendOrigin: "https://fixture.ts.net#secret" },
  ])
    expect(() => decodeMobileOwnerPairingInput({ ...input, ...change })).toThrow();
  expect(() =>
    decodeMobileOwnerPairingInput({
      backendOrigin: input.backendOrigin,
      authorityId: input.authorityId,
    }),
  ).toThrow();
});
it("validates future scope-bound host-served one-time links before intentional output", () => {
  expect(decodeMobileOwnerPairingResult(result, input)).toEqual(result);
  for (const change of [
    { expiresAt: "invalid" },
    { expiresAt: "2099-01-01T00:00:00Z\n" },
    { pairUrl: result.pairUrl.replace("https://", "https://\n") },
    { expiresAt: "2001-01-01T00:00:00Z" },
    { scope: "thread-control" },
    { secret: "different" },
    { pairUrl: result.pairUrl.replace("fixture.ts.net/mobile", "foreign.invalid/mobile") },
    { pairUrl: result.pairUrl.replace("/pair/fixture-pair", "/pair/other") },
    { pairUrl: result.pairUrl + "&extra=secret" },
    { pairUrl: result.pairUrl.replace("?backend=", "?extra=bad&backend=") },
    { token: "backend-private" },
  ])
    expect(() => decodeMobileOwnerPairingResult({ ...result, ...change }, input)).toThrow();
});
