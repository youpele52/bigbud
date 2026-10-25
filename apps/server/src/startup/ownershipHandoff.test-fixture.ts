import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { onTestFinished, vi } from "vitest";
import {
  ownershipIdentity,
  requestOwnershipControl,
} from "@bigbud/shared/backendOwnership.control";
import { acquireStateDirLock } from "./stateDirLock";
import { createOwnershipHandoff } from "./ownershipHandoff";

export async function ownershipHandoffFixture(ack = true) {
  const cleanup: Array<() => Promise<void>> = [];
  onTestFinished(async () => {
    for (const dispose of cleanup.toReversed()) await dispose();
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "bigbud-handoff-"));
  const stateDir = await realpath(directory);
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const input = new PassThrough();
  const output = new PassThrough();
  const shutdown = vi.fn();
  const control = await createOwnershipHandoff(stateDir, shutdown, { input, output });
  cleanup.push(() => control.close());
  const lock = await acquireStateDirLock({ stateDir, port: 0, control: control.control });
  cleanup.push(() => lock.release());
  await control.attach(lock);
  let prepared = false;
  output.on("data", (chunk) => {
    prepared = true;
    const { operation } = JSON.parse(String(chunk));
    input.write(JSON.stringify({ operation, quiesced: ack }) + "\n");
  });
  const identity = ownershipIdentity(lock.record, stateDir);
  const request = (
    action: "inspect" | "prepare" | "commit" | "status",
    expected = identity,
    operation = "a".repeat(32),
  ) =>
    requestOwnershipControl(control.control, { version: 1, action, identity: expected, operation });
  return { request, shutdown, lock, control: control.control, identity, prepared: () => prepared };
}
