import { describe, expect, it } from "vitest";
import {
  describeBlockingWork,
  describeUpdateState,
  liveOperation,
  readRemoteRuntimeUpdateFailure,
  resolveUpdateAvailability,
  resolveUpdateTarget,
} from "./RemoteBackendUpdate.logic";
import { updateTransitionToast } from "./RemoteBackendUpdate.toast";
import {
  APPROVAL,
  handshake,
  operation,
  status,
  TURN,
  typedError,
} from "./RemoteBackendUpdate.test.fixtures";

const bound = {
  kind: "bound",
  profileId: "vps-1",
  label: "Build VPS",
  http: { origin: "http://127.0.0.1:4100", headers: {} },
} as const;

describe("update availability", () => {
  it("is hidden outside a bound window, even with a handshake", () => {
    expect(resolveUpdateAvailability({ kind: "local" }, handshake(true))).toEqual({
      kind: "hidden",
    });
    expect(resolveUpdateAvailability({ kind: "binding", profileId: "vps-1" }, null).kind).toBe(
      "hidden",
    );
  });

  it("needs runtimeUpdates in the bound handshake", () => {
    expect(resolveUpdateAvailability(bound, handshake(false))).toEqual({
      kind: "unsupported",
      backendVersion: "0.8.0",
    });
    expect(resolveUpdateAvailability(bound, null)).toEqual({
      kind: "unsupported",
      backendVersion: null,
    });
    expect(resolveUpdateAvailability(bound, handshake(true))).toEqual({
      kind: "available",
      backendVersion: "0.8.0",
    });
  });
});

describe("state to UI mapping", () => {
  it("maps every state to a tone and the allowed actions", () => {
    const rows = (
      [
        "pending",
        "staging",
        "staged",
        "awaiting-drain",
        "deferred",
        "activating",
        "activated",
        "failed",
        "cancelled",
      ] as const
    ).map((state) => {
      const view = describeUpdateState(status(operation(state), [TURN]))!;
      return [state, view.tone, view.canCancel, view.canInterrupt];
    });
    expect(rows).toEqual([
      ["pending", "loading", true, false],
      ["staging", "loading", true, false],
      ["staged", "loading", true, true],
      ["awaiting-drain", "loading", true, true],
      ["deferred", "warning", true, true],
      ["activating", "loading", false, false],
      ["activated", "success", false, false],
      ["failed", "error", false, false],
      ["cancelled", "info", false, false],
    ]);
  });

  it("shows deferral reasons from the reported affected work", () => {
    const view = describeUpdateState(status(operation("deferred"), [TURN, APPROVAL, TURN]))!;
    expect(view.reasons).toEqual(["2 running turns", "1 pending approval"]);
    const silent = describeUpdateState(status(operation("deferred")))!;
    expect(silent.reasons).toEqual([]);
    expect(silent.description).toMatch(/did not report which work blocks it/);
    expect(silent.canInterrupt).toBe(false);
  });

  it("offers no interrupt once consent was used or without a digest", () => {
    expect(
      describeUpdateState(status(operation("deferred", { consent: "consumed" }), [TURN]))!
        .canInterrupt,
    ).toBe(false);
    expect(describeUpdateState(status(operation("deferred"), [TURN], null))!.canInterrupt).toBe(
      false,
    );
  });

  it("uses the server failure text and treats terminal operations as history", () => {
    const failed = operation("failed", { failure: "Disk full on the backend." });
    expect(describeUpdateState(status(failed))!.description).toBe("Disk full on the backend.");
    expect(liveOperation(status(failed))).toBeNull();
    expect(liveOperation(status(operation("staging")))?.state).toBe("staging");
    expect(describeUpdateState(status(null))).toBeNull();
  });

  it("describes every work kind with counts", () => {
    expect(
      describeBlockingWork([
        { kind: "user-input", id: "q", label: "q" },
        { kind: "shell", id: "s", label: "s" },
        { kind: "other", id: "o", label: "o" },
      ]),
    ).toEqual([
      "1 question waiting for an answer",
      "1 running shell command",
      "1 other running task",
    ]);
  });
});

describe("update target", () => {
  it("targets this computer's version", () => {
    expect(resolveUpdateTarget("0.9.0", "0.8.0")).toEqual({
      kind: "requestable",
      version: "0.9.0",
    });
    expect(resolveUpdateTarget("0.9.0", "0.9.0").kind).toBe("current");
    expect(resolveUpdateTarget("bad version", "0.8.0").kind).toBe("invalid");
  });
});

describe("typed failures and toasts", () => {
  it("reads only RemoteRuntimeUpdateError", () => {
    expect(readRemoteRuntimeUpdateFailure(typedError("consent-stale"))).toEqual({
      code: "consent-stale",
      message: "consent-stale message",
    });
    expect(readRemoteRuntimeUpdateFailure(new Error("socket closed"))).toBeNull();
    expect(readRemoteRuntimeUpdateFailure({ _tag: "Other", code: "consent-stale" })).toBeNull();
  });

  it("toasts transitions with severity, never on the first read or a repeat", () => {
    const deferred = operation("deferred");
    expect(updateTransitionToast(undefined, deferred)).toBeNull();
    expect(updateTransitionToast(deferred, deferred)).toBeNull();
    expect(updateTransitionToast(operation("awaiting-drain"), deferred)?.type).toBe("warning");
    expect(updateTransitionToast(deferred, operation("activated"))?.type).toBe("success");
    expect(updateTransitionToast(deferred, operation("failed"))?.type).toBe("error");
    expect(updateTransitionToast(deferred, operation("cancelled"))?.type).toBe("info");
    expect(updateTransitionToast(null, operation("staging"))).toBeNull();
  });
});
