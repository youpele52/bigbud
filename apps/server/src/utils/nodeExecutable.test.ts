import { afterEach, describe, expect, it } from "vitest";

import { resolveNodeExecutable } from "./nodeExecutable.ts";

const originalNodeExecutable = process.env.BIGBUD_NODE_EXECUTABLE;

afterEach(() => {
  if (originalNodeExecutable === undefined) delete process.env.BIGBUD_NODE_EXECUTABLE;
  else process.env.BIGBUD_NODE_EXECUTABLE = originalNodeExecutable;
});

describe("resolveNodeExecutable", () => {
  it("uses the dedicated desktop child runtime when configured", () => {
    process.env.BIGBUD_NODE_EXECUTABLE =
      "/Applications/bigbud.app/Contents/Frameworks/bigbud Helper.app/Contents/MacOS/bigbud Helper";
    expect(resolveNodeExecutable()).toBe(process.env.BIGBUD_NODE_EXECUTABLE);
  });

  it("falls back to the current executable outside desktop packaging", () => {
    delete process.env.BIGBUD_NODE_EXECUTABLE;
    expect(resolveNodeExecutable()).toBe(process.execPath);
  });
});
