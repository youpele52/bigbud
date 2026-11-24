import { describe, expect, it, vi } from "vitest";

import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";

const RESULT = "c".repeat(64);

function fakeConnection(
  minor: number | undefined,
  answer: (frame: RemoteAgentFrame) => RemoteAgentFrame = (frame) => ({
    type: "writeReceiptResponse",
    value: {
      requestId: frame.type === "writeReceiptRequest" ? frame.value.requestId : "",
      operationId: "write-1",
      applied: true,
      resultSha256: RESULT,
      errorCode: "",
      errorMessage: "",
    },
  }),
) {
  const request = vi.fn(async (frame: RemoteAgentFrame) => answer(frame));
  const capabilities = minor === undefined ? [] : [{ name: "workspace.write", major: 1, minor }];
  const connection = {
    request,
    negotiatedCapabilities: capabilities,
    supportsCapability: (name: string) =>
      capabilities.some((capability) => capability.name === name && capability.major === 1),
  } as unknown as RemoteAgentConnection;
  return { connection, request };
}

function mutation() {
  return { prepare: vi.fn(), terminal: vi.fn(async () => {}), unknown: vi.fn() };
}

const query = { operationId: "write-1", requestDigest: new Uint8Array([9]) };

describe("remote agent workspace client write receipts", () => {
  it("queries workspace.write 1.2 agents and settles the journal when applied", async () => {
    const { connection, request } = fakeConnection(2);
    const journal = mutation();
    const client = new RemoteAgentWorkspaceClient(connection, undefined, journal);

    await expect(client.queryWriteReceipt(query)).resolves.toEqual({
      applied: true,
      resultSha256: RESULT,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toMatchObject({
      type: "writeReceiptRequest",
      value: { operationId: "write-1", requestDigest: new Uint8Array([9]) },
    });
    expect(journal.terminal).toHaveBeenCalledWith("write-1");
  });

  it.each([undefined, 0, 1])(
    "never queries agents without the receipt minor (minor %s)",
    async (minor) => {
      const { connection, request } = fakeConnection(minor);
      const journal = mutation();
      const client = new RemoteAgentWorkspaceClient(connection, undefined, journal);

      await expect(client.queryWriteReceipt(query)).resolves.toEqual({ applied: false });
      expect(request).not.toHaveBeenCalled();
      expect(journal.terminal).not.toHaveBeenCalled();
    },
  );

  it("treats a missing receipt or an unproven hash as not applied", async () => {
    for (const resultSha256 of ["", "not-a-hash"]) {
      const { connection } = fakeConnection(2, (frame) => ({
        type: "writeReceiptResponse",
        value: {
          requestId: frame.type === "writeReceiptRequest" ? frame.value.requestId : "",
          operationId: "write-1",
          applied: resultSha256 !== "",
          resultSha256,
          errorCode: "",
          errorMessage: "",
        },
      }));
      const journal = mutation();
      const client = new RemoteAgentWorkspaceClient(connection, undefined, journal);
      await expect(client.queryWriteReceipt(query)).resolves.toEqual({ applied: false });
      expect(journal.terminal).not.toHaveBeenCalled();
    }
  });

  it("surfaces an operation identity conflict without settling the journal", async () => {
    const { connection } = fakeConnection(2, (frame) => ({
      type: "writeReceiptResponse",
      value: {
        requestId: frame.type === "writeReceiptRequest" ? frame.value.requestId : "",
        operationId: "write-1",
        applied: false,
        resultSha256: "",
        errorCode: "OPERATION_ID_CONFLICT",
        errorMessage: "operation id conflict",
      },
    }));
    const journal = mutation();
    const client = new RemoteAgentWorkspaceClient(connection, undefined, journal);
    await expect(client.queryWriteReceipt(query)).rejects.toMatchObject({
      code: "OPERATION_ID_CONFLICT",
    });
    expect(journal.terminal).not.toHaveBeenCalled();
  });
});
