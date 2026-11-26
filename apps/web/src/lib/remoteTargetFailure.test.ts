import { describe, expect, it } from "vitest";

import {
  decodeRemoteTargetFailure,
  extractRemoteTargetMessage,
  inferRemoteTargetFailure,
  isRemoteTargetErrorText,
} from "./remoteTargetFailure";

const PASSWORD = "SSH password is required for ice-2-kg. Re-enter it before using this target.";

describe("remote target failure helpers", () => {
  it("decodes a valid marker and ignores invalid ones", () => {
    expect(decodeRemoteTargetFailure({ remoteTarget: { reason: "unreachable" } })).toEqual({
      reason: "unreachable",
    });
    expect(decodeRemoteTargetFailure({ remoteTarget: { reason: "nope" } })).toBeUndefined();
    expect(decodeRemoteTargetFailure({ detail: "x" })).toBeUndefined();
    expect(decodeRemoteTargetFailure(null)).toBeUndefined();
  });

  it("finds an SSH message inside a prefixed provider detail", () => {
    expect(extractRemoteTargetMessage(`Failed to start session: ${PASSWORD}`)).toBe(PASSWORD);
    expect(inferRemoteTargetFailure(`x ${PASSWORD}`)).toEqual({
      reason: "auth-required",
      authMode: "password",
    });
    expect(
      inferRemoteTargetFailure("Remote workspace is disconnected. Connect it to continue."),
    ).toEqual({ reason: "disconnected" });
    expect(isRemoteTargetErrorText("read ECONNRESET")).toBe(false);
    expect(isRemoteTargetErrorText(PASSWORD)).toBe(true);
  });
});
