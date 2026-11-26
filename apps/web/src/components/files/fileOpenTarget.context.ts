import type { ExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import { createContext, useContext } from "react";

/**
 * The execution target the surrounding surface's files live on (a thread's workspace in the chat
 * timeline, the active folder in the Files panel). File links, mentions and context menus inside
 * it open on that target, so a remote thread's links never open on this computer. `undefined`
 * outside any provider (the local default).
 */
export const FileOpenTargetContext = createContext<ExecutionTargetId | undefined>(undefined);

export function useFileOpenTarget(): ExecutionTargetId | undefined {
  return useContext(FileOpenTargetContext);
}
