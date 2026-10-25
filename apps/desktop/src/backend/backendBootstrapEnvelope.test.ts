import type { DESKTOP_LIFECYCLE_HINT_FD } from "@bigbud/contracts/server/desktopLifecycleHint.ts";
import { describe, expect, it } from "vitest";

import {
  buildBackendBootstrapEnvelope,
  consumeBackendStartReason,
  markNextBackendStartReason,
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
});
