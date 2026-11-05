import { join } from "node:path";

import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/processRunner.ts", () => ({
  runProcess: vi.fn(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  })),
}));

import { runProcess } from "../../utils/processRunner.ts";
import { makeCuaDriver } from "./CuaDriver.ts";
import { installFakeCuaDriver } from "./CuaDriver.fake.testSupport.ts";

let fake: ReturnType<typeof installFakeCuaDriver>;
const stopCommands = () =>
  vi.mocked(runProcess).mock.calls.filter(([, args]) => (args as string[])[0] === "stop");

describe("CuaDriver stopAllActivity", () => {
  beforeEach(() => {
    fake = installFakeCuaDriver("click");
    vi.mocked(runProcess).mockClear();
  });

  afterEach(() => fake.restore());

  it("drops queued and in-flight input, then accepts new work", async () => {
    const driver = makeCuaDriver();
    const click = Effect.runPromise(Effect.exit(driver.callTool("click", { x: 1, y: 1 })));
    const typing = Effect.runPromise(Effect.exit(driver.callTool("type_text", { text: "hi" })));
    await fake.waitForCall("click");

    await expect(Effect.runPromise(driver.stopAllActivity!("test stop"))).resolves.toBe("reset");

    for (const exit of [await click, await typing]) {
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("stopped by the user");
    }
    expect(fake.calls()).toEqual(["click"]);
    // Without a socket the killed stdio proxy was the driver: no daemon command runs.
    expect(runProcess).not.toHaveBeenCalled();
    const after = await Effect.runPromise(driver.callTool("list_apps", {}));
    expect(after.content).toEqual([{ type: "text", text: "ok" }]);
    await Effect.runPromise(driver.dispose);
  }, 20_000);

  it("restarts a socket daemon once for two quick Stops", async () => {
    process.env.BIGBUD_CUA_ENDPOINT = join(fake.dir, "daemon.sock");
    process.env.BIGBUD_CUA_HOST_BUNDLE_ID = "ai.bigbud.test";
    const driver = makeCuaDriver();
    const click = Effect.runPromise(Effect.exit(driver.callTool("click", { x: 1, y: 1 })));
    await fake.waitForCall("click");

    await Promise.all([
      Effect.runPromise(driver.stopAllActivity!("first")),
      Effect.runPromise(driver.stopAllActivity!("second")),
    ]);

    expect(Exit.isFailure(await click)).toBe(true);
    expect(stopCommands()).toHaveLength(1);
    expect(stopCommands()[0]![1]).toEqual(["stop", "--socket", join(fake.dir, "daemon.sock")]);
    await Effect.runPromise(driver.dispose);
  }, 20_000);

  it("reports an idle driver when nothing was running and no daemon socket exists", async () => {
    const driver = makeCuaDriver();
    await expect(Effect.runPromise(driver.stopAllActivity!("idle stop"))).resolves.toBe("idle");
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("keeps desktop calls working after a Stop whose daemon restart failed", async () => {
    process.env.BIGBUD_CUA_ENDPOINT = join(fake.dir, "daemon.sock");
    process.env.BIGBUD_CUA_HOST_BUNDLE_ID = "ai.bigbud.test";
    vi.mocked(runProcess).mockRejectedValueOnce(new Error("socket was not released"));
    const driver = makeCuaDriver();

    const exit = await Effect.runPromise(Effect.exit(driver.stopAllActivity!("failed stop")));
    expect(Exit.isFailure(exit) && String(exit.cause)).toContain("did not come back after Stop");
    const after = await Effect.runPromise(driver.callTool("list_apps", {}));
    expect(after.content).toEqual([{ type: "text", text: "ok" }]);
    await Effect.runPromise(driver.dispose);
  }, 20_000);
});
