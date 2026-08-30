import type { Options as ClaudeQueryOptions, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventId, ProviderSessionStartInput, ThreadId } from "@bigbud/contracts";
import type { Effect, FileSystem } from "effect";

import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";
import type { ProviderAdapterError } from "../../Errors.ts";
import type {
  ClaudeHarnessConfig,
  ClaudeQueryRuntime,
  ClaudeSessionContext,
} from "./Adapter.types.ts";
import type { OfferClaudeRuntimeEvent } from "./Adapter.events.ts";
import type { StreamHandlers } from "./Adapter.stream.ts";
import type { RemoteWorkspaceReadinessProbe } from "../../../remote-workspace-bridge/remoteWorkspaceReadiness.ts";

export interface SessionStartDeps {
  readonly remoteWorkspaceReadinessProbe?: RemoteWorkspaceReadinessProbe;
  readonly fileSystem: FileSystem.FileSystem;
  readonly serverConfig: {
    readonly attachmentsDir: string;
    readonly stateDir: string;
    readonly port: number;
    readonly host: string | undefined;
  };
  readonly serverSettingsService: {
    readonly getSettings: Effect.Effect<
      {
        readonly providers: {
          readonly claudeAgent: {
            readonly binaryPath: string;
            readonly rollout: {
              readonly modernTaskExposure: boolean;
              readonly boundedHookProgress: boolean;
              readonly forwardedSubagentText: boolean;
              readonly mcpControls: boolean;
            };
          };
        };
      },
      Error
    >;
  };
  readonly harness?: ClaudeHarnessConfig;
  readonly resolveHarness?: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ClaudeHarnessConfig, ProviderAdapterError>;
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly createQuery: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly sessions: Map<ThreadId, ClaudeSessionContext>;
  readonly makeEventStamp: () => Effect.Effect<{ eventId: EventId; createdAt: string }>;
  readonly offerRuntimeEvent: OfferClaudeRuntimeEvent;
  readonly nowIso: Effect.Effect<string>;
  readonly streamHandlers: StreamHandlers;
}
