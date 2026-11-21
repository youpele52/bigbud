import { describe, expect, it } from "vitest";

import type { RemoteAgentRuntimeBinding } from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentFrame } from "../remote-agent/remoteAgentProtocol.ts";
import type { RemoteAgentPtyLifecycleNotice } from "../remote-agent/remoteAgentProtocol.ptyLifecycle.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { makeLocalTerminalHostGenerations } from "./localTerminalHost.generations.ts";
import type {
  LocalTerminalHostController,
  LocalTerminalHostNoticeCursor,
} from "./localTerminalHost.host.ts";

const notice = (noticeId: number, kind = "idle_closed"): RemoteAgentPtyLifecycleNotice => ({
  noticeId,
  ptyId: `pty-${noticeId}`,
  kind,
  closesAtMs: 0,
  occurredAtMs: 1_700_000_000_000,
});

/** One generation whose host ring holds `ring`; the host answers in `agentEpoch`. */
function setup(input: {
  readonly ring: ReadonlyArray<RemoteAgentPtyLifecycleNotice>;
  readonly cursor?: LocalTerminalHostNoticeCursor;
  readonly agentEpoch?: string;
  readonly gap?: boolean;
  readonly refuse?: boolean;
}) {
  const binding: RemoteAgentRuntimeBinding = {
    connectionId: "state-1",
    runtime: { generation: "state-1" } as RemoteAgentRuntime,
    expectedEpoch: "epoch-1",
  };
  let cursor = input.cursor;
  const requests: Array<{ expectedEpoch: string; afterNoticeId: number }> = [];
  const controller = {
    attachedBindings: async () => [{ generation: 1, binding, admitted: true }],
    readNoticeCursor: async () => cursor,
    writeNoticeCursor: async (_generation: number, next: LocalTerminalHostNoticeCursor) => {
      cursor = next;
    },
  } as unknown as LocalTerminalHostController;
  const connection = {
    supportsCapability: () => true,
    onFrame: () => () => undefined,
    request: async (frame: RemoteAgentFrame) => {
      const value = frame.value as {
        requestId: string;
        expectedEpoch: string;
        afterNoticeId: number;
      };
      requests.push({ expectedEpoch: value.expectedEpoch, afterNoticeId: value.afterNoticeId });
      return {
        type: "hostNoticeReplayResponse",
        value: {
          requestId: value.requestId,
          agentEpoch: input.agentEpoch ?? "epoch-1",
          accepted: input.refuse !== true,
          errorCode: input.refuse ? "PTY_EPOCH_MISMATCH" : "",
          notices: input.ring.filter((entry) => entry.noticeId > value.afterNoticeId),
          gap: input.gap === true,
        },
      };
    },
  };
  const generations = makeLocalTerminalHostGenerations({
    controller,
    pool: { getBound: async () => connection as never },
  });
  return { generations, requests, cursor: () => cursor };
}

describe("offline notice replay", () => {
  it("sets a baseline at first sight of a generation, without counting its notices", async () => {
    const f = setup({ ring: [notice(1), notice(2)] });
    expect(await f.generations.replayNotices()).toMatchObject([
      { generation: 1, baseline: true, lastNoticeId: 2 },
    ]);
    expect(f.cursor()).toEqual({ epoch: "epoch-1", noticeId: 2 });
  });

  it("returns only notices after the cursor, then advances it so a reconnect sees none", async () => {
    const f = setup({
      ring: [notice(1), notice(2), notice(3)],
      cursor: { epoch: "epoch-1", noticeId: 1 },
    });
    const [first] = await f.generations.replayNotices();
    expect(first).toMatchObject({ baseline: false, gap: false, lastNoticeId: 3 });
    expect(first!.notices.map((entry) => entry.noticeId)).toEqual([2, 3]);
    expect(f.requests[0]).toEqual({ expectedEpoch: "epoch-1", afterNoticeId: 1 });
    const [again] = await f.generations.replayNotices();
    expect(again!.notices).toEqual([]);
    expect(f.requests[1]).toEqual({ expectedEpoch: "epoch-1", afterNoticeId: 3 });
  });

  it("restarts the cursor at 0 after an epoch change, and reports ring gaps", async () => {
    const f = setup({
      ring: [notice(1), notice(2)],
      cursor: { epoch: "old-epoch", noticeId: 40 },
      gap: true,
    });
    const [replay] = await f.generations.replayNotices();
    expect(f.requests[0]).toEqual({ expectedEpoch: "epoch-1", afterNoticeId: 0 });
    expect(replay).toMatchObject({ baseline: false, gap: true, lastNoticeId: 2 });
    expect(f.cursor()).toEqual({ epoch: "epoch-1", noticeId: 2 });
  });

  it("never mixes ids across epochs when the host already moved on", async () => {
    const f = setup({
      ring: [notice(5)],
      cursor: { epoch: "epoch-1", noticeId: 3 },
      agentEpoch: "epoch-2",
    });
    const [replay] = await f.generations.replayNotices();
    expect(replay!.notices).toEqual([]);
    expect(f.cursor()).toEqual({ epoch: "epoch-2", noticeId: 0 });
  });

  it("skips a generation that refuses the replay, keeping its cursor", async () => {
    const f = setup({ ring: [notice(1)], cursor: { epoch: "epoch-1", noticeId: 0 }, refuse: true });
    expect(await f.generations.replayNotices()).toEqual([]);
    expect(f.cursor()).toEqual({ epoch: "epoch-1", noticeId: 0 });
  });
});
