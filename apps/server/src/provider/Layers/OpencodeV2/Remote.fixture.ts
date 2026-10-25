import { createHash } from "node:crypto";
import type { RemoteAgentConnection } from "../../../remote-agent/remoteAgentConnection.ts";
import { RemoteAgentWorkspaceClient } from "../../../remote-agent/remoteAgentWorkspaceClient.ts";
import type { RemoteAgentFrame } from "../../../remote-agent/remoteAgentProtocol.ts";
import { encodeFramePayload } from "../../../remote-agent/remoteAgentProtocol.codec.encode.ts";
import { decodeFramePayload } from "../../../remote-agent/remoteAgentProtocol.codec.decode.ts";
import { V2CodingFiles, resolveV2FilePython } from "./Coding.files.ts";

/** Actual protobuf codec and workspace client, disposable descriptor-backed target; no SSH host. */
export async function makeV2RemoteAgentFixture(root: string, profile: string) {
  const files = await V2CodingFiles.open(root, profile, await resolveV2FilePython(profile));
  const requests: RemoteAgentFrame[] = [];
  const connection = {
    request: async (raw: RemoteAgentFrame) => {
      const frame = decodeFramePayload(encodeFramePayload(raw));
      requests.push(frame);
      let response: RemoteAgentFrame;
      if (frame.type === "workspaceOpenRequest")
        response = {
          type: "workspaceOpenResponse",
          value: {
            ...frame.value,
            accepted: frame.value.root === root,
            errorCode: frame.value.root === root ? "" : "INVALID_ROOT",
            errorMessage: "",
          },
        };
      else if (frame.type === "readFileRequest") {
        const content = (await files.run({ action: "read", path: frame.value.path })).content!;
        const bytes = Buffer.from(content);
        response = {
          type: "readFileResponse",
          value: {
            requestId: frame.value.requestId,
            operationId: frame.value.operationId,
            terminal: true,
            bytes,
            totalBytes: bytes.length,
            truncated: bytes.length > frame.value.maxBytes,
            errorCode: "",
            errorMessage: "",
          },
        };
      } else if (frame.type === "writeFileRequest") {
        await files.run({
          action: "write",
          path: frame.value.path,
          content: new TextDecoder("utf-8", { fatal: true }).decode(frame.value.bytes),
          expectedSha256: frame.value.expectedSha256,
        });
        response = {
          type: "writeFileResponse",
          value: {
            requestId: frame.value.requestId,
            operationId: frame.value.operationId,
            terminal: true,
            writtenBytes: frame.value.bytes.length,
            currentSha256: createHash("sha256").update(frame.value.bytes).digest("hex"),
            errorCode: "",
            errorMessage: "",
          },
        };
      } else if (frame.type === "listDirectoryRequest") {
        const names = (await files.run({ action: "list", path: frame.value.path || "." })).entries!;
        response = {
          type: "listDirectoryResponse",
          value: {
            requestId: frame.value.requestId,
            operationId: frame.value.operationId,
            terminal: true,
            entries: names.map((name) => ({
              path: name,
              isDirectory: false,
              isFile: true,
              sizeBytes: 0,
              modifiedAtMs: 0,
            })),
            errorCode: "",
            errorMessage: "",
          },
        };
      } else throw new Error("Unexpected fixture operation");
      return decodeFramePayload(encodeFramePayload(response));
    },
  } as unknown as RemoteAgentConnection;
  const client = new RemoteAgentWorkspaceClient(connection);
  return {
    client,
    requests,
    sha: (text: string) => createHash("sha256").update(text).digest("hex"),
  };
}
