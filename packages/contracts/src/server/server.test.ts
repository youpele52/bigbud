import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerVerifyExecutionTargetResult } from "./server";

describe("ServerVerifyExecutionTargetResult", () => {
  it("round-trips the remote agent upgrade requirement", () => {
    const result = {
      executionTargetId: "ssh:example",
      message: "Remote agent upgrade required.",
      remoteAgent: {
        status: "upgrade-required" as const,
        currentVersion: "0.1.0",
        targetVersion: "0.2.0",
      },
    };

    const encoded = Schema.encodeUnknownSync(ServerVerifyExecutionTargetResult)(result);
    expect(Schema.decodeUnknownSync(ServerVerifyExecutionTargetResult)(encoded)).toEqual(result);
  });
});
