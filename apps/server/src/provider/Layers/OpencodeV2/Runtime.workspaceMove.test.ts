import { describe, expect, it, vi } from "vitest";
import { moveV2NativeWorkspace, type V2WorkspaceMoveClient } from "./Runtime.workspaceMove.ts";

function fixture() {
  let directory = "/old";
  const session = {
    id: "ses_owned",
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    model: { id: "model", providerID: "provider" },
    metadata: { owner: "thread" },
  };
  const get = vi.fn(async () => ({ ...session, location: { directory } }));
  const move = vi.fn(async () => {
    directory = "/new";
  });
  const active = vi.fn(async (): Promise<Record<string, unknown>> => ({}));
  const list = vi.fn(async (): Promise<unknown[]> => []);
  const beforeDispatch = vi.fn(async () => {});
  const client = {
    session: { get, move, active, inbox: { list } },
  } as unknown as V2WorkspaceMoveClient;
  const intent = {
    nativeSessionId: "ses_owned",
    sourceDirectory: "/old",
    destinationDirectory: "/new",
    dispatched: false,
  };
  return {
    client,
    intent,
    session,
    get,
    move,
    active,
    list,
    beforeDispatch,
    setDirectory: (value: string) => {
      directory = value;
    },
  };
}

describe("official V2 workspace move protocol (mock only)", () => {
  it("persists intent before the exact native move and verifies the final Location", async () => {
    const f = fixture();
    await moveV2NativeWorkspace(f);
    expect(f.beforeDispatch).toHaveBeenCalledOnce();
    expect(f.beforeDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      f.move.mock.invocationCallOrder[0]!,
    );
    expect(f.move).toHaveBeenCalledWith(
      { sessionID: "ses_owned", directory: "/new", delivery: "queue" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(f.get).toHaveBeenCalledTimes(2);
  });

  it("does not call native move when durable intent cannot be recorded", async () => {
    const f = fixture();
    f.beforeDispatch.mockRejectedValueOnce(new Error("SQL unavailable"));
    await expect(moveV2NativeWorkspace(f)).rejects.toThrow("SQL unavailable");
    expect(f.move).not.toHaveBeenCalled();
  });

  it("does not resend an uncertain dispatch at the original Location", async () => {
    const f = fixture();
    await expect(
      moveV2NativeWorkspace({
        ...f,
        intent: {
          ...f.intent,
          dispatched: true,
          expectedIdentity: { created: 1, model: f.session.model, metadata: f.session.metadata },
        },
      }),
    ).rejects.toThrow("reconcile");
    expect(f.move).not.toHaveBeenCalled();
  });

  it("refuses a destination without durable dispatch evidence", async () => {
    const f = fixture();
    f.setDirectory("/new");
    await expect(moveV2NativeWorkspace(f)).rejects.toThrow("unrecorded Location");
    expect(f.move).not.toHaveBeenCalled();
  });

  it("reconciles the recorded destination without another mutation", async () => {
    const f = fixture();
    f.setDirectory("/new");
    await moveV2NativeWorkspace({
      ...f,
      intent: {
        ...f.intent,
        dispatched: true,
        expectedIdentity: { created: 1, model: f.session.model, metadata: f.session.metadata },
      },
    });
    expect(f.move).not.toHaveBeenCalled();
    expect(f.beforeDispatch).not.toHaveBeenCalled();
  });

  it("requires retained identity evidence for recovery", async () => {
    const f = fixture();
    f.setDirectory("/new");
    await expect(
      moveV2NativeWorkspace({ ...f, intent: { ...f.intent, dispatched: true } }),
    ).rejects.toThrow("durable native identity");
    expect(f.move).not.toHaveBeenCalled();
  });

  it("refuses a changed native registration without dispatch", async () => {
    const f = fixture();
    await expect(
      moveV2NativeWorkspace({
        ...f,
        intent: {
          ...f.intent,
          expectedIdentity: { created: 1, model: f.session.model, metadata: { owner: "other" } },
        },
      }),
    ).rejects.toThrow("identity changed");
    expect(f.move).not.toHaveBeenCalled();
  });

  it("refuses active native work before recording intent", async () => {
    const f = fixture();
    f.active.mockResolvedValueOnce({ ses_owned: {} });
    await expect(moveV2NativeWorkspace(f)).rejects.toThrow("idle native session");
    expect(f.move).not.toHaveBeenCalled();
    expect(f.beforeDispatch).not.toHaveBeenCalled();
  });

  it("refuses queued native work before recording intent", async () => {
    const f = fixture();
    f.list.mockResolvedValueOnce([{}]);
    await expect(moveV2NativeWorkspace(f)).rejects.toThrow("inbox to be empty");
    expect(f.move).not.toHaveBeenCalled();
    expect(f.beforeDispatch).not.toHaveBeenCalled();
  });

  it("treats a successful mutation with unchanged Location as unconfirmed", async () => {
    const f = fixture();
    f.move.mockImplementationOnce(async () => {});
    await expect(moveV2NativeWorkspace(f)).rejects.toThrow("not verified");
    expect(f.move).toHaveBeenCalledOnce();
  });
});
