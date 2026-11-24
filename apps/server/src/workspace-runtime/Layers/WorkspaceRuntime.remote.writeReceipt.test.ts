import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProjectWriteFileInput } from "@bigbud/contracts/workspace/project.ts";
import {
  RemoteAgentConnectionError,
  type RemoteAgentConnection,
} from "../../remote-agent/remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "../../remote-agent/remoteAgentProtocol.ts";
import { remoteAgentRequestDigest } from "../../remote-agent/remoteAgentRequestDigest.ts";
import { RemoteAgentWorkspaceClient } from "../../remote-agent/remoteAgentWorkspaceClient.ts";
import { makeRemoteWorkspaceWriteFile } from "./WorkspaceRuntime.remote.write.ts";
import { resolveRemoteWriteReceipt } from "./WorkspaceRuntime.remote.writeReceipt.ts";

const RESULT = "d".repeat(64);
const input = {
  executionTargetId: "ssh:example",
  cwd: "/remote/project",
  relativePath: "notes.md",
  contents: "draft",
  expectedSha256: "e".repeat(64),
  operationId: "write-receipt-1",
} as unknown as ProjectWriteFileInput;

/** A real client over a fake connection: writes lose their response, receipts are answered. */
function agent(minor: number, applied = true) {
  const capabilities = [{ name: "workspace.write", major: 1, minor }];
  const request = vi.fn(async (frame: RemoteAgentFrame): Promise<RemoteAgentFrame> => {
    if (frame.type !== "writeReceiptRequest") throw new RemoteAgentConnectionError("lost");
    return {
      type: "writeReceiptResponse",
      value: {
        requestId: frame.value.requestId,
        operationId: frame.value.operationId,
        applied,
        resultSha256: applied ? RESULT : "",
        errorCode: "",
        errorMessage: "",
      },
    };
  });
  const connection = {
    request,
    negotiatedCapabilities: capabilities,
    supportsCapability: (name: string) => capabilities.some((entry) => entry.name === name),
  } as unknown as RemoteAgentConnection;
  return { client: new RemoteAgentWorkspaceClient(connection), request };
}

const frameTypes = (request: ReturnType<typeof agent>["request"]) =>
  request.mock.calls.map(([frame]) => frame.type);

function writeWith(resolve: (target: string) => Promise<RemoteAgentWorkspaceClient>) {
  return makeRemoteWorkspaceWriteFile({
    resolve,
    remoteTarget: (target) => target!,
    open: async () => "workspace",
  })(input);
}

async function expectUnknown(effect: ReturnType<typeof writeWith>) {
  const error = await Effect.runPromise(Effect.flip(effect));
  expect(error).toMatchObject({ writeDisposition: "unknown" });
  // The original lost-response error is reported unchanged.
  expect(error.cause).toMatchObject({ code: "UNKNOWN_OUTCOME", writeDisposition: "unknown" });
}

describe("remote write receipt resolution", () => {
  it("turns a lost write response into success when a fresh agent proves it applied", async () => {
    const first = agent(2);
    const fresh = agent(2);
    const resolve = vi
      .fn<(target: string) => Promise<RemoteAgentWorkspaceClient>>()
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(fresh.client);

    await expect(Effect.runPromise(writeWith(resolve))).resolves.toEqual({
      relativePath: "notes.md",
      resultSha256: RESULT,
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(frameTypes(first.request)).toEqual(["writeFileRequest"]);
    expect(frameTypes(fresh.request)).toEqual(["writeReceiptRequest"]);
    expect(fresh.request.mock.calls[0]![0].value).toMatchObject({
      operationId: "write-receipt-1",
      requestDigest: remoteAgentRequestDigest(input),
    });
  });

  it("keeps the outcome unknown when the agent has no receipt", async () => {
    const first = agent(2);
    const fresh = agent(2, false);
    const resolve = vi
      .fn<(target: string) => Promise<RemoteAgentWorkspaceClient>>()
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(fresh.client);

    await expectUnknown(writeWith(resolve));
    expect(frameTypes(first.request)).toEqual(["writeFileRequest"]);
    expect(frameTypes(fresh.request)).toEqual(["writeReceiptRequest"]);
  });

  it("keeps the outcome unknown for agents without receipts and never queries them", async () => {
    const first = agent(1);
    const fresh = agent(1);
    const resolve = vi
      .fn<(target: string) => Promise<RemoteAgentWorkspaceClient>>()
      .mockResolvedValueOnce(first.client)
      .mockResolvedValueOnce(fresh.client);

    await expectUnknown(writeWith(resolve));
    expect(frameTypes(first.request)).toEqual(["writeFileRequest"]);
    expect(fresh.request).not.toHaveBeenCalled();
  });

  it("keeps the outcome unknown when a fresh client cannot be resolved", async () => {
    const first = agent(2);
    const resolve = vi
      .fn<(target: string) => Promise<RemoteAgentWorkspaceClient>>()
      .mockResolvedValueOnce(first.client)
      .mockRejectedValueOnce(new Error("agent unreachable"));

    await expectUnknown(writeWith(resolve));
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(frameTypes(first.request)).toEqual(["writeFileRequest"]);
  });

  it("gives up after its time bound without querying again", async () => {
    const resolve = vi.fn(() => new Promise<RemoteAgentWorkspaceClient>(() => {}));
    await expect(
      resolveRemoteWriteReceipt({
        resolve,
        operationId: "write-receipt-1",
        requestDigest: new Uint8Array([1]),
        timeoutMs: 5,
      }),
    ).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
