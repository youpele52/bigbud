import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RemoteAgentBackendUnavailableError,
  sendRemoteAgentControlRequest,
  waitForRemoteAgentOperation,
} from "../remote-agent/remoteAgentLocalControl.client.ts";
import { remoteAgentCommand } from "./cli.remoteAgent.ts";

vi.mock("../remote-agent/remoteAgentLocalControl.client.ts", async (original) => ({
  ...(await original<typeof import("../remote-agent/remoteAgentLocalControl.client.ts")>()),
  sendRemoteAgentControlRequest: vi.fn(),
  waitForRemoteAgentOperation: vi.fn(),
}));

const previousExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

async function install() {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await Effect.runPromise(
    Command.runWith(remoteAgentCommand, { version: "0.0.0" })([
      "install",
      "vps",
      "--json",
      "--yes",
    ]).pipe(Effect.provide(NodeServices.layer)),
  );
  return process.exitCode;
}

const snapshot = (outcome: string | null, state = "completed") => ({
  operationId: "00000000-0000-4000-8000-000000000000",
  state,
  outcome,
  message: "Operation result",
});

describe("remote-agent CLI exit codes", () => {
  it.each([
    ["active", 0],
    ["staged", 3],
    ["deferred", 3],
    ["failed", 4],
    ["uncertain", 5],
  ] as const)("maps a completed %s operation to %s", async (outcome, exit) => {
    vi.mocked(sendRemoteAgentControlRequest).mockResolvedValue({
      v: 1,
      ok: true,
      result: snapshot(null, "running"),
    });
    vi.mocked(waitForRemoteAgentOperation).mockResolvedValue({
      v: 1,
      ok: true,
      result: snapshot(outcome),
    });
    expect(await install()).toBe(exit);
  });

  it("returns 2 when consent is required in JSON mode", async () => {
    vi.mocked(sendRemoteAgentControlRequest).mockResolvedValue({
      v: 1,
      ok: true,
      result: { status: "consent-required", message: "Consent required" },
    });
    expect(await install()).toBe(2);
    expect(waitForRemoteAgentOperation).not.toHaveBeenCalled();
  });

  it("returns 4 for admission failure", async () => {
    vi.mocked(sendRemoteAgentControlRequest).mockResolvedValue({
      v: 1,
      ok: false,
      error: { code: "target", message: "Unknown target" },
    });
    expect(await install()).toBe(4);
  });

  it("returns 6 when the backend is unavailable before acceptance", async () => {
    vi.mocked(sendRemoteAgentControlRequest).mockRejectedValue(
      new RemoteAgentBackendUnavailableError("Unavailable"),
    );
    expect(await install()).toBe(6);
  });

  it("retains the caller ID on a lost initial reply for read-only recovery", async () => {
    vi.mocked(sendRemoteAgentControlRequest).mockRejectedValue(new Error("Lost reply"));
    expect(await install()).toBe(5);
    const request = vi.mocked(sendRemoteAgentControlRequest).mock.calls[0]![1];
    expect(request).toMatchObject({ method: "install", operationId: expect.any(String) });
    const output = vi
      .mocked(process.stdout.write)
      .mock.calls.map((args) => args[0])
      .join("");
    expect(JSON.parse(output)).toMatchObject({
      operationId: (request as { operationId: string }).operationId,
      target: "vps",
      outcome: "uncertain",
    });
  });

  it("follows an existing ID without dispatching install", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.mocked(waitForRemoteAgentOperation).mockResolvedValue({
      v: 1,
      ok: true,
      result: snapshot("active"),
    });
    await Effect.runPromise(
      Command.runWith(remoteAgentCommand, { version: "0.0.0" })([
        "follow",
        snapshot(null).operationId,
        "--json",
      ]).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(process.exitCode).toBe(0);
    expect(sendRemoteAgentControlRequest).not.toHaveBeenCalled();
    expect(waitForRemoteAgentOperation).toHaveBeenCalledWith(
      expect.any(String),
      snapshot(null).operationId,
    );
  });

  it("returns 5 when the backend disappears after acceptance", async () => {
    vi.mocked(sendRemoteAgentControlRequest).mockResolvedValue({
      v: 1,
      ok: true,
      result: snapshot(null, "running"),
    });
    vi.mocked(waitForRemoteAgentOperation).mockRejectedValue(
      new RemoteAgentBackendUnavailableError("Unavailable"),
    );
    expect(await install()).toBe(5);
    const output = vi
      .mocked(process.stdout.write)
      .mock.calls.map((args) => args[0])
      .join("");
    expect(JSON.parse(output)).toMatchObject({
      operationId: snapshot(null).operationId,
      target: "vps",
      outcome: "uncertain",
    });
  });

  it("returns 5 when an accepted operation cannot be read", async () => {
    vi.mocked(sendRemoteAgentControlRequest).mockResolvedValue({
      v: 1,
      ok: true,
      result: snapshot(null, "running"),
    });
    vi.mocked(waitForRemoteAgentOperation).mockResolvedValue({
      v: 1,
      ok: false,
      error: { code: "unavailable", message: "Lost operation" },
    });
    expect(await install()).toBe(5);
  });
});
