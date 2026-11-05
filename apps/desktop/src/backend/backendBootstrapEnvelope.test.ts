import type { DESKTOP_LIFECYCLE_HINT_FD } from "@bigbud/contracts/server/desktopLifecycleHint.ts";
import { describe, expect, it } from "vitest";

import {
  buildBackendBootstrapEnvelope,
  consumeBackendStartReason,
  markNextBackendStartReason,
  takeComputerUseOwnerAccess,
} from "./backendBootstrapEnvelope";
import { BACKEND_LIFECYCLE_HINT_STDIO_INDEX } from "./backendLifecycleHintPipe";

const base = { port: 3773, host: "127.0.0.1", t3Home: "/home/u/.bigbud", authToken: "token" };

describe("backend bootstrap envelope", () => {
  it("writes one JSON line without optional fields on an ordinary start", () => {
    const line = buildBackendBootstrapEnvelope({ ...base, startReason: null });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ mode: "desktop", noBrowser: true, ...base });
  });

  it("carries the resume-probe start reason and observability settings", () => {
    const envelope = JSON.parse(
      buildBackendBootstrapEnvelope({
        ...base,
        systemMonitorAgentAccess: { endpoint: "http://127.0.0.1:1", token: "agent" },
        otlpTracesUrl: "http://otel/traces",
        startReason: "resume-probe-restart",
      }),
    );
    expect(envelope).toMatchObject({
      startReason: "resume-probe-restart",
      otlpTracesUrl: "http://otel/traces",
      systemMonitorAgentAccess: { token: "agent" },
    });
    expect(envelope).not.toHaveProperty("otlpMetricsUrl");
  });

  it("announces the lifecycle hint fd only when spawn opened the pipe", () => {
    const announced = JSON.parse(
      buildBackendBootstrapEnvelope({
        ...base,
        lifecycleHintFd: BACKEND_LIFECYCLE_HINT_STDIO_INDEX,
      }),
    );
    expect(announced.lifecycleHintFd).toBe(5);
    const silent = JSON.parse(buildBackendBootstrapEnvelope({ ...base, lifecycleHintFd: null }));
    expect(silent).not.toHaveProperty("lifecycleHintFd");
  });

  it("keeps the local hint fd equal to the contract the server reads", () => {
    // Pinned by type: the desktop build cannot import the contracts value at runtime (Thread N
    // note 7), but `bun typecheck` fails here if either fd number changes alone.
    const contractFd: typeof DESKTOP_LIFECYCLE_HINT_FD = BACKEND_LIFECYCLE_HINT_STDIO_INDEX;
    expect(contractFd).toBe(5);
  });

  it("uses a resume-probe start reason for exactly the next start", () => {
    expect(consumeBackendStartReason()).toBeNull();
    markNextBackendStartReason("resume-probe-restart");
    expect(consumeBackendStartReason()).toBe("resume-probe-restart");
    expect(consumeBackendStartReason()).toBeNull();
  });

  it("leaves the envelope byte-identical when no computer-use owner access exists", () => {
    const full = {
      ...base,
      systemMonitorAgentAccess: { endpoint: "http://127.0.0.1:1", token: "agent" },
      startReason: "resume-probe-restart" as const,
      lifecycleHintFd: 5,
      ownershipHandoff: true,
    };
    const today = buildBackendBootstrapEnvelope(full);
    expect(buildBackendBootstrapEnvelope({ ...full, computerUseOwner: null })).toBe(today);
    expect(today).not.toContain("computerUseOwner");
  });

  it("carries exactly the four owner access fields when access exists", () => {
    const access = {
      endpoint: "/run/owner.sock",
      capability: "one-use-capability",
      tupleDigest: "sha256:tuple",
      ownerGeneration: "7",
      extra: "must not leak",
    };
    const envelope = JSON.parse(
      buildBackendBootstrapEnvelope({ ...base, computerUseOwner: access }),
    );
    expect(envelope.computerUseOwner).toEqual({
      endpoint: "/run/owner.sock",
      capability: "one-use-capability",
      tupleDigest: "sha256:tuple",
      ownerGeneration: "7",
    });
  });

  it("takes owner access from the provider, treating none or a failing provider as null", () => {
    const access = { endpoint: "e", capability: "c", tupleDigest: "t", ownerGeneration: "g" };
    expect(takeComputerUseOwnerAccess(undefined)).toBeNull();
    expect(takeComputerUseOwnerAccess(() => null)).toBeNull();
    expect(takeComputerUseOwnerAccess(() => access)).toBe(access);
    expect(
      takeComputerUseOwnerAccess(() => {
        throw new Error("owner not ready");
      }),
    ).toBeNull();
  });
});
