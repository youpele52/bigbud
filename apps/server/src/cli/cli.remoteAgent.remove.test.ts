import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { createInterface } from "node:readline/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendRemoteAgentControlRequest } from "../remote-agent/remoteAgentLocalControl.client.ts";
import {
  parseRemoteAgentControlRequest,
  type RemoteAgentControlRequest,
} from "../remote-agent/remoteAgentLocalControl.protocol.ts";
import { remoteAgentCommand } from "./cli.remoteAgent.ts";
import { REMOVE_FLAG_CONFLICT } from "./cli.remoteAgent.remove.ts";

vi.mock("../remote-agent/remoteAgentLocalControl.client.ts", async (original) => ({
  ...(await original<typeof import("../remote-agent/remoteAgentLocalControl.client.ts")>()),
  sendRemoteAgentControlRequest: vi.fn(),
}));
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));

const previousExitCode = process.exitCode;
const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
const question = vi.fn<(text: string) => Promise<string>>();
let stdout = "";

function setTty(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

beforeEach(() => {
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.mocked(createInterface).mockReturnValue({ question, close: vi.fn() } as never);
});
afterEach(() => {
  process.exitCode = previousExitCode;
  Object.defineProperty(process.stdin, "isTTY", { value: tty.stdin, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: tty.stdout, configurable: true });
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

/** Backend asking for confirmation until consent arrives, then answering with `result`. */
function backend(result: unknown) {
  vi.mocked(sendRemoteAgentControlRequest).mockImplementation(async (_socket, request) =>
    request.method === "remove" && !request.consent
      ? {
          v: 1,
          ok: true,
          result: {
            status: "confirmation-required",
            executionTargetId: "vps",
            message: "Removing deletes ~/.bigbud/agent on this host and disconnects it.",
          },
        }
      : { v: 1, ok: true, result },
  );
}

async function remove(...flags: string[]) {
  await Effect.runPromise(
    Command.runWith(remoteAgentCommand, { version: "0.0.0" })(["remove", "vps", ...flags]).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );
  return process.exitCode;
}

const removeRequests = () =>
  vi
    .mocked(sendRemoteAgentControlRequest)
    .mock.calls.map(([, request]) => request)
    .filter((request) => request.method === "remove") as Array<
    Extract<RemoteAgentControlRequest, { method: "remove" }>
  >;

const removed = { outcome: "removed", disconnected: 1, switchedWorkspaceIds: ["p1"] };

describe("remote-agent remove", () => {
  it("removes with --yes and switches workspaces to Direct SSH by default", async () => {
    backend(removed);
    expect(await remove("--yes")).toBe(0);
    expect(removeRequests()).toEqual([
      { method: "remove", target: "vps", switchToDirectSsh: true, consent: true },
    ]);
    expect(stdout).toContain(
      "Removed ~/.bigbud/agent from vps. 1 workspace(s) now use Direct SSH.",
    );
  });

  it("asks interactively and sends consent only after yes", async () => {
    setTty(true);
    backend(removed);
    question.mockResolvedValue("y");
    expect(await remove("--keep-transport")).toBe(0);
    expect(removeRequests().map((request) => [request.consent, request.switchToDirectSsh])).toEqual(
      [
        [false, false],
        [true, false],
      ],
    );
  });

  it("needs --yes when not interactive and removes nothing", async () => {
    setTty(false);
    backend(removed);
    expect(await remove()).toBe(2);
    expect(removeRequests()).toHaveLength(1);
    expect(stdout).toContain("Rerun with --yes to confirm.");
  });

  it("lists blockers and exits as deferred", async () => {
    backend({ outcome: "blocked", blockers: [{ kind: "terminal", label: "Terminal in /srv" }] });
    expect(await remove("--yes")).toBe(3);
    expect(stdout).toContain("Nothing was removed.");
    expect(stdout).toContain("  - Terminal in /srv");
  });

  it("reports a failed removal", async () => {
    backend({ outcome: "failed", message: "ssh: connection refused" });
    expect(await remove("--yes", "--json")).toBe(4);
    expect(JSON.parse(stdout)).toMatchObject({ outcome: "failed" });
  });

  it("rejects conflicting transport flags before any request", async () => {
    expect(await remove("--switch-to-direct-ssh", "--keep-transport")).toBe(4);
    expect(sendRemoteAgentControlRequest).not.toHaveBeenCalled();
    expect(stdout).toContain(REMOVE_FLAG_CONFLICT);
  });
});

describe("remove request parsing", () => {
  it("defaults to switching workspaces and validates fields", () => {
    expect(parseRemoteAgentControlRequest({ v: 1, method: "remove", target: "vps" })).toEqual({
      method: "remove",
      target: "vps",
      switchToDirectSsh: true,
      consent: false,
    });
    expect(
      parseRemoteAgentControlRequest({ v: 1, method: "remove", target: "vps", consent: "yes" }),
    ).toEqual({ error: "consent must be a boolean." });
    expect(
      parseRemoteAgentControlRequest({ v: 1, method: "remove", target: "vps", replace: true }),
    ).toEqual({ error: "Request contains unsupported fields." });
  });
});
