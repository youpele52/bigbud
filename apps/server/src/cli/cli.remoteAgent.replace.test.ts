import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { createInterface } from "node:readline/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  sendRemoteAgentControlRequest,
  waitForRemoteAgentOperation,
} from "../remote-agent/remoteAgentLocalControl.client.ts";
import type { RemoteAgentControlRequest } from "../remote-agent/remoteAgentLocalControl.protocol.ts";
import { remoteAgentCommand } from "./cli.remoteAgent.ts";
import {
  KEEP_PREVIOUS_HINT,
  olderInstalledVersion,
  REPLACE_FLAG_CONFLICT,
} from "./cli.remoteAgent.replace.ts";

import { version } from "../../package.json" with { type: "json" };

vi.mock("../remote-agent/remoteAgentLocalControl.client.ts", async (original) => ({
  ...(await original<typeof import("../remote-agent/remoteAgentLocalControl.client.ts")>()),
  sendRemoteAgentControlRequest: vi.fn(),
  waitForRemoteAgentOperation: vi.fn(),
}));
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));

const PROMPT =
  "An older agent build (0.0.1-old) is installed on vps. Replace it after the new one is active? [y/N] ";
const previousExitCode = process.exitCode;
const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
const question = vi.fn<(text: string) => Promise<string>>();
let stdout = "";
let stderr = "";

function setTty(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

beforeEach(() => {
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.mocked(createInterface).mockReturnValue({ question, close: vi.fn() } as never);
});
afterEach(() => {
  process.exitCode = previousExitCode;
  Object.defineProperty(process.stdin, "isTTY", { value: tty.stdin, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: tty.stdout, configurable: true });
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

const operation = (patch: Record<string, unknown> = {}) => ({
  operationId: "00000000-0000-4000-8000-000000000000",
  state: "completed",
  outcome: "active",
  message: "Agent is active.",
  failureKind: null,
  ...patch,
});

/** Status reply and install acceptance; `current` is the installed build (null = fresh host). */
function backend(current: string | null, approved = true) {
  vi.mocked(sendRemoteAgentControlRequest).mockImplementation(async (_socket, request) =>
    request.method === "status"
      ? {
          v: 1,
          ok: true,
          result: {
            executionTargetId: "vps",
            approved,
            health: approved
              ? { status: current ? "installed" : "not-installed", current: { version: current } }
              : "not-checked",
          },
        }
      : { v: 1, ok: true, result: operation({ state: "running", outcome: null }) },
  );
  vi.mocked(waitForRemoteAgentOperation).mockResolvedValue({ v: 1, ok: true, result: operation() });
}

async function install(...flags: string[]) {
  await Effect.runPromise(
    Command.runWith(remoteAgentCommand, { version: "0.0.0" })(["install", "vps", ...flags]).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
  return process.exitCode;
}

const methods = () =>
  vi.mocked(sendRemoteAgentControlRequest).mock.calls.map(([, request]) => request.method);
const installRequest = () =>
  vi
    .mocked(sendRemoteAgentControlRequest)
    .mock.calls.map(([, request]) => request)
    .find((request) => request.method === "install") as Extract<
    RemoteAgentControlRequest,
    { method: "install" }
  >;

describe("remote-agent install replace choice", () => {
  it.each([
    ["y", true],
    ["YES", true],
    ["n", false],
    ["", false],
    ["maybe", false],
  ])("asks when an older build exists and maps %j to replace=%s", async (answer, replace) => {
    setTty(true);
    backend("0.0.1-old");
    question.mockResolvedValue(answer);
    expect(await install()).toBe(0);
    expect(question).toHaveBeenCalledExactlyOnceWith(PROMPT);
    expect(methods()).toEqual(["status", "install"]);
    expect(installRequest().replace).toBe(replace);
    expect(stderr).not.toContain(KEEP_PREVIOUS_HINT);
  });

  it.each([
    ["--replace", true],
    ["--keep-previous", false],
  ])("%s answers without status or prompt", async (flag, replace) => {
    setTty(true);
    backend("0.0.1-old");
    expect(await install(flag)).toBe(0);
    expect(question).not.toHaveBeenCalled();
    expect(methods()).toEqual(["install"]);
    expect(installRequest().replace).toBe(replace);
  });

  it("rejects --replace with --keep-previous before any request", async () => {
    setTty(true);
    expect(await install("--replace", "--keep-previous")).toBe(4);
    expect(sendRemoteAgentControlRequest).not.toHaveBeenCalled();
    expect(stdout).toContain(REPLACE_FLAG_CONFLICT);
  });

  it.each([
    ["non-TTY", false, []],
    ["--json", true, ["--json"]],
  ])("%s keeps older builds with a hint and no prompt", async (_name, interactive, flags) => {
    setTty(interactive);
    backend("0.0.1-old");
    expect(await install(...flags)).toBe(0);
    expect(question).not.toHaveBeenCalled();
    expect(methods()).toEqual(["install"]);
    expect(installRequest().replace).toBe(false);
    expect(stderr).toContain(KEEP_PREVIOUS_HINT);
  });

  it.each([
    ["fresh host", null],
    ["same build already active", version],
  ])("does not ask on a %s", async (_name, current) => {
    setTty(true);
    backend(current);
    expect(await install()).toBe(0);
    expect(question).not.toHaveBeenCalled();
    expect(installRequest().replace).toBe(false);
    expect(stderr).not.toContain(KEEP_PREVIOUS_HINT);
  });

  it("asks consent for an unapproved host but never the replace question", async () => {
    setTty(true);
    backend("0.0.1-old", false);
    vi.mocked(sendRemoteAgentControlRequest)
      .mockResolvedValueOnce({ v: 1, ok: true, result: { approved: false, health: "x" } })
      .mockResolvedValueOnce({
        v: 1,
        ok: true,
        result: { status: "consent-required", message: "Not approved." },
      });
    question.mockResolvedValue("y");
    expect(await install()).toBe(0);
    expect(question).toHaveBeenCalledExactlyOnceWith("Not approved.\nInstall it on vps? [y/N] ");
    expect(methods()).toEqual(["status", "install", "install"]);
    expect(installRequest().replace).toBe(false);
    expect(stderr).toContain(KEEP_PREVIOUS_HINT);
  });

  it("skips the question when status cannot be read", async () => {
    setTty(true);
    backend("0.0.1-old");
    vi.mocked(sendRemoteAgentControlRequest).mockRejectedValueOnce(new Error("ssh down"));
    expect(await install()).toBe(0);
    expect(question).not.toHaveBeenCalled();
    expect(installRequest().replace).toBe(false);
  });

  it.each([
    [[], "use --replace on future installs"],
    [["--replace"], "Retry after that work ends."],
  ])("makes a capacity stop actionable (%j)", async (flags, expected) => {
    setTty(false);
    backend(null);
    vi.mocked(waitForRemoteAgentOperation).mockResolvedValue({
      v: 1,
      ok: true,
      result: operation({ outcome: "deferred", failureKind: "capacity-deferred" }),
    });
    expect(await install("--json", ...flags)).toBe(3);
    expect(JSON.parse(stdout).hint).toContain(expected);
  });

  it("adds no hint to other outcomes", async () => {
    setTty(false);
    backend(null);
    expect(await install("--json", "--keep-previous")).toBe(0);
    expect(JSON.parse(stdout).hint).toBeUndefined();
  });
});

const status = (approved: boolean, current: unknown) => ({ approved, health: { current } });

describe("olderInstalledVersion", () => {
  it("reports only an approved host's different installed build", () => {
    expect(olderInstalledVersion(status(true, { version: "1.0.0" }), "1.1.0")).toBe("1.0.0");
    expect(olderInstalledVersion(status(false, { version: "1.0.0" }), "1.1.0")).toBeNull();
    expect(olderInstalledVersion(status(true, { version: "1.1.0" }), "1.1.0")).toBeNull();
    expect(olderInstalledVersion(status(true, null), "1.1.0")).toBeNull();
    expect(olderInstalledVersion("not-checked", "1.1.0")).toBeNull();
  });
});
