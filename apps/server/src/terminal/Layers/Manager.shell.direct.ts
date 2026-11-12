import {
  assertDirectShellProfileEnabled,
  directShellLaunchUnavailable,
} from "./Manager.shell.direct.policy";
import { homedir } from "node:os";
import * as Effect from "effect/Effect";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { PtySpawnError, type PtyAdapterShape, type PtyProcess } from "../Services/PTY";
import { makeDirectShellLaunchDispatcher } from "./DirectShellLaunch.dispatch";
import { directShellOwnerKey, type DirectShellLaunchOwnerStore } from "./DirectShellLaunch.owner";
import { directShellProfileInvocation } from "./ShellProfiles.remote.launch";
import type { ResolvedShellProfileLaunch } from "./ShellProfiles.launch";
import type { TerminalSessionState } from "./Manager.types";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { isRemoteAgentExecutionTarget } from "../../remote-agent/remoteAgentDefault.ts";
import type { TerminalWslIdentity } from "@bigbud/contracts/workspace/terminal.wsl.ts";

export const preflightDirectShellLaunch = Effect.fn("terminal.preflightDirectShellLaunch")(
  function* (
    store: DirectShellLaunchOwnerStore | undefined,
    input: {
      threadId: string;
      terminalId: string;
      executionTargetId: string;
      cwd: string;
      wslIdentity?: TerminalWslIdentity | undefined;
      launch: ResolvedShellProfileLaunch | null;
    },
  ) {
    yield* assertDirectShellLaunchAvailable(store, input);
    if (
      !input.launch ||
      isLocalExecutionTarget(input.executionTargetId) ||
      isRemoteAgentExecutionTarget(input.executionTargetId)
    )
      return;
    yield* Effect.try({
      try: () => {
        assertDirectShellProfileEnabled();
        return directShellProfileInvocation({
          executionTargetId: input.executionTargetId,
          ...(input.wslIdentity ? { wslIdentity: input.wslIdentity } : {}),
          cwd: input.cwd,
          launch: input.launch!,
        });
      },
      catch: (cause) =>
        new TerminalExecutionTargetError({
          threadId: input.threadId,
          terminalId: input.terminalId,
          executionTargetId: input.executionTargetId,
          detail: `${directShellLaunchUnavailable} No replacement was started.`,
          cause,
        }),
    });
  },
);

/** Applies even to legacy/local requests: changing a target cannot bypass a retained owner. */
export const assertDirectShellLaunchAvailable = Effect.fn("terminal.assertDirectLaunchAvailable")(
  function* (
    store: DirectShellLaunchOwnerStore | undefined,
    input: {
      threadId: string;
      terminalId: string;
      executionTargetId: string;
      recoverPrepared?: boolean;
    },
  ) {
    if (!store) return;
    yield* Effect.tryPromise({
      try: async () => {
        const owner = await store.get(directShellOwnerKey(input.threadId, input.terminalId));
        if (!owner) return;
        // Only explicit replacement may cancel an undispatched reservation. The CAS
        // competes with claimDispatch: whichever wins prevents the other action.
        // No controller-death guess or execution-host termination evidence is needed.
        if (
          input.recoverPrepared &&
          owner.state === "prepared" &&
          (await store.cancelPrepared(owner.ownerKey, owner.reservationId, owner.controllerId))
        )
          return;
        throw new Error(
          owner.state === "prepared"
            ? "This pane retains a direct shell reservation. Confirm an explicit replacement to attempt cancellation before dispatch. If dispatch has already claimed it, ownership remains fenced. No replacement was started."
            : "This pane retains an unconfirmed direct shell owner. The execution-host process may still be running. Transport exit does not prove shell termination; automatic retry, reattach, and replacement are unavailable. No replacement was started. Ownership is retained until execution-host termination can be verified.",
        );
      },
      catch: (cause) =>
        new TerminalExecutionTargetError({
          threadId: input.threadId,
          terminalId: input.terminalId,
          executionTargetId: input.executionTargetId,
          detail: cause instanceof Error ? cause.message : "Direct shell ownership is unavailable.",
        }),
    });
  },
);

/** No attach semantics are invented for SSH/WSL. An existing reservation always refuses create. */
export const spawnDirectShellProfile = Effect.fn("terminal.spawnDirectShellProfile")(function* (
  adapter: PtyAdapterShape,
  store: DirectShellLaunchOwnerStore | undefined,
  session: TerminalSessionState,
  launch: ResolvedShellProfileLaunch,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<PtyProcess, PtySpawnError> {
  const run = Effect.runPromiseWith(yield* Effect.services<never>());
  return yield* Effect.tryPromise({
    try: async () => {
      assertDirectShellProfileEnabled();
      if (!store) throw new Error("Durable direct shell ownership is unavailable.");
      const plan = directShellProfileInvocation({
        executionTargetId: session.executionTargetId,
        ...(session.wslIdentity ? { wslIdentity: session.wslIdentity } : {}),
        cwd: session.cwd,
        launch,
        runtimeEnv: env,
      });
      let process: PtyProcess | undefined;
      const dispatch = makeDirectShellLaunchDispatcher({
        store,
        transport: async (storedPlan) => {
          process = await run(
            adapter.spawn({
              shell: storedPlan.invocation.command,
              args: [...storedPlan.invocation.args],
              cwd: homedir(),
              cols: session.cols,
              rows: session.rows,
              env,
            }),
          );
        },
      });
      const result = await dispatch({
        threadId: session.threadId,
        terminalId: session.terminalId,
        intent: {
          executionTargetId: session.executionTargetId,
          ...(session.wslIdentity ? { wslIdentity: session.wslIdentity } : {}),
          launch: plan.launch,
        },
        runtimeEnv: env,
        runtimeGeneration: session.runtimeGeneration,
      });
      if (result.action !== "dispatched" || !process)
        throw new Error("Direct shell ownership is retained; no duplicate process was created.");
      // Preserve adapter receiver semantics and optional flow control; never claim actual identity.
      const spawned = process;
      return {
        pid: spawned.pid,
        shellUnconfirmedLaunch: result.shellUnconfirmedLaunch,
        launchStatus: "unconfirmed" as const,
        write: (data: string) => spawned.write(data),
        resize: (cols: number, rows: number) => spawned.resize(cols, rows),
        kill: (signal?: string) => spawned.kill(signal),
        onData: (callback) => spawned.onData(callback),
        onExit: (callback) => spawned.onExit(callback),
        ...(spawned.onError ? { onError: spawned.onError.bind(spawned) } : {}),
        ...(spawned.pause ? { pause: spawned.pause.bind(spawned) } : {}),
        ...(spawned.resume ? { resume: spawned.resume.bind(spawned) } : {}),
        prepareRestart: async () => {
          throw new Error("Direct shell termination is unconfirmed; ownership cannot be released.");
        },
      } satisfies PtyProcess;
    },
    catch: (cause) =>
      new PtySpawnError({
        adapter: "direct-shell-profile",
        message: cause instanceof Error ? cause.message : "Direct shell dispatch failed.",
        cause,
      }),
  });
});
