import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/processRunner.ts", () => ({
  runProcess: vi.fn(),
}));

import { runProcess } from "../../utils/processRunner.ts";
import { resetCuaDriverDaemon } from "./CuaDriver.reset.ts";

const mockedRunProcess = vi.mocked(runProcess);
const result = (code: number) => ({
  stdout: "",
  stderr: "",
  code,
  signal: null,
  timedOut: false,
});

describe("resetCuaDriverDaemon", () => {
  beforeEach(() => mockedRunProcess.mockReset());

  it("stops the uncertain daemon and waits for Electron's replacement", async () => {
    mockedRunProcess
      .mockResolvedValueOnce(result(0))
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(0));

    await resetCuaDriverDaemon({
      command: "/tmp/cua-driver",
      socketPath: "/tmp/cua.sock",
      reason: "click was interrupted",
    });

    expect(mockedRunProcess).toHaveBeenNthCalledWith(
      1,
      "/tmp/cua-driver",
      ["stop", "--socket", "/tmp/cua.sock"],
      expect.objectContaining({ allowNonZeroExit: true }),
    );
    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      "/tmp/cua-driver",
      ["status", "--socket", "/tmp/cua.sock"],
      expect.objectContaining({ allowNonZeroExit: true }),
    );
  });
});
