import type { ComputerUseAction, ComputerUseResult, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import type { CuaDriverShape } from "../Services/CuaDriver.ts";
import { ComputerUseError } from "../Services/ComputerUse.ts";
import type { OpenShape } from "../../utils/open.ts";
import { executeDesktopSession } from "./ComputerUse.desktop.session.ts";
import {
  backgroundUnavailable,
  createDesktopTargets,
  type DesktopInteraction,
} from "./ComputerUse.desktop.interaction.ts";

export const executeDesktopComputerUse = (
  threadId: ThreadId,
  driver: CuaDriverShape,
  action: ComputerUseAction,
  openBrowser?: OpenShape["openBrowser"],
  interaction: DesktopInteraction = { deliveryMode: "background", targets: createDesktopTargets() },
): Effect.Effect<ComputerUseResult, ComputerUseError> => {
  if (action.action === "navigate") {
    if (interaction.deliveryMode === "background") {
      return Effect.fail(
        backgroundUnavailable(
          "Opening the system browser can change focus. Use the in-app browser surface for background navigation.",
        ),
      );
    }
    if (!openBrowser) {
      return Effect.fail(
        new ComputerUseError({ message: "System browser navigation is unavailable." }),
      );
    }
    return Effect.sync(() => interaction.targets.delete(threadId)).pipe(
      Effect.andThen(openBrowser(action.url)),
      Effect.mapError(
        (cause) =>
          new ComputerUseError({
            message: `Failed to open the system default browser: ${cause.message}`,
          }),
      ),
      Effect.as({
        surface: "desktop",
        action: action.action,
        summary: `Opened ${action.url} in the system default browser. Browser control has not been confirmed.`,
      } satisfies ComputerUseResult),
    );
  }
  return executeDesktopSession(threadId, driver, action, interaction);
};
