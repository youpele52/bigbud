import { describe, expect, it } from "vitest";

import {
  getProviderEffortField,
  getRawProviderEffort,
  patchProviderEffort,
} from "./model.effortFields";

describe("CLIProxy effort options", () => {
  it("reads, updates, and clears the native effort field", () => {
    expect(getProviderEffortField("cliProxy")).toBe("effort");
    const options = patchProviderEffort("cliProxy", undefined, "xhigh");
    expect(options).toEqual({ effort: "xhigh" });
    expect(getRawProviderEffort("cliProxy", options)).toBe("xhigh");
    expect(patchProviderEffort("cliProxy", options, undefined)).toBeUndefined();
  });
});
