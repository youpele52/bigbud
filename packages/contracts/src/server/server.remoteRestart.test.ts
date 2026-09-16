import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ServerRestartRemoteAgentInput,
  ServerRestartRemoteAgentResult,
} from "./server.remoteRestart";

describe("remote agent restart contract", () => {
  it("requires a project, stable request, and expected target", () => {
    const input = {
      requestId: "restart-1",
      projectId: "project-1",
      expectedWorkspaceExecutionTargetId: "ssh:example",
    };
    expect(Schema.decodeUnknownSync(ServerRestartRemoteAgentInput)(input)).toEqual(input);
    expect(() =>
      Schema.decodeUnknownSync(ServerRestartRemoteAgentInput)({ ...input, requestId: "" }),
    ).toThrow();
  });

  it("round-trips a verified replacement identity", () => {
    const result = {
      requestId: "restart-1",
      projectId: "project-1",
      executionTargetId: "ssh:example",
      phase: "ready" as const,
      message: "Restarted.",
      oldEpoch: "epoch-1",
      replacementEpoch: "epoch-2",
    };
    expect(
      Schema.decodeUnknownSync(ServerRestartRemoteAgentResult)(
        Schema.encodeUnknownSync(ServerRestartRemoteAgentResult)(result),
      ),
    ).toEqual(result);
  });
});
