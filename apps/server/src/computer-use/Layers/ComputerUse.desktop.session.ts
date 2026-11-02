import type { ComputerUseAction, ComputerUseResult, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import type { CuaDriverShape } from "../Services/CuaDriver.ts";
import type { ComputerUseError } from "../Services/ComputerUse.ts";
import { executeDesktopAction } from "./ComputerUse.desktop.actions.ts";
import { toError } from "./ComputerUse.desktop.results.ts";
import {
  createDesktopTargets,
  type DesktopInteraction,
} from "./ComputerUse.desktop.interaction.ts";

const DELIVERY_TOOLS = new Set(["click", "drag", "scroll", "type_text", "press_key", "hotkey"]);

// Legacy per-call session behavior is intentionally preserved. Persistent
// caller-bound native sessions belong to the dormant supervised integration.
export function executeDesktopSession(
  threadId: ThreadId,
  driver: CuaDriverShape,
  action: ComputerUseAction,
  interaction: DesktopInteraction = { deliveryMode: "background", targets: createDesktopTargets() },
): Effect.Effect<ComputerUseResult, ComputerUseError> {
  const session = `bigbud-${crypto.randomUUID()}`;
  const scopedDriver: CuaDriverShape = {
    ...driver,
    callTool: (name, args) =>
      driver.callTool(
        name,
        name === "start_session" || name === "end_session"
          ? args
          : {
              ...args,
              session,
              ...(DELIVERY_TOOLS.has(name) ? { delivery_mode: interaction.deliveryMode } : {}),
            },
      ),
  };
  return driver.withExclusiveAccess(
    Effect.sync(() => {
      if (interaction.deliveryMode === "foreground") interaction.targets.delete(threadId);
    }).pipe(
      Effect.andThen(
        scopedDriver.callTool("start_session", {
          session,
          capture_scope: interaction.deliveryMode === "background" ? "window" : "auto",
        }),
      ),
      Effect.mapError((cause) => toError(cause, "Failed to start desktop automation session.")),
      Effect.flatMap(() =>
        executeDesktopAction(threadId, scopedDriver, action, interaction).pipe(
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
      Effect.onExit((exit) =>
        exit._tag === "Failure"
          ? Effect.sync(() => interaction.targets.delete(threadId))
          : Effect.void,
      ),
    ),
  );
}
