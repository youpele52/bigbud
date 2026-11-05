import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./cuaDriver.manifest", () => ({ validateCuaDriverRuntime: vi.fn() }));
vi.mock("./cuaDriver.process", () => ({ runCommand: vi.fn() }));

import { inspectCuaDriverCompatibility } from "./cuaDriver.compatibility";
import { validateCuaDriverRuntime } from "./cuaDriver.manifest";
import { runCommand } from "./cuaDriver.process";

const flags = ["--embedded", "--socket", "--host-bundle-id", "--pid-file"];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(validateCuaDriverRuntime).mockResolvedValue({
    schema_version: "1",
    binary_version: "0.39.0",
    binary_path: "/driver",
    mcp_invocation: { command: "/driver", args: ["mcp"] },
  });
  vi.mocked(runCommand).mockResolvedValue({ code: 0, stdout: flags.join("\n"), stderr: "" });
});

describe("runtime compatibility preflight", () => {
  it("accepts a newer driver with the embedded CLI contract and private PID support", async () => {
    await expect(inspectCuaDriverCompatibility("/driver", "/policy", "/state")).resolves.toEqual({
      version: "0.39.0",
      honoursPidFile: true,
    });
    expect(validateCuaDriverRuntime).toHaveBeenCalledWith("/driver", "/policy", "/state", 2_000);
    expect(runCommand).toHaveBeenCalledWith(
      "/driver",
      ["serve", "--help"],
      expect.objectContaining({
        CUA_DRIVER_RS_HOME: "/state",
      }),
      2_000,
    );
  });

  it.each(flags)("rejects a newer driver missing %s", async (missing) => {
    vi.mocked(runCommand).mockResolvedValue({
      code: 0,
      stdout: flags.filter((flag) => flag !== missing).join("\n"),
      stderr: "",
    });
    await expect(inspectCuaDriverCompatibility("/driver", "/policy", "/state")).rejects.toThrow(
      missing,
    );
  });

  it("propagates manifest failures before any CLI probe", async () => {
    vi.mocked(validateCuaDriverRuntime).mockRejectedValue(new Error("unsupported manifest"));
    await expect(inspectCuaDriverCompatibility("/driver", "/policy", "/state")).rejects.toThrow(
      "unsupported manifest",
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("does not treat a failed help command as evidence of support", async () => {
    vi.mocked(runCommand).mockResolvedValue({
      code: 1,
      stdout: flags.join(" "),
      stderr: "unsupported serve",
    });
    await expect(inspectCuaDriverCompatibility("/driver", "/policy", "/state")).rejects.toThrow(
      "unsupported serve",
    );
  });
});
