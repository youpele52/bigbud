import { describe, expect, it } from "vitest";
import {
  isTransportOnlyTargetChange,
  sshExecutionTargetTransportVariants,
} from "./sshExecutionTarget.transport.ts";

const direct = "ssh:host=dev-1&auth=password&transport=direct-ssh";
const agent = "ssh:host=dev-1&auth=password&transport=agent";

describe("isTransportOnlyTargetChange", () => {
  it("accepts a switch between transports, explicit or default, in any parameter order", () => {
    expect(isTransportOnlyTargetChange(direct, agent)).toBe(true);
    expect(isTransportOnlyTargetChange(agent, "ssh:host=dev-1&auth=password")).toBe(true);
    expect(
      isTransportOnlyTargetChange(direct, "ssh:transport=agent&auth=password&host=dev-1"),
    ).toBe(true);
    expect(isTransportOnlyTargetChange("ssh:dev-1", "ssh:host=dev-1&transport=agent")).toBe(true);
  });
  it("rejects identical, local, and any host/user/port/auth/key change", () => {
    expect(isTransportOnlyTargetChange(direct, direct)).toBe(false);
    expect(isTransportOnlyTargetChange("local", agent)).toBe(false);
    expect(isTransportOnlyTargetChange(direct, "local")).toBe(false);
    expect(
      isTransportOnlyTargetChange(direct, "ssh:host=dev-2&auth=password&transport=agent"),
    ).toBe(false);
    expect(
      isTransportOnlyTargetChange(direct, "ssh:host=dev-1&user=root&auth=password&transport=agent"),
    ).toBe(false);
    expect(
      isTransportOnlyTargetChange(direct, "ssh:host=dev-1&auth=password&port=2222&transport=agent"),
    ).toBe(false);
    expect(isTransportOnlyTargetChange(direct, "ssh:host=dev-1&auth=ssh-key&transport=agent")).toBe(
      false,
    );
  });
});

describe("sshExecutionTargetTransportVariants", () => {
  it("lists the exact target first and every transport form of the same target", () => {
    const variants = sshExecutionTargetTransportVariants(agent);
    expect(variants[0]).toBe(agent);
    expect(variants).toContain(direct);
    expect(variants).toContain("ssh:host=dev-1&auth=password");
    expect(new Set(variants).size).toBe(variants.length);
    for (const variant of variants.slice(1))
      expect(isTransportOnlyTargetChange(agent, variant)).toBe(true);
  });
  it("returns only the exact target for non-SSH targets", () => {
    expect(sshExecutionTargetTransportVariants("local")).toEqual(["local"]);
  });
});
