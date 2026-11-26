import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  assertHostedDirectShellsReachable,
  forgetHostedDirectShells,
  settleHostedDirectShellPane,
} from "../terminal/Layers/Manager.shell.direct.settle.ts";
import { NativeSshPtyHostLostError } from "../terminal/Services/PTY.ts";
import {
  first,
  input,
  pane,
  replace,
  setup,
} from "./localTerminalHost.directSsh.owner.policy.testUtils.ts";

describe("native direct SSH terminal policy actions target only the exact lease", () => {
  it("a delayed close or status for an old lease never reaches its replacement", async () => {
    const f = await setup();
    await Effect.runPromise(f.native.spawn(input));
    const old = (await f.route())!;
    await f.lifecycle.close(old);
    const replacement = await replace(f, (await f.route())!);
    expect(replacement.resourceId).toBe("lease-2");
    f.port.close.mockClear();
    f.port.status.mockClear();
    await expect(f.lifecycle.close(old)).rejects.toThrow("stays reserved");
    expect(await f.lifecycle.status(old)).toBe("unknown");
    expect(f.port.close).not.toHaveBeenCalled();
    expect(f.port.status).not.toHaveBeenCalled();
    expect(await f.route()).toEqual(replacement);
  });

  it("an unavailable owner keeps a possibly live reservation and starts nothing", async () => {
    const f = await setup();
    await Effect.runPromise(f.native.spawn(input));
    const route = (await f.route())!;
    f.port.close.mockRejectedValue(new Error("sshOwnerUnavailable"));
    f.port.status.mockRejectedValue(new Error("sshOwnerUnavailable"));
    const paneClose = settleHostedDirectShellPane(f.ctx, pane.threadId, pane.terminalId);
    expect((await Effect.runPromise(Effect.result(paneClose)))._tag).toBe("Failure");
    const thread = assertHostedDirectShellsReachable(f.ctx, pane.threadId, new Set());
    expect((await Effect.runPromise(Effect.result(thread)))._tag).toBe("Failure");
    expect(f.hosted()).toBeDefined();
    f.closeOwner();
    await expect(f.lifecycle.close(route)).rejects.toThrow("stays reserved");
    expect(await f.route()).toEqual(route);
    expect(f.port.prepareOpen).toHaveBeenCalledTimes(1);
    expect(f.port.open).toHaveBeenCalledTimes(1);
  });

  it("marks an unavailable exact lease without treating it as confirmed close", async () => {
    const f = await setup();
    await Effect.runPromise(f.native.spawn(input));
    const route = (await f.route())!;
    f.port.close.mockRejectedValueOnce(new NativeSshPtyHostLostError());
    await expect(f.lifecycle.close(route)).rejects.toThrow("stays reserved");
    expect(f.port.close).toHaveBeenCalledExactlyOnceWith(first, expect.any(AbortSignal));
    expect(await f.route()).toEqual({ ...route, state: "outcome-unknown" });
    await expect(f.lifecycle.close(route)).rejects.toThrow("stays reserved");
    expect(await f.lifecycle.status(route)).toBe("unknown");
    expect(f.port.close).toHaveBeenCalledOnce();
    expect(f.port.status).not.toHaveBeenCalled();
    await expect(
      Effect.runPromise(f.native.spawn({ ...input, replaceTerminalOwner: true })),
    ).rejects.toThrow("sshOwnerUnavailable");
    expect(f.port.prepareOpen).toHaveBeenCalledOnce();
    expect(f.port.open).toHaveBeenCalledOnce();
  });

  it("does not apply a delayed host-loss error to a different durable reservation", async () => {
    const f = await setup();
    await Effect.runPromise(f.native.spawn(input));
    const route = (await f.route())!;
    const started = Promise.withResolvers<void>();
    const lost = Promise.withResolvers<never>();
    f.port.status.mockImplementationOnce(() => {
      started.resolve();
      return lost.promise;
    });
    const pending = f.lifecycle.status(route);
    await started.promise;
    await f.lifecycle.close(route);
    // Install a different row at the storage boundary only; no second PTY is dispatched.
    const newer = await replace(f, (await f.route())!);
    lost.reject(new NativeSshPtyHostLostError());
    expect(await pending).toBe("unknown");
    expect(await f.route()).toEqual(newer);
    expect(f.port.open).toHaveBeenCalledOnce();
  });

  it("Forget past an unavailable owner drops the record but keeps the lease fence", async () => {
    const f = await setup();
    await Effect.runPromise(f.native.spawn(input));
    const route = (await f.route())!;
    f.port.status.mockRejectedValue(new Error("sshOwnerUnavailable"));
    expect(await Effect.runPromise(forgetHostedDirectShells(f.ctx, pane.threadId))).toBe(1);
    expect(f.hosted()).toBeUndefined();
    expect(f.port.close).not.toHaveBeenCalled();
    expect(await f.route()).toEqual(route);
    // The pane may only reattach to that exact lease; no new prepare or open.
    f.port.reattach.mockRejectedValueOnce(new Error("sshOwnerUnavailable"));
    expect((await Effect.runPromise(Effect.result(f.native.spawn(input))))._tag).toBe("Failure");
    expect(f.port.reattach).toHaveBeenLastCalledWith(first, expect.any(AbortSignal));
    expect(f.port.prepareOpen).toHaveBeenCalledTimes(1);
    expect(f.port.open).toHaveBeenCalledTimes(1);
  });

  it("pane close and thread deletion close the exact live lease once, then release", async () => {
    const f = await setup();
    await Effect.runPromise(f.native.spawn(input));
    await Effect.runPromise(settleHostedDirectShellPane(f.ctx, pane.threadId, pane.terminalId));
    expect(f.port.close).toHaveBeenCalledTimes(1);
    expect(f.port.close).toHaveBeenCalledWith(first, expect.any(AbortSignal));
    expect(await f.route()).toMatchObject({ resourceId: "lease-1", state: "terminal" });
    expect(f.hosted()).toBeUndefined();
  });
});
