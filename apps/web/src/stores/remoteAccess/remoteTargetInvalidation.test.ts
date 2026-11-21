import { beforeEach, describe, expect, it } from "vitest";

import { useRemoteAccessStore } from "./remoteAccess.store";
import {
  invalidateRemoteTargetFromFailure,
  isRemoteTargetFailureNewerThanCheck,
} from "./remoteTargetInvalidation";

const TARGET = "ssh:host=ice-2-kg&user=root&auth=password";
const failure = (createdAt: string) => ({
  remoteTarget: { reason: "auth-required" as const, authMode: "password" as const },
  createdAt,
  detail: "SSH password is required for root@ice-2-kg. Re-enter it before using this target.",
});

describe("remote target invalidation", () => {
  beforeEach(() => {
    useRemoteAccessStore.setState({ verifiedExecutionTargetIds: {}, executionTargetChecks: {} });
  });

  it("a failure newer than the last check clears verified and records the auth need", () => {
    useRemoteAccessStore.getState().markExecutionTargetVerified(TARGET);
    const verifiedAt = useRemoteAccessStore.getState().executionTargetChecks[TARGET]!.updatedAt;
    const later = new Date(Date.parse(verifiedAt) + 60_000).toISOString();

    expect(invalidateRemoteTargetFromFailure(TARGET, failure(later))).toBe(true);
    const state = useRemoteAccessStore.getState();
    expect(state.verifiedExecutionTargetIds[TARGET]).toBeUndefined();
    expect(state.executionTargetChecks[TARGET]).toMatchObject({
      status: "auth_required",
      authMode: "password",
      promptLabel: "root@ice-2-kg",
    });
  });

  it("an older failure does not touch a newer verification", () => {
    useRemoteAccessStore.getState().markExecutionTargetVerified(TARGET);
    expect(invalidateRemoteTargetFromFailure(TARGET, failure("2000-01-01T00:00:00.000Z"))).toBe(
      false,
    );
    expect(useRemoteAccessStore.getState().verifiedExecutionTargetIds[TARGET]).toBe(true);
  });

  it("never invalidates during a running check or for a user disconnect", () => {
    const now = new Date().toISOString();
    expect(
      isRemoteTargetFailureNewerThanCheck(failure(now), { status: "checking", updatedAt: "" }),
    ).toBe(false);
    expect(
      isRemoteTargetFailureNewerThanCheck(
        { ...failure(now), remoteTarget: { reason: "disconnected" } },
        undefined,
      ),
    ).toBe(false);
    expect(isRemoteTargetFailureNewerThanCheck(failure(now), undefined)).toBe(true);
  });
});
