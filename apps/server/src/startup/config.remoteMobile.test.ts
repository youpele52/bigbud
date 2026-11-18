import { describe, expect, it } from "vitest";
import { Redacted } from "effect";
import { resolveRemoteMobileConfiguration } from "./config.remoteMobile.ts";

const valid = {
  mode: "remote",
  enabled: true,
  gatewayCredential: "g".repeat(32),
  clientToken: "c".repeat(32),
};
describe("remote mobile extension configuration", () => {
  it("defaults off without consuming existing desktop gateway configuration", () => {
    expect(
      resolveRemoteMobileConfiguration({
        ...valid,
        enabled: false,
        mode: "desktop",
        gatewayCredential: undefined,
      }),
    ).toBeUndefined();
  });
  it("requires separate usable credentials and the owning remote profile", () => {
    for (const gatewayCredential of [
      undefined,
      "",
      "short",
      "g".repeat(257),
      "g".repeat(31) + " ",
      "g".repeat(31) + "\n",
      "g".repeat(31) + "é",
      valid.clientToken,
    ]) {
      expect(() => resolveRemoteMobileConfiguration({ ...valid, gatewayCredential })).toThrow(
        "separate gateway credential",
      );
    }
    for (const mode of ["web", "desktop"])
      expect(() => resolveRemoteMobileConfiguration({ ...valid, mode })).toThrow(
        "remote backend mode",
      );
  });
  it("keeps configured upstream credentials redacted", () => {
    const configured = resolveRemoteMobileConfiguration(valid)!;
    expect(Redacted.value(configured.gatewayCredential)).toBe(valid.gatewayCredential);
    expect(JSON.stringify(configured)).not.toContain(valid.gatewayCredential);
  });
});
