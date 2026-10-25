import { expect, it } from "vitest";
import { hasOpencodeV2NativeTrust, hasOpencodeV2ManagedPluginTrust } from "./opencodeNativeTrust";

it("historical native execution trust never acquires automatic plugin write authority", () => {
  expect(hasOpencodeV2NativeTrust({ nativeServiceTrust: "host-user-v1" })).toBe(true);
  expect(hasOpencodeV2ManagedPluginTrust({ nativeServiceTrust: "host-user-v1" })).toBe(false);
  expect(hasOpencodeV2NativeTrust({ nativeServiceTrust: "managed-thread-tools-v2" })).toBe(true);
  expect(hasOpencodeV2ManagedPluginTrust({ nativeServiceTrust: "managed-thread-tools-v2" })).toBe(
    true,
  );
  for (const nativeServiceTrust of [undefined, null, "unknown"]) {
    expect(hasOpencodeV2NativeTrust({ nativeServiceTrust })).toBe(false);
    expect(hasOpencodeV2ManagedPluginTrust({ nativeServiceTrust })).toBe(false);
  }
});
