import { describe, expect, it } from "vitest";

import type { RemoteAgentHostPolicy } from "./remoteAgentProtocol.ptyLifecycle.ts";
import {
  remoteAgentConnectionKey,
  remoteAgentPtyHostWide,
} from "./remoteAgentPtyClient.hostWide.ts";
import { remoteAgentPtyCreateLifecycleFields } from "./remoteAgentPtyClient.lifecycle.ts";
import { FakeLifecycleConnection } from "./remoteAgentPtyClient.lifecycle.testUtils.ts";
import { isRemoteAgentLifecycleUnsupported } from "./remoteAgentPtyClient.types.ts";
import {
  REMOTE_AGENT_TERMINAL_HOST_LIFECYCLE,
  remoteAgentTerminalLifecycleOptions,
} from "./remoteAgentTerminalLifecycle.ts";

const policy: RemoteAgentHostPolicy = {
  lifecycleEnabled: true,
  idleCloseMs: 600_000,
  idleWarningMs: 60_000,
  maxLivePtys: 24,
  orphanCloseMs: 600_000,
  memoryPressureEnabled: true,
  memoryAvailableLowPercent: 0,
  memoryAvailableCriticalPercent: 0,
  hostRssLowBytes: 0,
  hostRssCriticalBytes: 0,
  terminalRssLowPercent: 0,
  terminalRssCriticalPercent: 0,
  revision: 1,
};

/** Answers every host-wide request on `connection` as accepted. */
function acceptAll(connection: FakeLifecycleConnection) {
  connection.onSend = (frame) => {
    const requestId = (frame.value as { requestId: string }).requestId;
    const base = { requestId, accepted: true, errorCode: "", errorMessage: "" };
    if (frame.type === "hostPolicyUpdateRequest")
      connection.deliver({
        type: "hostPolicyUpdateResponse",
        value: { ...base, effective: policy },
      });
    if (frame.type === "ptyCloseAllRequest")
      connection.deliver({ type: "ptyCloseAllResponse", value: { ...base, closedCount: 2 } });
  };
}

describe("remote-agent terminal lifecycle opt-in", () => {
  it("follows the terminal host flag; off changes nothing", () => {
    expect(remoteAgentTerminalLifecycleOptions({ BIGBUD_TERMINAL_HOST: "1" })).toEqual({
      hostLifecycle: { lifecycleManaged: true, screenScrollbackRows: 1_000 },
      remoteHostControls: true,
    });
    expect(remoteAgentTerminalLifecycleOptions({})).toEqual({});
    expect(remoteAgentTerminalLifecycleOptions({ BIGBUD_TERMINAL_HOST: "0" })).toEqual({});
  });

  it("asks a 1.9 agent for a managed PTY with a screen model, never a local launch", () => {
    const current = new FakeLifecycleConnection();
    expect(
      remoteAgentPtyCreateLifecycleFields(current, REMOTE_AGENT_TERMINAL_HOST_LIFECYCLE),
    ).toEqual({ lifecycleManaged: true, screenScrollbackRows: 1_000 });
    // An older agent gets none of the new fields.
    const old = new FakeLifecycleConnection(["terminal.pty"]);
    expect(remoteAgentPtyCreateLifecycleFields(old, REMOTE_AGENT_TERMINAL_HOST_LIFECYCLE)).toEqual(
      {},
    );
  });
});

describe("remote host-wide controls per connection", () => {
  it("keys each connection, and follows the PTY to its new connection", async () => {
    const first = new FakeLifecycleConnection();
    const second = new FakeLifecycleConnection();
    acceptAll(first);
    acceptAll(second);
    let current = first;
    const hostWide = remoteAgentPtyHostWide(() => current);
    const firstKey = hostWide.connectionKey();
    expect(hostWide.connectionKey()).toBe(firstKey);
    await expect(hostWide.updatePolicy(policy)).resolves.toEqual(policy);
    current = second;
    expect(hostWide.connectionKey()).not.toBe(firstKey);
    expect(remoteAgentConnectionKey(first)).toBe(firstKey);
    await expect(hostWide.closeAll({ reason: "quit", managedOnly: true })).resolves.toBe(2);
    expect(first.sentOfType("hostPolicyUpdateRequest")).toHaveLength(1);
    expect(first.sentOfType("ptyCloseAllRequest")).toHaveLength(0);
    expect(second.sentOfType("ptyCloseAllRequest")[0]).toMatchObject({
      reason: "quit",
      managedOnly: true,
    });
  });

  it("receives host notices on the current connection", async () => {
    const connection = new FakeLifecycleConnection();
    const events: string[] = [];
    const unsubscribe = await remoteAgentPtyHostWide(() => connection).subscribe((event) =>
      events.push(event.type === "notice" ? event.value.kind : event.type),
    );
    connection.deliver({
      type: "ptyLifecycleNotice",
      value: { noticeId: 3, ptyId: "p", kind: "idle_closed", closesAtMs: 0, occurredAtMs: 1 },
    });
    unsubscribe();
    expect(events).toEqual(["idle_closed"]);
  });

  it("never sends a host-wide frame to an agent before protocol 1.9", async () => {
    const connection = new FakeLifecycleConnection(["terminal.pty"]);
    const hostWide = remoteAgentPtyHostWide(() => connection);
    for (const call of [
      hostWide.updatePolicy(policy),
      hostWide.closeAll({ reason: "quit", managedOnly: true }),
    ])
      expect(isRemoteAgentLifecycleUnsupported(await call.catch((cause: unknown) => cause))).toBe(
        true,
      );
    expect(connection.sent).toHaveLength(0);
  });
});
