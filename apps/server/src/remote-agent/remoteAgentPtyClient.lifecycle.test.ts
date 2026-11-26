import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentHostPolicy } from "./remoteAgentProtocol.ptyLifecycle.ts";
import {
  makeRemoteAgentHostControls,
  remoteAgentPtyCreateLifecycleFields,
  remoteAgentPtyWorkspaceHandle,
  remoteAgentTerminalWorkspaceHandle,
  RemoteAgentPtyLifecycle,
} from "./remoteAgentPtyClient.lifecycle.ts";
import { isRemoteAgentLifecycleUnsupported } from "./remoteAgentPtyClient.types.ts";
import { FakeLifecycleConnection } from "./remoteAgentPtyClient.lifecycle.testUtils.ts";

const policy: RemoteAgentHostPolicy = {
  lifecycleEnabled: true,
  idleCloseMs: 600_000,
  idleWarningMs: 60_000,
  maxLivePtys: 24,
  orphanCloseMs: 600_000,
  memoryPressureEnabled: true,
  memoryAvailableLowPercent: 8,
  memoryAvailableCriticalPercent: 4,
  hostRssLowBytes: 0,
  hostRssCriticalBytes: 0,
  terminalRssLowPercent: 50,
  terminalRssCriticalPercent: 70,
  revision: 2,
};

const controlResponse = (type: string, requestId: string, accepted = true, errorCode = "") =>
  ({
    type,
    value: { requestId, ptyId: "pty-1", accepted, errorCode, errorMessage: errorCode },
  }) as RemoteAgentFrame;

describe("per-cwd workspace handles", () => {
  it("hashes target, a NUL separator and the normalised cwd", () => {
    const expected = createHash("sha256")
      .update("ssh:a")
      .update(Buffer.from([0]))
      .update("/srv/project")
      .digest("hex")
      .slice(0, 32);
    expect(remoteAgentTerminalWorkspaceHandle("ssh:a", "/srv/project")).toBe(
      `terminal-root-${expected}`,
    );
    expect(remoteAgentTerminalWorkspaceHandle("ssh:a", "/srv//project/")).toBe(
      `terminal-root-${expected}`,
    );
    expect(remoteAgentTerminalWorkspaceHandle("ssh:b", "/srv/project")).not.toBe(
      `terminal-root-${expected}`,
    );
    expect(remoteAgentTerminalWorkspaceHandle("ssh:a", "/")).toMatch(
      /^terminal-root-[0-9a-f]{32}$/,
    );
  });

  it("keeps one legacy handle per PTY on hosts without the reference-counted roots", () => {
    const input = { target: "ssh:a", cwd: "/srv", resourceId: "res-1" };
    expect(
      remoteAgentPtyWorkspaceHandle(new FakeLifecycleConnection(["terminal.pty"]), input),
    ).toBe("terminal-res-1");
    expect(remoteAgentPtyWorkspaceHandle(new FakeLifecycleConnection(), input)).toBe(
      remoteAgentTerminalWorkspaceHandle("ssh:a", "/srv"),
    );
  });
});

describe("create fields", () => {
  const requested = {
    lifecycleManaged: true,
    activitySource: "owner-hint" as const,
    evictPtyId: "old",
    localLaunch: true,
    spool: true,
    screenScrollbackRows: 1000,
  };

  it("sends every field the host advertises", () => {
    expect(remoteAgentPtyCreateLifecycleFields(new FakeLifecycleConnection(), requested)).toEqual(
      requested,
    );
  });

  it("omits every field for a host before 1.9 and per missing capability", () => {
    expect(
      remoteAgentPtyCreateLifecycleFields(new FakeLifecycleConnection(["terminal.pty"]), requested),
    ).toEqual({});
    expect(
      remoteAgentPtyCreateLifecycleFields(
        new FakeLifecycleConnection(["terminal.lifecycle", "terminal.screen"]),
        requested,
      ),
    ).toEqual({
      lifecycleManaged: true,
      activitySource: "owner-hint",
      evictPtyId: "old",
      screenScrollbackRows: 1000,
    });
  });
});

describe("host controls", () => {
  it("rejects UNSUPPORTED without sending anything to an older agent", async () => {
    const connection = new FakeLifecycleConnection(["terminal.pty"]);
    const host = makeRemoteAgentHostControls(async () => connection);
    for (const call of [
      host.updatePolicy(policy),
      host.closeAll({ reason: "quit", managedOnly: true }),
      host.replayNotices({ expectedEpoch: "e", afterNoticeId: 0 }),
    ]) {
      const error = await call.catch((cause: unknown) => cause);
      expect(isRemoteAgentLifecycleUnsupported(error)).toBe(true);
    }
    expect(connection.sent).toHaveLength(0);
    await expect(host.capabilities()).resolves.toMatchObject({ screen: false, lifecycle: false });
  });

  it("surfaces a host's own UNSUPPORTED refusal with the same code", async () => {
    const connection = new FakeLifecycleConnection();
    connection.onSend = (frame) =>
      connection.deliver({
        type: "ptyCloseAllResponse",
        value: {
          requestId: (frame.value as { requestId: string }).requestId,
          accepted: false,
          errorCode: "UNSUPPORTED",
          errorMessage: "terminal lifecycle is not supported by this agent",
          closedCount: 0,
        },
      });
    const error = await makeRemoteAgentHostControls(async () => connection)
      .closeAll({ reason: "quit", managedOnly: true })
      .catch((cause: unknown) => cause);
    expect(isRemoteAgentLifecycleUnsupported(error)).toBe(true);
  });

  it("returns the clamped policy, the closed count and replayed notices", async () => {
    const connection = new FakeLifecycleConnection();
    const effective = { ...policy, idleCloseMs: 60_000 };
    connection.onSend = (frame) => {
      const requestId = (frame.value as { requestId: string }).requestId;
      const base = { requestId, accepted: true, errorCode: "", errorMessage: "" };
      if (frame.type === "hostPolicyUpdateRequest")
        connection.deliver({ type: "hostPolicyUpdateResponse", value: { ...base, effective } });
      if (frame.type === "ptyCloseAllRequest")
        connection.deliver({ type: "ptyCloseAllResponse", value: { ...base, closedCount: 3 } });
      if (frame.type === "hostNoticeReplayRequest")
        connection.deliver({
          type: "hostNoticeReplayResponse",
          value: {
            ...base,
            agentEpoch: "epoch-2",
            gap: true,
            notices: [
              { noticeId: 5, ptyId: "p", kind: "idle_closed", closesAtMs: 0, occurredAtMs: 9 },
            ],
          },
        });
    };
    const host = makeRemoteAgentHostControls(async () => connection);
    await expect(host.updatePolicy(policy)).resolves.toEqual(effective);
    await expect(host.closeAll({ reason: "update", managedOnly: true })).resolves.toBe(3);
    await expect(host.replayNotices({ expectedEpoch: "e", afterNoticeId: 4 })).resolves.toEqual({
      agentEpoch: "epoch-2",
      gap: true,
      notices: [expect.objectContaining({ noticeId: 5, kind: "idle_closed" })],
    });
    expect(connection.sentOfType("ptyCloseAllRequest")[0]).toMatchObject({
      reason: "update",
      managedOnly: true,
    });
  });

  it("consumes unsolicited lifecycle frames so they never fill the unclaimed set", async () => {
    const connection = new FakeLifecycleConnection();
    const host = makeRemoteAgentHostControls(async () => connection);
    const events: string[] = [];
    const unsubscribe = await host.subscribe((event) => events.push(event.type));
    connection.deliver({
      type: "ptyLifecycleNotice",
      value: { noticeId: 1, ptyId: "p", kind: "idle_warning", closesAtMs: 1, occurredAtMs: 0 },
    });
    unsubscribe();
    for (let index = 0; index < 1_100; index += 1)
      connection.deliver({
        type: "ptyActivity",
        value: {
          ptyId: "p",
          idleBusy: false,
          pressureBusy: false,
          sidebarBusy: true,
          reasons: ["output"],
          lastInputMs: 0,
          lastOutputMs: index,
          quietSinceMs: 0,
        },
      });
    expect(events).toEqual(["notice"]);
    expect(connection.inbox.unclaimedCount).toBe(0);
  });
});

describe("per-PTY lifecycle", () => {
  function lifecycle(connection: FakeLifecycleConnection, signal = new AbortController().signal) {
    const control = new RemoteAgentPtyLifecycle("pty-1", () => connection, signal);
    control.bind(connection);
    return control;
  }

  it("routes only this PTY's activity and notices", () => {
    const connection = new FakeLifecycleConnection();
    const control = lifecycle(connection);
    const notices = vi.fn();
    const activity = vi.fn();
    control.onNotice(notices);
    control.onActivity(activity);
    for (const ptyId of ["pty-2", "pty-1"])
      connection.deliver({
        type: "ptyLifecycleNotice",
        value: { noticeId: 1, ptyId, kind: "idle_warning", closesAtMs: 60, occurredAtMs: 0 },
      });
    expect(notices).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ptyId: "pty-1" }));
    expect(activity).not.toHaveBeenCalled();
    control.unbind();
    connection.deliver({
      type: "ptyLifecycleNotice",
      value: { noticeId: 2, ptyId: "pty-1", kind: "idle_closed", closesAtMs: 0, occurredAtMs: 1 },
    });
    expect(notices).toHaveBeenCalledOnce();
  });

  it("installs no listener on a connection without terminal.lifecycle", () => {
    const connection = new FakeLifecycleConnection(["terminal.pty"]);
    lifecycle(connection);
    expect(connection.inbox.listeners.size).toBe(0);
  });

  it("collapses queued view states to the newest and settles every caller", async () => {
    const connection = new FakeLifecycleConnection();
    const replies: Array<() => void> = [];
    connection.onSend = (frame) => {
      const requestId = (frame.value as { requestId: string }).requestId;
      replies.push(() => connection.deliver(controlResponse("ptyViewStateResponse", requestId)));
    };
    const viewControl = lifecycle(connection);
    const hidden = { viewState: "hidden" as const, rendererAttached: false, ackedSequence: 9 };
    const first = viewControl.setViewState({ viewState: "visible", rendererAttached: true });
    const second = viewControl.setViewState({ viewState: "visible", rendererAttached: false });
    const third = viewControl.setViewState(hidden);
    expect(connection.sent).toHaveLength(1);
    replies.shift()!();
    await first;
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    replies.shift()!();
    await Promise.all([second, third]);
    expect(connection.sentOfType("ptyViewStateRequest").map((value) => value.viewState)).toEqual([
      "visible",
      "hidden",
    ]);
    expect(connection.sentOfType("ptyViewStateRequest")[1]).toMatchObject({
      rendererAttached: false,
      ackedSequence: 9,
      ownerBusyHint: "",
    });
  });

  it("rejects keep-open refusals and older hosts with their codes", async () => {
    const connection = new FakeLifecycleConnection();
    connection.onSend = (frame) =>
      connection.deliver(
        controlResponse(
          "ptyKeepOpenResponse",
          (frame.value as { requestId: string }).requestId,
          false,
          "PTY_NOT_FOUND",
        ),
      );
    await expect(lifecycle(connection).keepOpen()).rejects.toMatchObject({ code: "PTY_NOT_FOUND" });
    const old = new FakeLifecycleConnection(["terminal.pty"]);
    await expect(lifecycle(old).keepOpen()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(
      lifecycle(old).setViewState({ viewState: "hidden", rendererAttached: false }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(old.sent).toHaveLength(0);
  });
});
