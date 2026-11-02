import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeCuaDriver } from "./CuaDriver.ts";
import { installFakeCuaDriver } from "./CuaDriver.fake.testSupport.ts";

it("rejects an unfamiliar runtime's missing protocol before dispatching a desktop tool", async () => {
  const fake = installFakeCuaDriver("unused");
  const driver = makeCuaDriver();
  process.env.BIGBUD_CUA_VALIDATE_MCP = "1";
  try {
    await expect(Effect.runPromise(driver.callTool("list_apps", {}))).rejects.toThrow(
      "unsupported MCP protocol",
    );
    expect(fake.calls()).toEqual([]);
  } finally {
    await Effect.runPromise(driver.dispose);
    fake.restore();
  }
});
