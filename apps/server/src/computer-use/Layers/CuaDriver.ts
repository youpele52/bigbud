import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { Effect, Layer, Semaphore } from "effect";
import { makeCuaDriverChildEnvironment } from "@bigbud/shared/cua-driver/childEnvironment";
import {
  cuaDriverEmbeddedEnvironment,
  cuaDriverMcpArguments,
} from "@bigbud/shared/cua-driver/invocation";
import { CUA_DRIVER_REQUIRED_TOOLS } from "@bigbud/shared/cua-driver/policy";

import {
  CuaDriver,
  CuaDriverError,
  type CuaDriverCallResult,
  type CuaDriverShape,
} from "../Services/CuaDriver.ts";
import { parseAvailableTools, toCallResult } from "./CuaDriver.results.ts";
import { requestResponse, stderrTails, writeMessage } from "./CuaDriver.framing.ts";
import { makeCuaDriverCallQueue } from "./CuaDriver.queue.ts";
import { resetCuaDriverDaemon } from "./CuaDriver.reset.ts";
import {
  COMPUTER_USE_STOPPED_BY_USER_MESSAGE,
  ComputerUseAdmission,
} from "../computerUseAdmission.ts";
import {
  formatCuaDriverHealthReport,
  requireCuaDriverEmbeddedHostBundleId,
  type CuaDriverSession,
} from "./CuaDriver.runtime.ts";

const JSONRPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const CUA_DRIVER_STDERR_TAIL_BYTES = 4 * 1024;
const MUTATING_TOOLS = new Set([
  "launch_app",
  "bring_to_front",
  "click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
]);

function resolveCuaDriverCommand(): string {
  return process.env.BIGBUD_CUA_DRIVER_PATH?.trim() || "cua-driver";
}

function toDriverError(cause: unknown, fallback: string): CuaDriverError {
  if (cause instanceof CuaDriverError) {
    return cause;
  }
  if (cause instanceof Error) {
    return new CuaDriverError({ message: cause.message, cause });
  }
  return new CuaDriverError({ message: fallback, cause });
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.removeAllListeners();
  child.stdin.removeAllListeners();
  child.stdout.removeAllListeners();
  child.stderr.removeAllListeners();
  child.kill("SIGTERM");
}

function cuaDriverSocketPath(): string | undefined {
  return process.env.BIGBUD_CUA_ENDPOINT?.trim() ?? process.env.BIGBUD_CUA_DRIVER_SOCKET?.trim();
}

async function createSession(): Promise<CuaDriverSession> {
  const socketPath = cuaDriverSocketPath();
  const hostBundleId = socketPath ? requireCuaDriverEmbeddedHostBundleId(process.env) : undefined;
  const child = spawn(
    resolveCuaDriverCommand(),
    socketPath ? [...cuaDriverMcpArguments(socketPath, hostBundleId!)] : ["mcp"],
    {
      env: makeCuaDriverChildEnvironment(
        process.env,
        socketPath ? cuaDriverEmbeddedEnvironment(socketPath, hostBundleId!) : {},
      ),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    },
  );
  stderrTails.set(child, "");
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrTails.set(
      child,
      `${stderrTails.get(child) ?? ""}${chunk.toString()}`.slice(-CUA_DRIVER_STDERR_TAIL_BYTES),
    );
  });
  try {
    await requestResponse(child, 1, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "bigbud", version: "1.0.0" },
    });
    await writeMessage(child, {
      jsonrpc: JSONRPC_VERSION,
      method: "notifications/initialized",
    });
    const availableTools = parseAvailableTools(await requestResponse(child, 2, "tools/list"));
    const missingTools = CUA_DRIVER_REQUIRED_TOOLS.filter((name) => !availableTools.has(name));
    if (missingTools.length > 0) {
      throw new Error(`cua-driver is missing required tools: ${missingTools.join(", ")}.`);
    }
    return { child, availableTools, nextId: 3 };
  } catch (error) {
    stopChild(child);
    throw error;
  }
}

function isSessionAlive(session: CuaDriverSession | null): session is CuaDriverSession {
  return session !== null && session.child.exitCode === null && session.child.signalCode === null;
}

/** A session created for halted work is never used: its child is stopped once it exists. */
async function createSessionFor(
  calls: ReturnType<typeof makeCuaDriverCallQueue>,
  isCurrent: () => boolean,
): Promise<CuaDriverSession> {
  const pending = createSession();
  try {
    const created = await calls.abortable(pending);
    if (!isCurrent()) throw new Error(COMPUTER_USE_STOPPED_BY_USER_MESSAGE);
    return created;
  } catch (error) {
    void pending.then(
      (created) => stopChild(created.child),
      () => undefined,
    );
    throw error;
  }
}

const STOP_RESET_FAILED_MESSAGE =
  "The desktop driver did not come back after Stop. bigbud keeps restarting it, and computer use works again once it is back.";

/** Fails an action admitted before a user Stop, before it reaches the driver. */
const requireCurrentAdmission = Effect.gen(function* () {
  const admission = yield* ComputerUseAdmission;
  if (!admission.isCurrent()) {
    return yield* new CuaDriverError({ message: COMPUTER_USE_STOPPED_BY_USER_MESSAGE });
  }
  return admission;
});

export function makeCuaDriver(): CuaDriverShape {
  let session: CuaDriverSession | null = null;
  let unavailableReason: string | null = null;
  let daemonReset: Promise<void> | null = null;
  let stopInFlight: Promise<void> | null = null;
  const calls = makeCuaDriverCallQueue();
  const operationSemaphore = Effect.runSync(Semaphore.make(1));

  async function callToolViaSession(
    name: string,
    args: Record<string, unknown>,
    isCurrent: () => boolean,
  ): Promise<CuaDriverCallResult> {
    if (unavailableReason) throw new Error(unavailableReason);
    if (!isSessionAlive(session)) {
      session = await createSessionFor(calls, isCurrent);
    }
    if (!session.availableTools.has(name)) {
      throw new Error(`cua-driver did not advertise tool '${name}'.`);
    }
    if (!isCurrent()) throw new Error(COMPUTER_USE_STOPPED_BY_USER_MESSAGE);
    const id = session.nextId;
    session.nextId += 1;
    try {
      const result = await calls.abortable(
        requestResponse(session.child, id, "tools/call", { name, arguments: args }),
      );
      return toCallResult(result);
    } catch (error) {
      if (isSessionAlive(session)) {
        stopChild(session.child);
      }
      session = null;
      if (
        MUTATING_TOOLS.has(name) &&
        error instanceof Error &&
        error.message.includes("timed out")
      ) {
        await resetDaemonAfterUncertainAction(`Tool '${name}' timed out.`);
      }
      throw error;
    }
  }

  function resetProxy(): void {
    if (isSessionAlive(session)) stopChild(session.child);
    session = null;
  }

  /** Concurrent resets (an interrupted tool and a user Stop) share one daemon restart. */
  function resetDaemonAfterUncertainAction(reason: string): Promise<void> {
    daemonReset ??= resetDaemonOnce(reason).finally(() => {
      daemonReset = null;
    });
    return daemonReset;
  }

  /**
   * A Stop has already halted all input, so a daemon that does not come back in time must not
   * block later work: unlike an uncertain action, it leaves `unavailableReason` alone, and calls
   * work again as soon as the desktop supervisor has the daemon back.
   */
  function resetDaemonAfterStop(socketPath: string, reason: string): Promise<void> {
    daemonReset ??= (async () => {
      resetProxy();
      try {
        await resetCuaDriverDaemon({ command: resolveCuaDriverCommand(), socketPath, reason });
        unavailableReason = null;
      } catch (cause) {
        throw new Error(STOP_RESET_FAILED_MESSAGE, { cause });
      }
    })().finally(() => {
      daemonReset = null;
    });
    return daemonReset;
  }

  async function resetDaemonOnce(reason: string): Promise<void> {
    resetProxy();
    const socketPath = cuaDriverSocketPath();
    if (!socketPath) {
      unavailableReason = `Computer Use is unavailable after an uncertain action: ${reason}`;
      throw new Error(unavailableReason);
    }
    try {
      await resetCuaDriverDaemon({
        command: resolveCuaDriverCommand(),
        socketPath,
        reason,
      });
      unavailableReason = null;
    } catch (error) {
      unavailableReason = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /**
   * User Stop: nothing queued before it reaches the driver, the call in flight settles now, and
   * the proxy dies at once. A socket daemon is then restarted under the queue, so later work
   * never talks to a daemon mid-restart; without a socket the killed stdio proxy was the driver.
   */
  function stopAllActivity(reason: string): Promise<"reset" | "idle"> {
    calls.halt(new Error(COMPUTER_USE_STOPPED_BY_USER_MESSAGE));
    const socketPath = cuaDriverSocketPath();
    const hadProxy = isSessionAlive(session);
    resetProxy();
    // Without a daemon socket the stdio proxy was the driver: killing it stopped all input.
    if (!socketPath) return Promise.resolve(hadProxy ? "reset" : "idle");
    // A second Stop while this one waits must not cancel the restart it is waiting for.
    stopInFlight ??= calls
      .enqueue(() => resetDaemonAfterStop(socketPath, reason), { survivesHalt: true })
      .finally(() => {
        stopInFlight = null;
      });
    return stopInFlight.then(() => "reset" as const);
  }

  const resetAfterUncertainAction = (reason: string) =>
    Effect.tryPromise({
      try: () => resetDaemonAfterUncertainAction(reason),
      catch: (cause) =>
        toDriverError(cause, "Failed to reset Computer Use after an uncertain action."),
    });

  return {
    callTool: (name, args) =>
      Effect.flatMap(requireCurrentAdmission, (admission) =>
        Effect.callback<CuaDriverCallResult, CuaDriverError>((resume) => {
          let active = true;
          void calls
            .enqueue((isCurrent) =>
              callToolViaSession(name, args, () => isCurrent() && admission.isCurrent()),
            )
            .then(
              (result) => {
                if (active) resume(Effect.succeed(result));
              },
              (cause) => {
                if (active) {
                  resume(
                    Effect.fail(toDriverError(cause, `Failed to call cua-driver tool '${name}'.`)),
                  );
                }
              },
            );
          return Effect.sync(() => {
            active = false;
          }).pipe(
            Effect.andThen(
              MUTATING_TOOLS.has(name)
                ? resetAfterUncertainAction(`Tool '${name}' was interrupted.`).pipe(Effect.ignore)
                : Effect.sync(resetProxy),
            ),
          );
        }),
      ),
    // Every call inside the exclusive lock re-checks the admission, so an action that waited
    // through a Stop fails at its first driver call (`start_session`) instead of starting.
    runDoctor: () =>
      Effect.andThen(requireCurrentAdmission, () =>
        Effect.tryPromise({
          try: () =>
            calls.enqueue(async (isCurrent) =>
              formatCuaDriverHealthReport(await callToolViaSession("health_report", {}, isCurrent)),
            ),
          catch: (cause) => toDriverError(cause, "Failed to read cua-driver health."),
        }),
      ),
    withExclusiveAccess: (effect) => operationSemaphore.withPermit(effect),
    resetProxy: Effect.sync(resetProxy),
    resetAfterUncertainAction,
    stopAllActivity: (reason) =>
      Effect.tryPromise({
        try: () => stopAllActivity(reason),
        catch: (cause) => toDriverError(cause, STOP_RESET_FAILED_MESSAGE),
      }),
    dispose: Effect.sync(() => {
      resetProxy();
    }),
  };
}

export const CuaDriverLive = Layer.succeed(CuaDriver, makeCuaDriver());
