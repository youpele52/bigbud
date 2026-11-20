import { expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { makeRemoteAgentPtyAdapter } from "./remoteAgentPtyAdapter";
import { spawnInput } from "./remoteAgentOwnedPty.profile.testUtils";
import type { PtyProcess } from "../terminal/Services/PTY";

it("propagates caller cancellation to cold recovery and retires a late local observer only", async () => {
  let resolve!: (process: PtyProcess) => void;
  let receivedSignal: AbortSignal | undefined;
  let entered!: () => void;
  const reached = new Promise<void>((done) => {
    entered = done;
  });
  const detach = vi.fn();
  const kill = vi.fn();
  const process = { pid: 42, detach, kill } as unknown as PtyProcess;
  const create = vi.fn(async () => {
    throw new Error("No create");
  });
  const adapter = makeRemoteAgentPtyAdapter(
    { spawn: () => Effect.die("No local spawn") },
    {
      restoreOrCreate: async (input) => {
        receivedSignal = input.recoverySignal;
        entered();
        return new Promise<PtyProcess>((done) => {
          resolve = done;
        });
      },
      resolvePty: create,
      resolveWorkspace: async () => {
        throw new Error("No workspace creation");
      },
    },
  );
  const controller = new AbortController();
  const pending = Effect.runPromise(
    adapter.spawn({ ...spawnInput(), recoverOnly: true, expectedRemoteResourceId: "existing" }),
    { signal: controller.signal },
  );
  const rejection = expect(pending).rejects.toThrow();
  await reached;
  controller.abort();
  await rejection;
  expect(receivedSignal?.aborted).toBe(true);
  resolve(process);
  await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
  expect(kill).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
