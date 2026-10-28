import type { ComputerUseAction, ComputerUseResult, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import type { CuaDriverShape } from "../Services/CuaDriver.ts";
import { ComputerUseError } from "../Services/ComputerUse.ts";
import type { OpenShape } from "../../utils/open.ts";
import { executeDesktopSession } from "./ComputerUse.desktop.session.ts";

export const executeDesktopComputerUse = (
  threadId: ThreadId,
  driver: CuaDriverShape,
  action: ComputerUseAction,
  openBrowser?: OpenShape["openBrowser"],
): Effect.Effect<ComputerUseResult, ComputerUseError> => {
  if (action.action === "navigate") {
    if (!openBrowser) {
      return Effect.fail(
        new ComputerUseError({ message: "System browser navigation is unavailable." }),
      );
    }
    return openBrowser(action.url).pipe(
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
  return executeDesktopSession(threadId, driver, action);
};
