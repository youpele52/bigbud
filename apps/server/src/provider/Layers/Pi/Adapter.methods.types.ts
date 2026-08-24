import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";

import type { ServerSettingsShape } from "../../../ws/serverSettings.ts";
import type {
  ActivePiSession,
  PiEmitEvents,
  PiProcessExitHandler,
  PiRunPromise,
  PiStdoutEventHandler,
  PiSyntheticEventFn,
} from "./Adapter.types.ts";

export interface PiAdapterMethodDependencies {
  readonly attachmentsDir: string;
  readonly stateDir: string;
  readonly host: string | undefined;
  readonly port: number;
  readonly emit: PiEmitEvents;
  readonly handleProcessExit: PiProcessExitHandler;
  readonly handleStdoutEvent: PiStdoutEventHandler;
  readonly makeSyntheticEvent: PiSyntheticEventFn;
  readonly runPromise: PiRunPromise;
  readonly serverSettings: Pick<ServerSettingsShape, "getSettings">;
  readonly sessions: Map<ThreadId, ActivePiSession>;
}
