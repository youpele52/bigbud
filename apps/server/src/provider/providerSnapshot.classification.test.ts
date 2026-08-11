import type { ServerProviderFailure } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  classifyProviderExecutionFailure,
  classifyProviderFailure,
  type ProviderProbeResult,
} from "./providerSnapshot";

const probe = (overrides: Partial<ProviderProbeResult> = {}): ProviderProbeResult => ({
  installed: true,
  version: "1.0.0",
  status: "error",
  auth: { status: "unknown" },
  ...overrides,
});

describe("classifyProviderFailure", () => {
  it("does not classify healthy or disabled provider snapshots", () => {
    expect(classifyProviderFailure({ enabled: true, probe: probe({ status: "ready" }) })).toBe(
      undefined,
    );
    expect(classifyProviderFailure({ enabled: false, probe: probe() })).toBe(undefined);
  });

  it("classifies execution failures without exposing configured paths", () => {
    expect(
      classifyProviderExecutionFailure({
        message: "spawn opencode ENOENT",
        binaryPath: "opencode",
        defaultBinaryPath: "opencode",
      }),
    ).toEqual({ classification: "user-action-required", reason: "command-not-found" });
    expect(
      classifyProviderExecutionFailure({
        message: "spawn /private/custom ENOENT",
        binaryPath: "/private/custom",
        defaultBinaryPath: "opencode",
      }),
    ).toEqual({ classification: "user-action-required", reason: "invalid-binary-path" });
    expect(
      classifyProviderExecutionFailure({
        message: "connect ECONNREFUSED 127.0.0.1",
        binaryPath: "opencode",
        defaultBinaryPath: "opencode",
      }),
    ).toEqual({ classification: "retryable", reason: "connection-refused" });
  });

  it("classifies missing commands and authentication as user action", () => {
    expect(classifyProviderFailure({ enabled: true, probe: probe({ installed: false }) })).toEqual({
      classification: "user-action-required",
      reason: "command-not-found",
    });
    expect(
      classifyProviderFailure({
        enabled: true,
        probe: probe({ auth: { status: "unauthenticated" } }),
      }),
    ).toEqual({ classification: "user-action-required", reason: "authentication-required" });
  });

  it.each<ServerProviderFailure>([
    { classification: "retryable", reason: "startup-timeout" },
    { classification: "retryable", reason: "process-failed" },
    { classification: "retryable", reason: "connection-refused" },
    { classification: "user-action-required", reason: "unsupported-version" },
    { classification: "user-action-required", reason: "invalid-binary-path" },
    { classification: "user-action-required", reason: "configuration-required" },
  ])("preserves a provider-specific $reason classification", (failure) => {
    expect(classifyProviderFailure({ enabled: true, probe: probe({ failure }) })).toEqual(failure);
  });
});
