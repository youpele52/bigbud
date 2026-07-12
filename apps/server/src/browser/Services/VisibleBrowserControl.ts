import type {
  BrowserAction,
  BrowserResult,
  ThreadId,
  TurnId,
  VisibleBrowserCommand,
  VisibleBrowserCommandResult,
  VisibleBrowserLeaseRevokeInput,
  VisibleBrowserLeaseSnapshot,
  VisibleBrowserRendererId,
} from "@bigbud/contracts";
import { Data, Effect, ServiceMap, Stream } from "effect";

export class VisibleBrowserControlError extends Data.TaggedError("VisibleBrowserControlError")<{
  readonly message: string;
}> {}

export interface VisibleBrowserControlShape {
  readonly isAvailable: Effect.Effect<boolean>;
  readonly execute: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly action: BrowserAction;
  }) => Effect.Effect<BrowserResult, VisibleBrowserControlError>;
  readonly complete: (input: VisibleBrowserCommandResult) => Effect.Effect<void, never>;
  readonly streamCommands: (
    rendererId: VisibleBrowserRendererId,
  ) => Stream.Stream<VisibleBrowserCommand>;
  readonly reconcileThread: (input: {
    readonly threadId: ThreadId;
    readonly activeTurnId: TurnId | null;
    readonly isRunning: boolean;
  }) => Effect.Effect<void>;
  readonly revokeLease: (input: VisibleBrowserLeaseRevokeInput) => Effect.Effect<void>;
  readonly getLeases: (
    rendererId: VisibleBrowserRendererId,
  ) => Effect.Effect<ReadonlyArray<VisibleBrowserLeaseSnapshot>>;
}

export class VisibleBrowserControl extends ServiceMap.Service<
  VisibleBrowserControl,
  VisibleBrowserControlShape
>()("bigbud/browser/Services/VisibleBrowserControl") {}

let currentVisibleBrowserControl: VisibleBrowserControlShape | null = null;

export function setVisibleBrowserControl(control: VisibleBrowserControlShape | null): void {
  currentVisibleBrowserControl = control;
}

export function getVisibleBrowserControl(): VisibleBrowserControlShape | null {
  return currentVisibleBrowserControl;
}
