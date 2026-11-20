import { spawn, type ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { PROCESS_START_TOKEN_PREFIX, processStartToken } from "../utils/processStartToken.ts";
import {
  currentRemoteAgentController,
  isRemoteAgentControllerAlive,
} from "./remoteAgentController.ts";

function localId(pid: number) {
  return currentRemoteAgentController().id.replace(
    /:[0-9]+:[^:]+$/,
    `:${pid}:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
  );
}
let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
});

/** A real, unrelated live process standing in for another controller (or a PID reuser). */
async function liveProcess() {
  child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise((resolve) => child!.once("spawn", resolve));
  return child.pid!;
}

describe.skipIf(process.platform === "win32")("isRemoteAgentControllerAlive", () => {
  it("records an environment-independent token for this controller", () => {
    expect(currentRemoteAgentController().startedAt.startsWith(PROCESS_START_TOKEN_PREFIX)).toBe(
      true,
    );
  });

  it("keeps a live controller whose real start token matches", async () => {
    const pid = await liveProcess();
    const startedAt = processStartToken(pid)!;
    expect(await isRemoteAgentControllerAlive({ id: localId(pid), pid, startedAt })).toBe(true);
  });

  it("proves PID reuse only from a comparable token that differs", async () => {
    const pid = await liveProcess();
    const real = processStartToken(pid)!;
    const reused = `${real.slice(0, real.lastIndexOf(":") + 1)}earlier-owner`;
    expect(await isRemoteAgentControllerAlive({ id: localId(pid), pid, startedAt: reused })).toBe(
      false,
    );
  });

  it.each(["Thu_Oct_15_05:47:29_2026", "pid:41"])(
    "fails closed for a live PID with a legacy or placeholder token (%s)",
    async (startedAt) => {
      const pid = await liveProcess();
      expect(await isRemoteAgentControllerAlive({ id: localId(pid), pid, startedAt })).toBe(true);
    },
  );

  it.each(["legacy", "foreign", "wrong-pid"])("keeps an unproven %s owner", async (kind) => {
    const pid = await liveProcess();
    const startedAt = processStartToken(pid)!;
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child!.kill("SIGKILL");
    await exited;
    const id =
      kind === "legacy"
        ? "controller:old"
        : kind === "foreign"
          ? localId(pid).replace(/controller-v2:[a-f0-9]{64}/, `controller-v2:${"f".repeat(64)}`)
          : localId(pid + 1);
    expect(await isRemoteAgentControllerAlive({ id, pid, startedAt })).toBe(true);
  });

  it("reclaims a controller whose process is gone", async () => {
    const pid = await liveProcess();
    const startedAt = processStartToken(pid)!;
    const exited = new Promise((resolve) => child!.once("exit", resolve));
    child!.kill("SIGKILL");
    await exited;
    expect(await isRemoteAgentControllerAlive({ id: localId(pid), pid, startedAt })).toBe(false);
  });
});
