import { describe, expect, it } from "vitest";

import { withOperationId } from "./wsRpcClient.operationId";

describe("withOperationId", () => {
  it("adds a prefixed identity once and keeps a caller-provided one", () => {
    const input: { cwd: string; relativePath: string; operationId?: string } = {
      cwd: "/w",
      relativePath: "a",
    };
    const added = withOperationId(input, "workspace-delete");
    expect(added.operationId).toMatch(/^workspace-delete-.+/);
    const kept = withOperationId({ ...input, operationId: "mine" }, "workspace-delete");
    expect(kept.operationId).toBe("mine");
  });
});
