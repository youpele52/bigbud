import { TerminalSessionLookupError } from "@bigbud/contracts/workspace/terminal.ts";
import { wslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { makeListTerminalShellProfiles } from "./Manager.shell.inventory";
import { createTerminalSessionState } from "./Manager.session.state";
import { host, profile, target } from "./Manager.shell.remote.test.helpers";
import { remoteShellHost } from "./ShellProfiles.remote.identity";
import { LOCAL_SHELL_HOST } from "./ShellProfiles.identity";
import { ShellProfileDiscoveryError, type ShellProfileInventory } from "../Services/ShellProfiles";

const ids = { threadId: "thread", terminalId: "pane" };
function fixture(executionTargetId = target) {
  const session = createTerminalSessionState({
    ...ids,
    executionTargetId,
    dropPathMode: "posix",
    cwd: "/work",
    worktreePath: null,
    history: "retained history",
    cols: 80,
    rows: 24,
    runtimeEnv: null,
  });
  let locked = false;
  const inventory = vi.fn((): Effect.Effect<ShellProfileInventory, ShellProfileDiscoveryError> => {
    expect(locked).toBe(true);
    return Effect.succeed({ host, profiles: [profile] });
  });
  const requireSession = vi.fn(() => {
    expect(locked).toBe(true);
    return Effect.succeed(session);
  });
  const list = makeListTerminalShellProfiles({
    requireSession,
    listShellProfiles: inventory,
    withThreadLock: (_thread, operation) =>
      Effect.suspend(() => {
        locked = true;
        return operation.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              locked = false;
            }),
          ),
        );
      }),
  });
  return { session, list, inventory, requireSession };
}

describe("Manager retained-pane shell inventory", () => {
  it("derives only retained target under lock and does not mutate terminal state", async () => {
    const { session, list, inventory, requireSession } = fixture();
    const before = structuredClone(session);
    const input = {
      ...ids,
      executionTargetId: "ssh:host=attacker&user=other",
      executable: "/untrusted",
    };
    expect(await Effect.runPromise(list(input))).toEqual({
      host,
      profiles: [profile],
      runtimeGeneration: session.runtimeGeneration,
      exactProfileLaunchesEnabled: true,
    });
    expect(requireSession).toHaveBeenCalledWith(ids.threadId, ids.terminalId);
    expect(inventory).toHaveBeenCalledWith({ executionTargetId: target });
    expect(session).toEqual(before);
  });

  it("passes pinned WSL account rather than current distribution defaults", async () => {
    const { session, inventory, list } = fixture(wslTerminalTargetId("Ubuntu"));
    session.wslIdentity = { distribution: "Ubuntu", username: "pinned", uid: 1001 };
    const pinnedHost = remoteShellHost({
      executionTargetId: session.executionTargetId,
      wslIdentity: session.wslIdentity,
    });
    inventory.mockImplementation(() => Effect.succeed({ host: pinnedHost, profiles: [] }));
    expect(await Effect.runPromise(list(ids))).toMatchObject({
      host: pinnedHost,
      profiles: [],
      exactProfileLaunchesEnabled: false,
    });
    expect(inventory).toHaveBeenCalledWith({
      executionTargetId: session.executionTargetId,
      wslIdentity: session.wslIdentity,
    });
  });

  it("declares direct SSH disabled even when discovery advertises profiles", async () => {
    const direct = target.replace("transport=agent", "transport=direct-ssh");
    const { session, inventory, list } = fixture(direct);
    const directHost = remoteShellHost({ executionTargetId: direct });
    inventory.mockImplementation(() =>
      Effect.succeed({ host: directHost, profiles: [], exactProfileLaunchesEnabled: true }),
    );
    expect(await Effect.runPromise(list(ids))).toMatchObject({
      exactProfileLaunchesEnabled: false,
      runtimeGeneration: session.runtimeGeneration,
    });
  });

  it("supports retained local inventory", async () => {
    const { inventory, list } = fixture("local");
    inventory.mockImplementation(() => Effect.succeed({ host: LOCAL_SHELL_HOST, profiles: [] }));
    expect(await Effect.runPromise(list(ids))).toMatchObject({
      host: LOCAL_SHELL_HOST,
      profiles: [],
      exactProfileLaunchesEnabled: true,
    });
  });

  for (const [name, result] of [
    ["over limit", { host, profiles: Array.from({ length: 65 }, () => profile) }],
    ["duplicate IDs", { host, profiles: [profile, profile] }],
    ["profile host mismatch", { host, profiles: [{ ...profile, host: LOCAL_SHELL_HOST }] }],
    ["retained host mismatch", { host: LOCAL_SHELL_HOST, profiles: [] }],
  ] as const) {
    it(`rejects whole-frame ${name} before returning inventory`, async () => {
      const { inventory, list } = fixture();
      inventory.mockImplementation(() => Effect.succeed(result));
      const failure = await Effect.runPromise(list(ids).pipe(Effect.result));
      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure")
        expect(failure.failure._tag).toBe("TerminalExecutionTargetError");
    });
  }

  it("normalizes discovery failure to a visible target error", async () => {
    const { inventory, list } = fixture();
    inventory.mockImplementation(() =>
      Effect.fail(new ShellProfileDiscoveryError({ reason: "timed-out" })),
    );
    const failure = await Effect.runPromise(list(ids).pipe(Effect.result));
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure")
      expect(failure.failure._tag).toBe("TerminalExecutionTargetError");
  });

  it("reports unavailable callback without making it mandatory for legacy fixtures", async () => {
    const { session } = fixture();
    const list = makeListTerminalShellProfiles({
      requireSession: () => Effect.succeed(session),
      withThreadLock: (_thread, operation) => operation,
    });
    const failure = await Effect.runPromise(list(ids).pipe(Effect.result));
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure")
      expect(failure.failure._tag).toBe("TerminalExecutionTargetError");
  });

  it("requires an existing pane before invoking inventory", async () => {
    const inventory = vi.fn(() => Effect.succeed({ host, profiles: [] }));
    const list = makeListTerminalShellProfiles({
      requireSession: () => Effect.fail(new TerminalSessionLookupError(ids)),
      withThreadLock: (_thread, operation) => operation,
      listShellProfiles: inventory,
    });
    const result = await Effect.runPromise(list(ids).pipe(Effect.result));
    expect(result._tag).toBe("Failure");
    expect(inventory).not.toHaveBeenCalled();
  });
});
