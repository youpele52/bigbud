import type {
  ChatAttachment,
  ModelSelection,
  OrchestrationSession,
  OrchestrationThread,
  ThreadId,
} from "@bigbud/contracts";
import { Effect } from "effect";

import type { CapabilityCatalog } from "../../capabilities/CapabilityCatalog.ts";
import type { GitCoreShape } from "../../git/Services/GitCore.ts";
import type { GitStatusBroadcasterShape } from "../../git/Services/GitStatusBroadcaster.ts";
import type { TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { ServerConfigShape } from "../../startup/config.ts";
import type { ServerSettingsShape } from "../../ws/serverSettings.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import type { ProviderCapabilityContextState } from "./ProviderCommandReactorSessionOps.capabilityContext.ts";

export interface SessionOpServices {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerService: ProviderServiceShape;
  readonly git: GitCoreShape;
  readonly gitStatusBroadcaster: GitStatusBroadcasterShape;
  readonly textGeneration: TextGenerationShape;
  readonly serverSettingsService: ServerSettingsShape;
  readonly serverConfig: ServerConfigShape;
  readonly threadModelSelections: Map<string, ModelSelection>;
  readonly capabilityContextStates: Map<string, ProviderCapabilityContextState>;
  readonly setThreadSession: (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) => Effect.Effect<void, OrchestrationDispatchError>;
  readonly assertRuntimeStartAllowed: (
    threadId: ThreadId,
  ) => Effect.Effect<void, OrchestrationDispatchError>;
  readonly resolveThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
}

export type SendTurnForThreadInput = {
  readonly threadId: ThreadId;
  readonly messageText: string;
  readonly providerInputText?: string;
  readonly capabilityCatalog?: CapabilityCatalog;
  readonly memoryContext?: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly modelSelection?: ModelSelection;
  readonly interactionMode?: "default" | "plan";
  readonly bootstrapSourceThreadId?: ThreadId;
  readonly createdAt: string;
};
