import { describe, expect, it } from "vitest";

import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentPtyClient, type RemoteAgentPtyProcess } from "./remoteAgentPtyClient.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";

/** Agent that evicted output 1..9 while nobody was attached, retaining 10..11. */
function evictedOutputAgent(firstRetained: number[]) {
  const attachCursors: number[] = [];
  let emit: ((frame: RemoteAgentFrame) => boolean) | undefined;
  const connection = {
    onFrame: (listener: (frame: RemoteAgentFrame) => boolean) => {
      emit = listener;
      return () => undefined;
    },
    onFailure: () => () => undefined,
    request: async (frame: RemoteAgentFrame): Promise<RemoteAgentFrame> => {
      if (frame.type === "ptyCreateRequest") {
        return {
          type: "ptyCreateResponse",
          value: { requestId: "c", ptyId: frame.value.ptyId, accepted: true, pid: 7 },
        } as unknown as RemoteAgentFrame;
      }
      if (frame.type !== "ptyAttachRequest") throw new Error("Unexpected request");
      const after = frame.value.afterSequence;
      attachCursors.push(after);
      const retained = firstRetained.shift() ?? 10;
      return {
        type: "ptyAttachResponse",
        value: {
          requestId: frame.value.requestId,
          ptyId: frame.value.ptyId,
          state: "running",
          pid: 7,
          nextSequence: 12,
          firstRetainedSequence: retained,
          replayGap: after + 1 < retained,
        },
      } as unknown as RemoteAgentFrame;
    },
  } as unknown as RemoteAgentConnection;
  const output = (sequence: number, text: string) =>
    emit?.({
      type: "ptyOutput",
      value: { ptyId: "pty-1", sequence, bytes: new TextEncoder().encode(text) },
    } as unknown as RemoteAgentFrame);
  return { connection, attachCursors, output };
}

async function open(agent: ReturnType<typeof evictedOutputAgent>) {
  const process: RemoteAgentPtyProcess = await new RemoteAgentPtyClient(agent.connection).create({
    ptyId: "pty-1",
    workspaceHandle: "workspace",
    cwd: "",
    shell: "/bin/sh",
    args: [],
    cols: 80,
    rows: 24,
  });
  const received: string[] = [];
  const errors: string[] = [];
  process.onData((text) => received.push(text));
  process.onError((error) => errors.push((error as { code?: string }).code ?? error.message));
  return { process, received, errors };
}

describe("remote PTY replay gaps", () => {
  it("reports the gap once, resumes from the retained suffix and keeps live output flowing", async () => {
    const agent = evictedOutputAgent([1, 10, 10]);
    const view = await open(agent);
    await (view.process as unknown as { attach(after: number): Promise<void> }).attach(3);
    expect(agent.attachCursors.slice(-2)).toEqual([3, 9]);
    expect(view.errors).toEqual(["PTY_REPLAY_GAP"]);
    agent.output(10, "retained ");
    agent.output(11, "suffix ");
    agent.output(12, "live");
    expect(view.received.join("")).toBe("retained suffix live");
  });

  it("bounds repeated eviction races instead of looping", async () => {
    const agent = evictedOutputAgent([1, 10, 20, 30, 40]);
    const view = await open(agent);
    await (view.process as unknown as { attach(after: number): Promise<void> }).attach(3);
    expect(agent.attachCursors.slice(1)).toEqual([3, 9, 19]);
    expect(view.errors).toHaveLength(3);
  });
});
