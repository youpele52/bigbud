import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { expect, it } from "vitest";
import { observeV2SshBootstrap } from "./ServerManager.ssh.protocol.ts";

it("transport exit alone and wrong nonce/PID never establish remote native physical exit", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
  }) as unknown as ChildProcess;
  const nonce = "x".repeat(43),
    observation = observeV2SshBootstrap(child, nonce);
  child.stdout!.emit(
    "data",
    Buffer.from(JSON.stringify({ url: "http://127.0.0.1:32111", pid: 123, nonce }) + "\n"),
  );
  await observation.ready;
  child.emit("exit", 0);
  expect(observation.hasExited()).toBe(false);
  child.stdout!.emit(
    "data",
    Buffer.from(JSON.stringify({ type: "native-exited", pid: 456, nonce, code: 0 }) + "\n"),
  );
  expect(observation.hasExited()).toBe(false);
});
it("only a matching fixed-bootstrap lease/native PID receipt provides physical exit proof", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
  }) as unknown as ChildProcess;
  const nonce = "x".repeat(43),
    observation = observeV2SshBootstrap(child, nonce);
  child.stdout!.emit(
    "data",
    Buffer.from(JSON.stringify({ url: "http://127.0.0.1:32111", pid: 123, nonce }) + "\n"),
  );
  await observation.ready;
  child.stdout!.emit(
    "data",
    Buffer.from(
      JSON.stringify({ type: "native-exited", pid: 123, nonce, code: null, signal: "SIGTERM" }) +
        "\n",
    ),
  );
  expect(observation.hasExited()).toBe(true);
});
it("wrong readiness nonce is rejected before ownership is accepted", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
  }) as unknown as ChildProcess;
  const observation = observeV2SshBootstrap(child, "x".repeat(43));
  const rejected = expect(observation.ready).rejects.toThrow("rejected");
  child.stdout!.emit(
    "data",
    Buffer.from(JSON.stringify({ url: "http://127.0.0.1:32111", pid: 123, nonce: "wrong" }) + "\n"),
  );
  await rejected;
  expect(observation.hasExited()).toBe(false);
});
