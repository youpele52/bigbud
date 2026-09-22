import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConnectRemoteAgentResult } from "@bigbud/contracts/server/server.ts";
import {
  notifyRemoteAgentConnection,
  remoteAgentConnectionWarning,
} from "./SidebarRemoteAgentConnection.notifications";

const toast = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../ui/toast.manager", () => ({ toastManager: toast }));
beforeEach(() => toast.add.mockClear());

function result(
  overrides: Partial<ServerConnectRemoteAgentResult> = {},
): ServerConnectRemoteAgentResult {
  return {
    connectionId: crypto.randomUUID(),
    currentVersion: "0.2.209",
    pendingVersion: null,
    fallbackVersion: null,
    outcome: "selected",
    ...overrides,
  };
}

describe("remote agent connection warnings", () => {
  it("does not warn for a normal connection with a retained healthy predecessor", () => {
    notifyRemoteAgentConnection("ssh:test", result({ fallbackVersion: "0.2.208" }));
    expect(toast.add).not.toHaveBeenCalled();
  });

  it("warns with exact versions and the update failure when an older healthy agent is used", () => {
    notifyRemoteAgentConnection(
      "ssh:test",
      result({
        outcome: "fallback",
        requestedVersion: "0.2.210",
        warning: "The supervisor did not become ready.",
      }),
    );
    expect(toast.add).toHaveBeenCalledExactlyOnceWith({
      type: "warning",
      title: "Remote agent update unavailable",
      description:
        "Could not use agent 0.2.210. Connected using healthy agent 0.2.209. The supervisor did not become ready.",
    });
  });

  it("reports a failed update check without claiming a newer version exists", () => {
    const connected = result({ warning: "Could not check for agent updates." });
    notifyRemoteAgentConnection("ssh:test", connected);
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        description: "Connected using existing agent 0.2.209. Could not check for agent updates.",
      }),
    );
  });

  it("explains same-version fallback in plain language", () => {
    expect(
      remoteAgentConnectionWarning(
        result({ outcome: "fallback", requestedVersion: "0.2.209", failureCode: "NOT_READY" }),
      ),
    ).toBe(
      "Connected using existing agent 0.2.209. The updated agent did not confirm it was ready.",
    );
  });

  it("does not repeat the warning when the same admission is replayed", () => {
    const connected = result({ outcome: "fallback", failureCode: "UNREACHABLE" });
    notifyRemoteAgentConnection("ssh:test", connected);
    notifyRemoteAgentConnection("ssh:test", connected);
    expect(toast.add).toHaveBeenCalledOnce();
    notifyRemoteAgentConnection("ssh:other", connected);
    expect(toast.add).toHaveBeenCalledTimes(2);
  });

  it("still warns for a subsequent deliberate connection", () => {
    notifyRemoteAgentConnection("ssh:test", result({ outcome: "fallback" }));
    notifyRemoteAgentConnection("ssh:test", result({ outcome: "fallback" }));
    expect(toast.add).toHaveBeenCalledTimes(2);
  });
});
