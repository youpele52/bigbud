import type { ServerProvider } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { getProviderToastDecision } from "./ProviderRecoveryToastCoordinator.logic";

const provider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  provider: "cursor",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  models: [],
  slashCommands: [],
  skills: [],
  checkedAt: "2026-07-06T20:00:00.000Z",
  initialProbeComplete: true,
  ...overrides,
});

describe("getProviderToastDecision", () => {
  it("notifies as soon as one completed provider enters startup recovery", () => {
    const decision = getProviderToastDecision(
      [
        provider({
          status: "error",
          recovery: {
            operationId: "startup-1",
            generation: 1,
            attempt: 1,
            maxAttempts: 5,
            trigger: "startup",
            status: "retrying",
          },
          failure: { classification: "retryable", reason: "startup-timeout" },
        }),
        provider({ provider: "codex", initialProbeComplete: false }),
      ],
      { sawRecovery: false, notifiedInitialFailure: false },
    );
    expect(decision.kind).toBe("recovery");
    expect(decision.title).toBe("Starting providers");
    expect(decision.description).toContain("during launch");
  });

  it("explains when remaining attempts move into the background", () => {
    const decision = getProviderToastDecision(
      [
        provider({
          status: "error",
          recovery: {
            operationId: "startup-1",
            generation: 1,
            attempt: 3,
            maxAttempts: 5,
            trigger: "background",
            status: "retrying",
          },
          failure: { classification: "retryable", reason: "startup-timeout" },
        }),
      ],
      { sawRecovery: true, notifiedInitialFailure: false },
    );

    expect(decision.kind).toBe("recovery");
    expect(decision.description).toContain("in the background");
    expect(decision.description).toContain("keep working");
  });

  it("deduplicates reconnect snapshots and only succeeds after a warning", () => {
    const failing = provider({
      status: "error",
      recovery: {
        operationId: "startup-1",
        generation: 1,
        attempt: 1,
        maxAttempts: 5,
        trigger: "startup",
        status: "retrying",
      },
      failure: { classification: "retryable", reason: "startup-timeout" },
    });
    const warning = getProviderToastDecision([failing], {
      sawRecovery: false,
      notifiedInitialFailure: false,
    });
    expect(warning.kind).toBe("recovery");
    expect(getProviderToastDecision([failing], warning.state).kind).toBe("recovery");
    expect(getProviderToastDecision([provider()], warning.state).kind).toBe("success");
    expect(
      getProviderToastDecision([provider()], { sawRecovery: false, notifiedInitialFailure: false })
        .kind,
    ).toBe("none");
  });

  it("uses user-action wording and keeps affected providers for Settings expansion", () => {
    const decision = getProviderToastDecision(
      [
        provider({
          provider: "cursor",
          status: "error",
          failure: { classification: "user-action-required", reason: "authentication-required" },
        }),
        provider({
          provider: "copilot",
          enabled: false,
          status: "disabled",
          installed: false,
          failure: { classification: "user-action-required", reason: "command-not-found" },
        }),
      ],
      { sawRecovery: false, notifiedInitialFailure: false },
    );
    expect(decision.kind).toBe("attention");
    expect(decision.description).toContain("Cursor");
    expect(decision.affected.map((item) => item.provider)).toEqual(["cursor"]);
  });

  it("keeps concurrent recovery operations grouped by their authoritative operation ID", () => {
    const decision = getProviderToastDecision(
      [
        provider({
          provider: "opencode",
          status: "error",
          failure: { classification: "retryable", reason: "startup-timeout" },
          recovery: {
            operationId: "startup-1",
            generation: 1,
            attempt: 3,
            maxAttempts: 5,
            trigger: "background",
            status: "retrying",
          },
        }),
        provider({
          provider: "kilocode",
          status: "error",
          failure: { classification: "retryable", reason: "process-failed" },
          recovery: {
            operationId: "manual-2",
            generation: 2,
            attempt: 1,
            maxAttempts: 3,
            trigger: "manual",
            status: "retrying",
          },
        }),
      ],
      { sawRecovery: false, notifiedInitialFailure: false },
    );

    expect(decision.operationId).toBe("manual-2");
    expect(decision.affected.map((item) => item.provider)).toEqual(["kilocode"]);
    expect(decision.title).toBe("Retrying providers");
  });
});
