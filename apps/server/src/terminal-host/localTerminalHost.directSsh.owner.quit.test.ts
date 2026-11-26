import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { AppQuitIntentRecord } from "../lifecycle/AppQuitIntent.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { applyTerminalQuitPolicy } from "../terminal/Layers/Manager.quitPolicy.ts";
import { makeSshOwnerDevTerminal } from "../ssh/sshOwnerDevTerminal.ts";
import type { PtyAdapterShape } from "../terminal/Services/PTY.ts";
import {
  makeNativeDirectSshQuitCloser,
  nativeDirectSshQuitCloserFor,
} from "./localTerminalHost.directSsh.owner.quit.ts";
import {
  first,
  input,
  replace,
  runtime,
  setup,
  targetId,
  type PolicyFixture,
} from "./localTerminalHost.directSsh.owner.policy.testUtils.ts";

const quit = Option.some<AppQuitIntentRecord>({ sequence: 1, reason: "quit", occurredAt: 1 });

function quitWith(
  f: PolicyFixture,
  options: {
    readonly keep?: boolean;
    readonly owners?: () => RemoteAgentOwnerStore;
    readonly deadlineMs?: number;
  } = {},
) {
  const native = makeNativeDirectSshQuitCloser({
    targets: [targetId],
    owners: options.owners ?? (() => f.store),
    lifecycle: f.lifecycle,
  });
  return Effect.runPromise(
    applyTerminalQuitPolicy({
      resolveIntent: Effect.succeed(quit),
      keepRunningAfterQuit: () => options.keep === true,
      runtime: () => undefined,
      native,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    }),
  );
}

describe("default quit closes native direct SSH PTYs by exact lease only", () => {
  it("default quit closes the intended exact lease once and settles its row", async () => {
    const f = await setup();
    await Effect.runPromise(f.native.spawn(input));
    expect(await quitWith(f)).toEqual({ kind: "close", reason: "quit" });
    expect(f.port.close).toHaveBeenCalledTimes(1);
    expect(f.port.close).toHaveBeenCalledWith(first, expect.any(AbortSignal));
    expect(await f.route()).toMatchObject({ resourceId: first.leaseId, state: "terminal" });
  });

  it("a delayed quit skips a replacement recorded after its snapshot", async () => {
    const f = await setup();
    await Effect.runPromise(f.native.spawn(input));
    let replacement: Awaited<ReturnType<typeof replace>> | undefined;
    // The replacement lands between the snapshot and the per-lease recheck.
    const owners = (): RemoteAgentOwnerStore => ({
      ...f.store,
      listTerminalOwners: async (target, after, limit) => {
        const page = await f.store.listTerminalOwners!(target, after, limit);
        const old = (await f.route())!;
        await f.store.update(old.ownerKey, (row) => ({ ...row, state: "terminal" }), targetId);
        replacement = await replace(f, (await f.route())!);
        return page;
      },
    });
    await quitWith(f, { owners });
    expect(replacement?.resourceId).toBe("lease-2");
    expect(f.port.close).not.toHaveBeenCalled();
    expect(await f.route()).toEqual(replacement);
  });

  it("owner loss counts as unreachable and keeps the durable reservation", async () => {
    const f = await setup();
    await Effect.runPromise(f.native.spawn(input));
    const route = await f.route();
    f.port.close.mockRejectedValue(new Error("sshOwnerUnavailable"));
    const native = makeNativeDirectSshQuitCloser({
      targets: [targetId],
      owners: () => f.store,
      lifecycle: f.lifecycle,
    });
    expect(await native.closeAll({ reason: "quit", managedOnly: true })).toEqual({
      closed: 0,
      unreachable: 1,
    });
    await quitWith(f);
    expect(f.port.close).toHaveBeenCalledTimes(2);
    expect(await f.route()).toEqual(route);
    expect(f.port.prepareOpen).toHaveBeenCalledTimes(1);
    expect(f.port.open).toHaveBeenCalledTimes(1);
    expect(f.port.reattach).not.toHaveBeenCalled();
  });

  it("a close still pending at the quit deadline returns and keeps the reservation", async () => {
    const f = await setup();
    await Effect.runPromise(f.native.spawn(input));
    const route = await f.route();
    let receive: ((state: "exited") => void) | undefined;
    let closeSignal: AbortSignal | undefined;
    f.port.close.mockImplementationOnce(
      (binding, signal) =>
        new Promise((resolve) => {
          closeSignal = signal;
          receive = (state) => resolve({ binding, state });
        }),
    );
    const started = Date.now();
    expect(await quitWith(f, { deadlineMs: 150 })).toEqual({ kind: "close", reason: "quit" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(f.port.close).toHaveBeenCalledTimes(1);
    expect(f.port.close).toHaveBeenCalledWith(first, expect.any(AbortSignal));
    expect(closeSignal?.aborted).toBe(true);
    expect(await f.route()).toEqual(route);
    // A receipt that arrives after the deadline is not confirmation for this quit.
    receive?.("exited");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await f.route()).toEqual(route);
    expect(f.port.close).toHaveBeenCalledTimes(1);
    expect(f.port.status).not.toHaveBeenCalled();
    expect(f.port.reattach).not.toHaveBeenCalled();
    expect(f.port.prepareOpen).toHaveBeenCalledTimes(1);
    expect(f.port.open).toHaveBeenCalledTimes(1);
  });

  it("a hintless stop never invokes native close", async () => {
    const f = await setup();
    await Effect.runPromise(f.native.spawn(input));
    const route = await f.route();
    const native = makeNativeDirectSshQuitCloser({
      targets: [targetId],
      owners: () => f.store,
      lifecycle: f.lifecycle,
    });
    const hintless = await Effect.runPromise(
      applyTerminalQuitPolicy({
        resolveIntent: undefined,
        keepRunningAfterQuit: () => false,
        runtime: () => undefined,
        native,
      }),
    );
    expect(hintless).toEqual({ kind: "detach", why: "no-hint" });
    expect(f.port.close).not.toHaveBeenCalled();
    expect(f.port.status).not.toHaveBeenCalled();
    expect(await f.route()).toEqual(route);
  });

  it("keep mode still closes native SSH terminals on a quit (user decision)", async () => {
    const f = await setup();
    await Effect.runPromise(f.native.spawn(input));
    // Other hosts keep their terminals; native SSH closes its exact lease regardless.
    expect(await quitWith(f, { keep: true })).toEqual({ kind: "detach", why: "keep" });
    expect(f.port.close).toHaveBeenCalledTimes(1);
    expect(f.port.close).toHaveBeenCalledWith(first, expect.any(AbortSignal));
    expect(await f.route()).toMatchObject({ resourceId: first.leaseId, state: "terminal" });
  });

  it("only the dev-wrapped adapter carries the native closer to the manager", async () => {
    const f = await setup();
    const dev = makeSshOwnerDevTerminal({
      targetId,
      workspaceRoot: "/srv/work",
      withOwner: async () => {
        throw new Error("no owner traffic expected");
      },
      owners: () => f.store,
      runtime,
    });
    const original = { spawn: () => Effect.die("unused") } as unknown as PtyAdapterShape;
    const wrapped = dev.wrapPtyAdapter(original);
    expect(nativeDirectSshQuitCloserFor(wrapped)).toBe(dev.quitCloser);
    expect(nativeDirectSshQuitCloserFor(original)).toBeUndefined();
  });
});
