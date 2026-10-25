import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeResolveWslTerminalFolder } from "./Manager.wsl";
import { wslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import {
  WSL_CWD_FAILURE_OUTPUT,
  WSL_IDENTITY_SCRIPT,
  WSL_PATH_SCRIPT,
} from "./Manager.wsl.invocation";
import type { ProcessRunResult } from "../../utils/processRunner";

const reply = (stdout: string, code = 0): ProcessRunResult => ({
  stdout: Buffer.from(stdout).toString("latin1"),
  code,
  stderr: "",
  signal: null,
  timedOut: false,
});
const pathReply = (path: string) => reply(`path\0${path}\0`);
const input = {
  threadId: "thread",
  terminalId: "terminal",
  executionTargetId: wslTerminalTargetId("Ubuntu dev"),
  cwd: "C:\\project",
};
// Explicit concatenation prevents numeric escape interpretation in test protocol fixtures.
const identityReply = () => reply(["identity", "alice", "1000", "/custom/home", ""].join("\0"));
afterEach(() => {
  vi.restoreAllMocks();
});

describe("target-bound WSL folder resolution", () => {
  it("captures once, pins every reprobe, maps cwd/worktree and known path env without guessing", async () => {
    const runner = vi.fn().mockResolvedValue(pathReply("/mapped/project"));
    runner
      .mockResolvedValueOnce(reply("Ubuntu dev\r\nOther\r\n"))
      .mockResolvedValueOnce(identityReply());
    const result = await Effect.runPromise(
      makeResolveWslTerminalFolder(
        runner,
        "win32",
      )({
        ...input,
        worktreePath: "C:\\worktree",
        env: {
          T3CODE_PROJECT_ROOT: "C:\\project",
          T3CODE_WORKTREE_PATH: "C:\\worktree",
          CUSTOM: "unchanged",
        },
      }),
    );
    expect(result).toMatchObject({
      cwd: "/mapped/project",
      worktreePath: "/mapped/project",
      env: {
        T3CODE_PROJECT_ROOT: "/mapped/project",
        T3CODE_WORKTREE_PATH: "/mapped/project",
        CUSTOM: "unchanged",
      },
      wslIdentity: { distribution: "Ubuntu dev", username: "alice", uid: 1000 },
    });
    expect(runner.mock.calls[1]?.[0]).toContain(WSL_IDENTITY_SCRIPT);
    expect(runner.mock.calls[1]?.[0]).not.toContain("--user");
    for (const [args, options] of runner.mock.calls.slice(2)) {
      expect(args.slice(0, 4)).toEqual(["--distribution", "Ubuntu dev", "--user", "alice"]);
      expect(args).toContain(WSL_PATH_SCRIPT);
      expect(args).toContain("1000");
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(options.timeoutMs).toBeLessThanOrEqual(10_000);
    }
  });
  it("fallback uses the remaining deadline, same identity, process HOME and cleared project context", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const runner = vi
      .fn()
      .mockResolvedValueOnce(reply("Ubuntu dev\n"))
      .mockResolvedValueOnce(identityReply())
      .mockImplementationOnce(async () => {
        clock = 9_000;
        return reply(WSL_CWD_FAILURE_OUTPUT, 77);
      })
      .mockResolvedValueOnce(pathReply("/custom/home"));
    const result = await Effect.runPromise(
      makeResolveWslTerminalFolder(
        runner,
        "win32",
      )({ ...input, cwd: "/missing", worktreePath: "C:\\missing", env: { SETUP: "do-not-run" } }),
    );
    expect(result).toMatchObject({
      cwd: "/custom/home",
      env: {},
      worktreePath: null,
      directoryFallback: { requestedCwd: "/missing" },
      wslIdentity: { username: "alice" },
    });
    expect(runner.mock.calls[3]?.[1].timeoutMs).toBe(1_000);
    expect(runner.mock.calls[3]?.[0]).toContain("/custom/home");
    expect(runner.mock.calls[3]?.[0]).toContain("alice");
    expect(runner.mock.calls[3]?.[0]).not.toContain("SETUP=do-not-run");
  });
  it("rejects a late Home result instead of restarting the resolution deadline", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const runner = vi
      .fn()
      .mockResolvedValueOnce(reply("Ubuntu dev\n"))
      .mockResolvedValueOnce(identityReply())
      .mockImplementationOnce(async () => {
        clock = 9_000;
        return reply(WSL_CWD_FAILURE_OUTPUT, 77);
      })
      .mockImplementationOnce(async () => {
        clock = 10_001;
        return pathReply("/custom/home");
      });
    await expect(
      Effect.runPromise(
        makeResolveWslTerminalFolder(runner, "win32")({ ...input, cwd: "/missing" }),
      ),
    ).rejects.toThrow("10 seconds");
    expect(runner).toHaveBeenCalledTimes(4);
  });
  it.each(["/missing\nfolder", "/missing\x1b[31m", "C:\\missing\x7f", `/${"x".repeat(4096)}`])(
    "rejects malformed requested paths before a guest path probe or fallback",
    async (cwd) => {
      const runner = vi
        .fn()
        .mockResolvedValueOnce(reply("Ubuntu dev\n"))
        .mockResolvedValueOnce(identityReply())
        .mockResolvedValueOnce(reply(WSL_CWD_FAILURE_OUTPUT, 77))
        .mockResolvedValueOnce(pathReply("/custom/home"));
      await expect(
        Effect.runPromise(makeResolveWslTerminalFolder(runner, "win32")({ ...input, cwd })),
      ).rejects.toThrow("path is invalid");
      expect(runner).not.toHaveBeenCalled();
    },
  );
  it.each([
    { worktreePath: "/worktree\ninvalid" },
    { env: { BIGBUD_PROJECT_ROOT: "/project\x1b[31m" } },
  ])("rejects malformed context paths before translating them", async (context) => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(reply("Ubuntu dev\n"))
      .mockResolvedValueOnce(identityReply())
      .mockResolvedValueOnce(pathReply("/project"));
    await expect(
      Effect.runPromise(
        makeResolveWslTerminalFolder(runner, "win32")({ ...input, cwd: "/project", ...context }),
      ),
    ).rejects.toThrow("path is invalid");
    expect(runner).not.toHaveBeenCalled();
  });
  it.each(
    [
      "worktreePath",
      "BIGBUD_PROJECT_ROOT",
      "BIGBUD_WORKTREE_PATH",
      "T3CODE_PROJECT_ROOT",
      "T3CODE_WORKTREE_PATH",
    ].flatMap((field) => ["/missing", "/project"].map((cwd) => ({ field, cwd }))),
  )("rejects malformed $field before any probe for $cwd", async ({ field, cwd }) => {
    for (const value of [
      "/bad\nfolder",
      "/bad\x1bfolder",
      "/bad\0folder",
      `/${"x".repeat(4096)}`,
      "",
    ]) {
      const runner = vi
        .fn()
        .mockResolvedValueOnce(reply("Ubuntu dev\n"))
        .mockResolvedValueOnce(identityReply())
        .mockResolvedValueOnce(
          cwd === "/missing" ? reply(WSL_CWD_FAILURE_OUTPUT, 77) : pathReply(cwd),
        )
        .mockResolvedValue(pathReply("/custom/home"));
      const context =
        field === "worktreePath" ? { worktreePath: value } : { env: { [field]: value } };
      await expect(
        Effect.runPromise(
          makeResolveWslTerminalFolder(runner, "win32")({ ...input, cwd, ...context }),
        ),
      ).rejects.toThrow("path is invalid");
      expect(runner).not.toHaveBeenCalled();
    }
  });
  it("valid raw context still permits same-identity Home fallback and discards project context", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(reply("Ubuntu dev\n"))
      .mockResolvedValueOnce(identityReply())
      .mockResolvedValueOnce(reply(WSL_CWD_FAILURE_OUTPUT, 77))
      .mockResolvedValueOnce(pathReply("/custom/home"));
    const result = await Effect.runPromise(
      makeResolveWslTerminalFolder(
        runner,
        "win32",
      )({
        ...input,
        cwd: "/missing",
        worktreePath: "C:\\worktree",
        env: { BIGBUD_PROJECT_ROOT: "C:\\project", CUSTOM: "config\ntext\x1b" },
      }),
    );
    expect(result).toMatchObject({
      cwd: "/custom/home",
      env: {},
      worktreePath: null,
      directoryFallback: { requestedCwd: "/missing" },
      wslIdentity: { distribution: "Ubuntu dev", username: "alice", uid: 1000 },
    });
    expect(runner).toHaveBeenCalledTimes(4);
    expect(runner.mock.calls[2]?.[0]).toContain("CUSTOM=config\ntext\x1b");
    expect(runner.mock.calls[3]?.[0]).not.toContain("BIGBUD_PROJECT_ROOT=C:\\project");
  });
  it.each([undefined, null])("accepts absent worktree context %s", async (worktreePath) => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(reply("Ubuntu dev\n"))
      .mockResolvedValueOnce(identityReply())
      .mockResolvedValueOnce(pathReply("/project"));
    const result = await Effect.runPromise(
      makeResolveWslTerminalFolder(
        runner,
        "win32",
      )({
        ...input,
        cwd: "/project",
        worktreePath,
        env: undefined,
      }),
    );
    expect(result.cwd).toBe("/project");
    expect(runner).toHaveBeenCalledTimes(3);
  });
  it.each([79, 80, 1])(
    "target, user or missing-utility error %s never falls back",
    async (code) => {
      const runner = vi
        .fn()
        .mockResolvedValueOnce(reply("Ubuntu dev\n"))
        .mockResolvedValueOnce(identityReply())
        .mockResolvedValueOnce(reply("", code));
      await expect(
        Effect.runPromise(makeResolveWslTerminalFolder(runner, "win32")(input)),
      ).rejects.toThrow("translation failed");
      expect(runner).toHaveBeenCalledTimes(3);
    },
  );
  it("missing target never probes a default distro or host HOME", async () => {
    const runner = vi.fn().mockResolvedValue(reply("Other\n"));
    await expect(
      Effect.runPromise(makeResolveWslTerminalFolder(runner, "win32")(input)),
    ).rejects.toThrow("no longer registered");
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it("does not treat an unconfirmed wrapper exit 77 as a directory failure", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(reply("Ubuntu dev\n"))
      .mockResolvedValueOnce(identityReply())
      .mockResolvedValueOnce(reply("", 77))
      .mockResolvedValueOnce(pathReply("/custom/home"));
    await expect(
      Effect.runPromise(
        makeResolveWslTerminalFolder(runner, "win32")({ ...input, cwd: "/missing" }),
      ),
    ).rejects.toThrow("translation failed");
    expect(runner).toHaveBeenCalledTimes(3);
  });
  it("expands home paths from the captured HOME rather than a later process default", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(reply("Ubuntu dev\n"))
      .mockResolvedValueOnce(identityReply())
      .mockResolvedValueOnce(pathReply("/custom/home/Documents"));
    await Effect.runPromise(
      makeResolveWslTerminalFolder(runner, "win32")({ ...input, cwd: "~/Documents" }),
    );
    expect(runner.mock.calls[2]?.[0]).toContain("/custom/home/Documents");
    expect(runner.mock.calls[2]?.[0]).not.toContain("~/Documents");
  });
  it.each([
    "identity\0alice\0bad\0/home\0",
    ["identity", "alice", "1000", "relative", ""].join("\0"),
    ["banner\nidentity", "alice", "1000", "/home", ""].join("\0"),
  ])("malformed identity fails closed", async (stdout) => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(reply("Ubuntu dev\n"))
      .mockResolvedValueOnce(reply(stdout));
    await expect(
      Effect.runPromise(makeResolveWslTerminalFolder(runner, "win32")(input)),
    ).rejects.toThrow();
    expect(runner).toHaveBeenCalledTimes(2);
  });
  it.each(["path\0relative\0", "path\0/a\n/b\0", "path\0/a\0/b\0", "garbage"])(
    "malformed translated path fails without Home retry",
    async (stdout) => {
      const runner = vi
        .fn()
        .mockResolvedValueOnce(reply("Ubuntu dev\n"))
        .mockResolvedValueOnce(identityReply())
        .mockResolvedValueOnce(reply(stdout));
      await expect(
        Effect.runPromise(makeResolveWslTerminalFolder(runner, "win32")(input)),
      ).rejects.toThrow();
      expect(runner).toHaveBeenCalledTimes(3);
    },
  );
  it("timeout and output overflow fail closed even after identity capture", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce(reply("Ubuntu dev\n"))
      .mockResolvedValueOnce(identityReply())
      .mockResolvedValueOnce({ ...pathReply("/late"), timedOut: true });
    await expect(
      Effect.runPromise(makeResolveWslTerminalFolder(runner, "win32")(input)),
    ).rejects.toThrow("10 seconds");
    expect(runner).toHaveBeenCalledTimes(3);
    const overflow = vi.fn().mockRejectedValue(new Error("output buffer limit"));
    await expect(
      Effect.runPromise(makeResolveWslTerminalFolder(overflow, "win32")(input)),
    ).rejects.toThrow("buffer limit");
  });
  it("non-Windows and malformed WSL IDs never invoke any process", async () => {
    const runner = vi.fn();
    await expect(
      Effect.runPromise(makeResolveWslTerminalFolder(runner, "darwin")(input)),
    ).rejects.toThrow("unsupported");
    await expect(
      Effect.runPromise(
        makeResolveWslTerminalFolder(runner, "win32")({ ...input, executionTargetId: "wsl:%GG" }),
      ),
    ).rejects.toThrow("unsupported");
    expect(runner).not.toHaveBeenCalled();
  });
  it("uses one shared requested deadline including discovery, identity and mapping", async () => {
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const runner = vi
      .fn()
      .mockImplementationOnce(async () => {
        clock = 3_000;
        return reply("Ubuntu dev\n");
      })
      .mockImplementationOnce(async () => {
        clock = 6_000;
        return identityReply();
      })
      .mockImplementationOnce(async () => {
        clock = 10_000;
        return pathReply("/late");
      });
    await expect(
      Effect.runPromise(makeResolveWslTerminalFolder(runner, "win32")(input)),
    ).rejects.toThrow("10 seconds");
    expect(runner.mock.calls.map((call) => call[1].timeoutMs)).toEqual([10_000, 7_000, 4_000]);
    expect(runner).toHaveBeenCalledTimes(3);
  });
  it("Home timeout or changed Linux UID fails closed without recapturing a default user", async () => {
    for (const failure of [reply("", 79), { ...pathReply("/late"), timedOut: true }]) {
      const runner = vi
        .fn()
        .mockResolvedValueOnce(reply("Ubuntu dev\n"))
        .mockResolvedValueOnce(identityReply())
        .mockResolvedValueOnce(reply(WSL_CWD_FAILURE_OUTPUT, 77))
        .mockResolvedValueOnce(failure);
      await expect(
        Effect.runPromise(
          makeResolveWslTerminalFolder(runner, "win32")({ ...input, cwd: "/missing" }),
        ),
      ).rejects.toThrow();
      expect(runner).toHaveBeenCalledTimes(4);
      expect(runner.mock.calls[3]?.[0].slice(0, 4)).toEqual([
        "--distribution",
        "Ubuntu dev",
        "--user",
        "alice",
      ]);
    }
  });
});
