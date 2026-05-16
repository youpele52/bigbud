import type {
  EventId,
  CanonicalItemType,
  ProviderRuntimeEvent,
  ProviderSession,
  ThreadId,
  ThreadTokenUsageSnapshot,
  TurnId,
  UserInputQuestion,
} from "@bigbud/contracts";
import type { Effect } from "effect";

import type { EventNdjsonLogger } from "../EventNdjsonLogger.ts";
import type { PiRpcProcess, PiRpcStdoutMessage } from "./RpcProcess.ts";

export const PROVIDER = "pi" as const;
export const USER_INPUT_FALLBACK_QUESTION_ID = "answer";

export type PiSessionRuntimeMode = ProviderSession["runtimeMode"];

export type PiRuntimeSource = "pi.rpc.event" | "pi.rpc.response" | "pi.rpc.synthetic";

export interface PiResumeCursor {
  readonly sessionId?: string;
  readonly sessionFile?: string;
}

export interface PiAdapterModelSelection {
  readonly provider: "pi";
  readonly model: string;
  readonly options?: {
    readonly thinkingLevel?: string;
  };
  readonly subProviderID?: string;
}

export interface MutableTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

export interface PendingPiUserInputRequest {
  readonly requestId: string;
  readonly turnId: TurnId | undefined;
  readonly question: UserInputQuestion;
  responding: boolean;
}

export interface ActivePiSession {
  readonly process: PiRpcProcess;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  readonly runtimeMode: PiSessionRuntimeMode;
  readonly pendingUserInputs: Map<string, PendingPiUserInputRequest>;
  readonly turns: Array<MutableTurnSnapshot>;
  unsubscribe: () => void;
  providerRuntimeExecutionTargetId: ProviderSession["providerRuntimeExecutionTargetId"];
  workspaceExecutionTargetId: ProviderSession["workspaceExecutionTargetId"];
  executionTargetId: ProviderSession["executionTargetId"];
  cwd: string | undefined;
  model: string | undefined;
  providerID: string | undefined;
  thinkingLevel: string | undefined;
  updatedAt: string;
  lastError: string | undefined;
  activeTurnId: TurnId | undefined;
  pendingTurnEnd:
    | {
        readonly stamp: PiEventStamp;
        readonly raw: NonNullable<ProviderRuntimeEvent["raw"]>;
        readonly message: { readonly message?: Record<string, unknown> };
      }
    | undefined;
  lastUsage: ThreadTokenUsageSnapshot | undefined;
  sessionId: string | undefined;
  sessionFile: string | undefined;
  currentAssistantMessageId: string | undefined;
  currentToolOutputById: Map<string, string>;
  currentToolInfoById: Map<
    string,
    {
      toolName: string;
      args: Record<string, unknown> | undefined;
      itemType: CanonicalItemType;
      title: string;
    }
  >;
}

export interface PiAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export interface PiEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

export type PiMakeEventStamp = () => Effect.Effect<PiEventStamp>;

export type PiEmitEvents = (events: ReadonlyArray<ProviderRuntimeEvent>) => Effect.Effect<void>;

export type PiWriteNativeEvent = (threadId: ThreadId, event: unknown) => Effect.Effect<void>;

export type PiRunPromise = <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;

export type PiSyntheticEventFn = <TType extends ProviderRuntimeEvent["type"]>(
  threadId: ThreadId,
  type: TType,
  payload: Extract<ProviderRuntimeEvent, { type: TType }>["payload"],
  extra?: {
    turnId?: TurnId;
    itemId?: string;
    requestId?: string;
  },
) => Effect.Effect<Extract<ProviderRuntimeEvent, { type: TType }>>;

export type PiStdoutEventHandler = (
  session: ActivePiSession,
  message: PiRpcStdoutMessage,
) => Effect.Effect<void>;

export type PiProcessExitHandler = (
  session: ActivePiSession,
  detail: string,
) => Effect.Effect<void>;
