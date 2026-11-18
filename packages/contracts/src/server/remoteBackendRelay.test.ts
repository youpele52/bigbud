import { expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  RemoteBackendRelayOpenInput,
  RemoteBackendRelayLease,
  RemoteBackendRelayCloseInput,
} from "./remoteBackendRelay";

it("renderer selection contains only a saved profile ID, never deployment or credential input", () => {
  expect(
    Schema.decodeUnknownSync(RemoteBackendRelayOpenInput)({
      profileId: "saved-profile",
      requestId: "12345678-1234-4123-8123-123456789abc",
      nodeBinary: "/attacker/node",
      command: "unsafe",
      helperSha256: "a".repeat(64),
      remoteToken: "private",
    }),
  ).toEqual({ profileId: "saved-profile", requestId: "12345678-1234-4123-8123-123456789abc" });
  for (const profileId of ["", "../profile", "profile/other", "x".repeat(129)])
    expect(() =>
      Schema.decodeUnknownSync(RemoteBackendRelayOpenInput)({
        profileId,
        requestId: "12345678-1234-4123-8123-123456789abc",
      }),
    ).toThrow();
});
it("lease transport addresses are local capabilities, not remote renderer endpoints", () => {
  const lease = {
    leaseId: "12345678-1234-4123-8123-123456789abc",
    profileId: "saved-profile",
    baseUrl: "http://127.0.0.1:3210",
    localCredential: "a".repeat(64),
  };
  expect(Schema.decodeUnknownSync(RemoteBackendRelayLease)(lease)).toEqual(lease);
  for (const baseUrl of [
    "https://remote.example:3210",
    "http://10.0.0.1:3210",
    "http://127.0.0.1:3210/path",
    "http://user@127.0.0.1:3210",
  ])
    expect(() =>
      Schema.decodeUnknownSync(RemoteBackendRelayLease)({ ...lease, baseUrl }),
    ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(RemoteBackendRelayCloseInput)({ leaseId: "-".repeat(36) }),
  ).toThrow();
});
