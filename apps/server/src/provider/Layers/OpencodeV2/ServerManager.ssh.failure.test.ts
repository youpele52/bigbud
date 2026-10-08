import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { expect, it } from "vitest";
import { startOwnedV2SshProcess } from "./ServerManager.ssh.ts";
import { V2UnconfirmedProcessStartup } from "./ServerManager.lifecycle.ts";
import { OpencodeV2ServerManager } from "./ServerManager.ts";

it("actual SSH constructor failure after native readiness retains its observer/namespace after bounded transport close", async () => {
  const children: ChildProcess[] = [];
  let nonce = "";
  const fakeSpawn = ((_command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
    });
    const exit = () => {
      if (child.exitCode === null) {
        child.exitCode = 0;
        child.emit("exit", 0);
      }
    };
    child.stdin.on("finish", exit);
    children.push(child as unknown as ChildProcess);
    if (!args.includes("-N"))
      child.stdin.once("data", (bytes) => {
        nonce = JSON.parse(bytes.toString()).nonce;
        child.stdout.write(
          JSON.stringify({ url: "http://127.0.0.1:32111", pid: 9191, nonce }) + "\n",
        );
      });
    else queueMicrotask(exit); // API tunnel fails; native model process is still live.
    return child;
  }) as unknown as typeof spawn;
  const config = {
    runtimeTargetId: "ssh:host=fixture.invalid&user=fixture&auth=ssh-key",
    binaryPath: "/native/v2",
    profileRoot: "/owned/profile",
  };
  let retained: V2UnconfirmedProcessStartup | undefined;
  const manager = new OpencodeV2ServerManager({
    maxProcesses: 2,
    maxOwners: 25,
    maxQueuedEvents: 4,
    maxEventBytes: 1024,
    consumerTimeoutMs: 100,
    start: async (config) => {
      try {
        return await startOwnedV2SshProcess(config, {
          protectedBootstrapConformance: true,
          spawn: fakeSpawn,
        });
      } catch (error) {
        if (error instanceof V2UnconfirmedProcessStartup) retained = error;
        throw error;
      }
    },
  });
  try {
    await expect(manager.acquire(config)).rejects.toThrow("acquisition failed");
    expect(retained).toBeInstanceOf(V2UnconfirmedProcessStartup);
    expect(retained!.process.hasExited!()).toBe(false);
    let deaths = 0;
    retained!.process.onDeath(() => {
      deaths++;
    });
    await expect(manager.acquire(config)).rejects.toThrow("closing");
    expect(children).toHaveLength(2);
    await expect(retained!.process.close()).rejects.toThrow("unconfirmed");
    expect(deaths).toBe(0);
    // The exact retained fixed-bootstrap receipt, not local SSH exit, releases ownership.
    children[0]!.stdout!.emit(
      "data",
      Buffer.from(JSON.stringify({ type: "native-exited", pid: 9191, nonce, code: 0 }) + "\n"),
    );
    expect(deaths).toBe(1);
    expect(retained!.process.hasExited!()).toBe(true);
    expect((manager as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
  } finally {
    await manager.close();
  }
});
