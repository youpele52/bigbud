import { describe, expect, it } from "vitest";

import { FILE_EDIT_MAX_BYTES, localBackendFileEdit } from "./fileEditCapability.ts";

describe("local backend file edit capability", () => {
  it.each([undefined, "local"])("supports guarded saves for %s", (executionTargetId) => {
    expect(localBackendFileEdit(executionTargetId)).toEqual({
      mode: "guarded",
      maxBytes: FILE_EDIT_MAX_BYTES,
    });
  });

  it("keeps legacy direct SSH read only until the Rust SSH owner supports guarded writes", () => {
    expect(localBackendFileEdit("ssh:host=dev&transport=direct-ssh")).toEqual({
      mode: "readOnly",
      maxBytes: 0,
      reason: "directSshPendingOwner",
    });
  });

  it("reports other remote targets as unsupported", () => {
    expect(localBackendFileEdit("wsl:Ubuntu")).toMatchObject({
      mode: "readOnly",
      reason: "unsupportedTarget",
    });
  });
});
