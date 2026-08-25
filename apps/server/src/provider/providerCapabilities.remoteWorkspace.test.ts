import { describe, expect, it } from "vitest";

import { getProviderCapabilities } from "./providerCapabilities.ts";

describe("provider remote workspace capability declarations", () => {
  it("does not claim Devin remote workspace support before its ACP cwd is target-aware", () => {
    expect(getProviderCapabilities("devin").supportsLocalRuntimeRemoteWorkspace).toBe(false);
  });

  it("keeps Cursor unsupported until its custom tools route through the runtime", () => {
    expect(getProviderCapabilities("cursor").supportsLocalRuntimeRemoteWorkspace).toBe(false);
  });
});
