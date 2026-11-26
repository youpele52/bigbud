import { describe, expect, it } from "vitest";

import type { RemoteExecutionAuthMode } from "../../../stores/remoteAccess/remoteAccess.store";
import type { RemoteThreadGateInput } from "./ThreadRemoteTargetGate.logic";
import {
  deriveRemoteThreadGateState,
  describeRemoteThreadGate,
} from "./ThreadRemoteTargetGate.logic";

const OLD = "2026-11-21T10:00:00.000Z";
const NEW = "2026-11-21T10:05:00.000Z";
const check = (
  status: NonNullable<RemoteThreadGateInput["check"]>["status"],
  updatedAt = OLD,
  authMode: RemoteExecutionAuthMode | null = null,
) => ({ status, message: `status ${status}`, tip: null, authMode, updatedAt });
const base: RemoteThreadGateInput = {
  isRemote: true,
  disconnectedTargetsLoaded: true,
  userDisconnected: false,
  check: undefined,
  failure: null,
  intent: "explicit",
  autoAttempted: false,
  authPending: false,
  latchedOpen: false,
};
const derive = (input: Partial<RemoteThreadGateInput>) =>
  deriveRemoteThreadGateState({ ...base, ...input });
const passwordFailure = {
  remoteTarget: { reason: "auth-required" as const, authMode: "password" as const },
  createdAt: NEW,
  detail: "SSH password is required for ice-2-kg. Re-enter it before using this target.",
};

describe("deriveRemoteThreadGateState", () => {
  it("passes through local targets, an unloaded disconnect list, user disconnects and latched visits", () => {
    for (const input of [
      { isRemote: false },
      { disconnectedTargetsLoaded: false },
      { userDisconnected: true },
      { latchedOpen: true, check: check("error") },
    ]) {
      expect(derive({ check: check("error"), ...input })).toEqual({
        state: { kind: "open" },
        autoCheck: false,
        backgroundCheck: false,
      });
    }
  });

  it("opens a verified target without any check", () => {
    expect(derive({ check: check("verified") })).toMatchObject({
      state: { kind: "open" },
      backgroundCheck: false,
    });
  });

  it("opens an unknown target now: explicit navigation verifies in the background, restore does not", () => {
    expect(derive({ check: check("idle") })).toMatchObject({
      state: { kind: "open" },
      backgroundCheck: true,
    });
    expect(derive({ check: undefined, intent: "restored" })).toMatchObject({
      state: { kind: "open" },
      backgroundCheck: false,
    });
  });

  it("explicit navigation to a known-dead target gates and starts one silent reconnect", () => {
    expect(derive({ check: check("error") })).toEqual({
      state: { kind: "reconnecting", waitingForAuth: false },
      autoCheck: true,
      backgroundCheck: false,
    });
    expect(derive({ check: check("auth_required", OLD, "password") }).autoCheck).toBe(true);
  });

  it("a newer remote-target failure invalidates a stale verified flag", () => {
    expect(derive({ check: check("verified", OLD), failure: passwordFailure }).autoCheck).toBe(
      true,
    );
    // A failure older than the last verification does not gate.
    expect(
      derive({ check: check("verified", NEW), failure: { ...passwordFailure, createdAt: OLD } }),
    ).toMatchObject({ state: { kind: "open" } });
  });

  it("after the silent attempt shows the auth need or the error, never another automatic attempt", () => {
    expect(
      derive({ check: check("auth_required", OLD, "password"), autoAttempted: true }),
    ).toMatchObject({ state: { kind: "auth", authMode: "password" }, autoCheck: false });
    expect(derive({ check: check("error"), autoAttempted: true })).toMatchObject({
      state: { kind: "error", message: "status error" },
      autoCheck: false,
    });
  });

  it("a startup-restored thread on a dead target shows the gate with no automatic reconnect", () => {
    expect(derive({ check: check("error"), intent: "restored" })).toMatchObject({
      state: { kind: "error" },
      autoCheck: false,
    });
    expect(derive({ failure: passwordFailure, intent: "restored" })).toMatchObject({
      state: { kind: "auth", authMode: "password" },
      autoCheck: false,
    });
  });

  it("joins a running check and waits for a pending password for the same target", () => {
    expect(derive({ check: check("checking") }).state).toEqual({
      kind: "reconnecting",
      waitingForAuth: false,
    });
    expect(derive({ check: check("auth_required"), authPending: true }).state).toEqual({
      kind: "reconnecting",
      waitingForAuth: true,
    });
  });
});

describe("describeRemoteThreadGate", () => {
  it("uses blue for working, amber for input, red for failure", () => {
    expect(
      describeRemoteThreadGate({ kind: "reconnecting", waitingForAuth: false }, "ice-2-kg"),
    ).toMatchObject({ tone: "info", title: "Reconnecting to ice-2-kg…", primaryLabel: null });
    expect(
      describeRemoteThreadGate(
        { kind: "reconnecting", waitingForAuth: true },
        "ice-2-kg",
        "password",
      ),
    ).toMatchObject({ title: "Waiting for password…" });
    expect(describeRemoteThreadGate({ kind: "auth", authMode: "password" }, "ice-2-kg")).toEqual({
      tone: "warning",
      title: "ice-2-kg needs your SSH password",
      description: null,
      primaryLabel: "Enter password",
    });
    expect(
      describeRemoteThreadGate({ kind: "auth", authMode: "host-trust" }, "ice-2-kg"),
    ).toMatchObject({
      title: "Confirm ice-2-kg's server identity",
      primaryLabel: "Review identity",
    });
    expect(
      describeRemoteThreadGate(
        { kind: "error", message: "Timed out.", tip: "Check the host." },
        "h",
      ),
    ).toEqual({
      tone: "error",
      title: "Could not reach h",
      description: "Timed out. Check the host.",
      primaryLabel: "Reconnect",
    });
  });
});
