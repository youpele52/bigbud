import { describe, expect, it } from "vitest";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentPtyClient, RemoteAgentPtyProcess } from "./remoteAgentPtyClient.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";

function fixture(status?: "unconfirmed") {
  let attachStatus = status;
  let state = "running";
  const requests: RemoteAgentFrame[] = [];
  let detached = 0;
  const connection = {
    onFrame: () => () => {
      detached++;
    },
    onFailure: () => () => {
      detached++;
    },
    request: async (frame: RemoteAgentFrame): Promise<RemoteAgentFrame> => {
      requests.push(frame);
      if (frame.type === "ptyCreateRequest") {
        return {
          type: "ptyCreateResponse",
          value: {
            requestId: frame.value.requestId,
            ptyId: frame.value.ptyId,
            accepted: true,
            pid: 123,
            errorCode: "",
            errorMessage: "",
            ...(status ? { launchStatus: status } : {}),
          },
        };
      }
      if (frame.type !== "ptyAttachRequest") throw new Error("Unexpected request");
      return {
        type: "ptyAttachResponse",
        value: {
          requestId: frame.value.requestId,
          ptyId: frame.value.ptyId,
          state,
          pid: 123,
          nextSequence: 1,
          firstRetainedSequence: 1,
          replayGap: false,
          ...(attachStatus ? { launchStatus: attachStatus } : {}),
        },
      };
    },
  } as unknown as RemoteAgentConnection;
  return {
    connection,
    requests,
    detached: () => detached,
    changeAttach: (nextStatus: "unconfirmed" | undefined, nextState = "running") => {
      attachStatus = nextStatus;
      state = nextState;
    },
  };
}

const profileInput = {
  ptyId: "profile-pty",
  workspaceHandle: "workspace",
  cwd: "",
  shell: "/bin/zsh",
  args: ["-o", "nopromptsp"],
  cols: 80,
  rows: 24,
  profileLaunch: true,
};

describe("remote PTY launch evidence", () => {
  it("marks exact-profile requests and requires matched unconfirmed evidence", async () => {
    const f = fixture("unconfirmed");
    const process = await new RemoteAgentPtyClient(f.connection).create(profileInput);
    expect(f.requests[0]).toMatchObject({
      type: "ptyCreateRequest",
      value: { profileLaunch: true },
    });
    expect(process.launchStatus).toBe("unconfirmed");
  });

  it.each(["create", "attach"])(
    "retains uncertain ownership when %s omits profile evidence",
    async (stage) => {
      const f = fixture(stage === "create" ? undefined : "unconfirmed");
      f.changeAttach(undefined);
      let rejected = 0;
      await expect(
        new RemoteAgentPtyClient(f.connection).create({
          ...profileInput,
          onRejected: async () => {
            rejected++;
          },
        }),
      ).rejects.toMatchObject({ code: "PTY_OUTCOME_UNKNOWN" });
      expect(rejected).toBe(0);
      expect(f.detached()).toBeGreaterThanOrEqual(2);
      expect(f.requests.filter((request) => request.type === "ptyCreateRequest")).toHaveLength(1);
      expect(
        f.requests.every((request) =>
          ["ptyCreateRequest", "ptyAttachRequest"].includes(request.type),
        ),
      ).toBe(true);
    },
  );

  it.each([undefined, "unconfirmed"] as const)(
    "carries %s evidence through create and attach without inventing actual identity",
    async (status) => {
      const f = fixture(status);
      const process = await new RemoteAgentPtyClient(f.connection).create({
        ptyId: "pty",
        workspaceHandle: "workspace",
        cwd: "",
        shell: "/bin/sh",
        cols: 80,
        rows: 24,
      });
      expect(process.pid).toBe(123);
      expect(process.launchStatus).toBe(status);
      expect(process).not.toHaveProperty("shellLaunchIdentity");
      expect(f.requests.map((request) => request.type)).toEqual([
        "ptyCreateRequest",
        "ptyAttachRequest",
      ]);
    },
  );

  it("never treats successful attach, running state, or a positive PID as confirmation", async () => {
    const f = fixture();
    const process = new RemoteAgentPtyProcess(f.connection, "pty", undefined);
    expect(process.launchStatus).toBeUndefined();
    await process.attach();
    expect(process.pid).toBeGreaterThan(0);
    expect(process.launchStatus).toBeUndefined();
    expect(f.requests).toHaveLength(1);
  });

  it("replaces stale evidence with each matched attach response, including exited sessions", async () => {
    const f = fixture("unconfirmed");
    const process = new RemoteAgentPtyProcess(f.connection, "pty", undefined);
    await process.attach();
    expect(process.launchStatus).toBe("unconfirmed");
    f.changeAttach(undefined);
    await process.attach();
    expect(process.launchStatus).toBeUndefined();
    f.changeAttach("unconfirmed", "exited");
    await process.attach();
    expect(process.launchStatus).toBe("unconfirmed");
    expect(f.requests.every((request) => request.type === "ptyAttachRequest")).toBe(true);
  });
});
