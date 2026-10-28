import type { ComputerUseAction, ComputerUseResult, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import type { CuaDriverShape } from "../Services/CuaDriver.ts";
import type { ComputerUseError } from "../Services/ComputerUse.ts";
import { executeDesktopAction } from "./ComputerUse.desktop.actions.ts";
import { toError } from "./ComputerUse.desktop.results.ts";

// Legacy per-call session behavior is intentionally preserved. Persistent
// caller-bound native sessions belong to the dormant supervised integration.
export function executeDesktopSession(
  threadId: ThreadId,
  driver: CuaDriverShape,
  action: ComputerUseAction,
): Effect.Effect<ComputerUseResult, ComputerUseError> {
  const session = `bigbud-${crypto.randomUUID()}`;
  const scopedDriver: CuaDriverShape = {
    ...driver,
    callTool: (name, args) =>
      driver.callTool(
        name,
        name === "start_session" || name === "end_session" ? args : { ...args, session },
      ),
  };
  return driver.withExclusiveAccess(
    scopedDriver.callTool("start_session", { session, capture_scope: "auto" }).pipe(
      Effect.mapError((cause) => toError(cause, "Failed to start desktop automation session.")),
      Effect.flatMap(() =>
        executeDesktopAction(threadId, scopedDriver, action).pipe(
          Effect.onExit(() =>
            driver.callTool("end_session", { session }).pipe(
              Effect.asVoid,
              Effect.mapError((cause) =>
                toError(cause, "Failed to end desktop automation session."),
              ),
              Effect.catch((cause) => driver.resetProxy.pipe(Effect.andThen(Effect.fail(cause)))),
            ),
          ),
        ),
      ),
    ),
  );
}
