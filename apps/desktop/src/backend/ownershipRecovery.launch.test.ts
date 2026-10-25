import { expect, it } from "vitest";
import path from "node:path";
import { getOwnershipLaunch, recordOwnershipLaunch } from "./ownershipRecovery.launch";

it("captures environment precedence and dev state from the actual launch snapshot", () => {
  const env = {
    BIGBUD_HOME: "relative",
    T3CODE_HOME: "/legacy",
    VITE_DEV_SERVER_URL: "http://localhost:5173",
  };
  expect(
    recordOwnershipLaunch({
      generation: 2,
      env,
      baseDir: "/default",
      cwd: "/working",
      launcher: "/node",
      entry: "/server",
      inspector: null,
    }),
  ).toBe(env);
  env.BIGBUD_HOME = "changed-after-spawn";
  expect(getOwnershipLaunch()?.stateDir).toBe(path.resolve("/working", "relative", "dev"));
  recordOwnershipLaunch({
    generation: 3,
    env: { T3CODE_HOME: "/legacy" },
    baseDir: "/default",
    cwd: "/working",
    launcher: "/node",
    entry: "/server",
    inspector: null,
  });
  expect(getOwnershipLaunch()?.stateDir).toBe(path.resolve("/legacy", "userdata"));
});
