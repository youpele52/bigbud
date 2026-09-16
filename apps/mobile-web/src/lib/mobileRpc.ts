import {
  ORCHESTRATION_WS_METHODS,
  type GitStatusInput,
  type GitStatusResult,
  type OrchestrationReadModel,
  type ThreadId,
  WS_METHODS,
} from "@bigbud/contracts";
import {
  MOBILE_RECOVERY_WS_METHODS,
  type MobileRecoveryBaseline,
  type MobileRecoveryBaselineInput,
  type MobileRecoveryCommandOutcome,
  type MobileRecoveryCommandOutcomeInput,
  type MobileRecoveryFrame,
  type MobileRecoverySubscriptionInput,
} from "@bigbud/contracts/server/mobile.recovery";
import { MobileWsRpcGroup } from "@bigbud/contracts/server/rpc.mobile";
import { Data, Effect, Exit, ManagedRuntime, Scope, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";

import {
  createMobileRpcProtocolLayer,
  type MobileWsProtocolLifecycleHandlers,
} from "./mobileRpc.protocol";
import { MobileRecoveryUnsupportedError, normalizeRecoveryRpcError } from "./mobileRpc.errors";
import {
  runCancellable,
  startMobileRpcClientInitialization,
  type MobileRpcRuntime,
} from "./mobileRpc.requests";
import { SelfHealingStream } from "./selfHealingStream";

const makeMobileRpcProtocolClient = RpcClient.make(MobileWsRpcGroup);
type MobileRpcProtocolClient =
  typeof makeMobileRpcProtocolClient extends Effect.Effect<infer Client, any, any> ? Client : never;
const MOBILE_SNAPSHOT_TIMEOUT_MS = 45_000;
const MOBILE_THREAD_TIMEOUT_MS = 45_000;
const CLIENT_DISPOSED_MESSAGE = "Mobile RPC client is disposed.";

class MobileRpcClientDisposedError extends Data.TaggedError("MobileRpcClientDisposedError")<{
  readonly message: string;
}> {}

type DomainEventStreamStarter = (input: {
  readonly dispatchEvent: (event: unknown) => void;
  readonly onExit: () => void;
}) => () => void;

type ServerConfigStreamStarter = (input: {
  readonly dispatchEvent: (event: unknown) => void;
  readonly onExit: () => void;
}) => () => void;

export type MobileRecoveryStreamStarter = (input: {
  readonly recoveryAttemptId: MobileRecoverySubscriptionInput["recoveryAttemptId"];
  readonly serverEpoch: MobileRecoverySubscriptionInput["serverEpoch"];
  readonly baselineSequence: MobileRecoverySubscriptionInput["baselineSequence"];
  readonly dispatchFrame: (frame: MobileRecoveryFrame) => void;
  readonly onError?: (error: unknown) => void;
  readonly onExit: () => void;
}) => () => void;

interface MobileRpcClientOptions {
  readonly clientPromise?: Promise<MobileRpcProtocolClient>;
  readonly clientScope?: Scope.Closeable;
  readonly runtime?: MobileRpcRuntime;
  readonly startDomainEventStream?: DomainEventStreamStarter;
  readonly startServerConfigStream?: ServerConfigStreamStarter;
  readonly startMobileRecoveryStream?: MobileRecoveryStreamStarter;
}

function formatRpcError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export class MobileRpcClient {
  private expectedUnsupportedClose = false;
  private readonly runtime: MobileRpcRuntime;
  private readonly clientScope: Scope.Closeable;
  private readonly clientPromise: Promise<MobileRpcProtocolClient>;
  private readonly cancelClientInitialization: () => void;
  private readonly rejectClientPromise: (reason?: unknown) => void;
  private disposed = false;
  private readonly domainEventListeners = new Set<(event: unknown) => void>();
  private readonly serverConfigListeners = new Set<(event: unknown) => void>();
  private readonly domainEventStream: SelfHealingStream;
  private readonly serverConfigStream: SelfHealingStream;
  private readonly startDomainEventStream: DomainEventStreamStarter;
  private readonly startServerConfigStream: ServerConfigStreamStarter;
  private readonly startMobileRecoveryStreamRun: MobileRecoveryStreamStarter;
  private disposePromise: Promise<void> | null = null;

  constructor(
    private readonly wsUrl: string,
    lifecycleHandlers?: MobileWsProtocolLifecycleHandlers,
    options?: MobileRpcClientOptions,
  ) {
    const protocolLifecycleHandlers = lifecycleHandlers
      ? {
          ...lifecycleHandlers,
          onOpen: () => {
            this.expectedUnsupportedClose = false;
            lifecycleHandlers.onOpen?.();
          },
          onClose: (details: { readonly code: number; readonly reason: string }) => {
            if (this.expectedUnsupportedClose) {
              this.expectedUnsupportedClose = false;
              return;
            }
            lifecycleHandlers.onClose?.(details);
          },
        }
      : undefined;
    this.runtime =
      options?.runtime ??
      ManagedRuntime.make(createMobileRpcProtocolLayer(wsUrl, protocolLifecycleHandlers));
    this.clientScope = options?.clientScope ?? this.runtime.runSync(Scope.make());
    const clientInitialization = startMobileRpcClientInitialization({
      runtime: this.runtime,
      effect: Scope.provide(this.clientScope)(makeMobileRpcProtocolClient),
      ...(options?.clientPromise ? { clientPromise: options.clientPromise } : {}),
    });
    this.clientPromise = clientInitialization.promise;
    this.cancelClientInitialization = clientInitialization.cancel;
    this.rejectClientPromise = clientInitialization.reject;
    this.startDomainEventStream =
      options?.startDomainEventStream ??
      (({ dispatchEvent, onExit }) =>
        this.runtime.runCallback(
          this.getClientEffect().pipe(
            Effect.flatMap((client) =>
              Stream.runForEach(client[WS_METHODS.subscribeOrchestrationDomainEvents]({}), (item) =>
                Effect.sync(() => {
                  if (item.type !== "batch") return;
                  for (const event of item.events) dispatchEvent(event);
                }),
              ),
            ),
            Effect.catch(() => Effect.void),
            Effect.ensuring(Effect.sync(onExit)),
          ),
        ));
    this.startServerConfigStream =
      options?.startServerConfigStream ??
      (({ dispatchEvent, onExit }) =>
        this.runtime.runCallback(
          this.getClientEffect().pipe(
            Effect.flatMap((client) =>
              Stream.runForEach(client[WS_METHODS.subscribeServerConfig]({}), (event) =>
                Effect.sync(() => dispatchEvent(event)),
              ),
            ),
            Effect.catch(() => Effect.void),
            Effect.ensuring(Effect.sync(onExit)),
          ),
        ));
    this.startMobileRecoveryStreamRun =
      options?.startMobileRecoveryStream ??
      (({ recoveryAttemptId, serverEpoch, baselineSequence, dispatchFrame, onError, onExit }) =>
        this.runtime.runCallback(
          this.getClientEffect().pipe(
            Effect.flatMap((client) =>
              Stream.runForEach(
                client[MOBILE_RECOVERY_WS_METHODS.subscribe]({
                  recoveryAttemptId,
                  serverEpoch,
                  baselineSequence,
                }),
                (frame) => Effect.sync(() => dispatchFrame(frame)),
              ),
            ),
          ),
          {
            onExit: (exit) => {
              if (Exit.isFailure(exit))
                (() => {
                  const normalized = normalizeRecoveryRpcError(
                    exit.cause,
                    MOBILE_RECOVERY_WS_METHODS.subscribe,
                  );
                  if (normalized instanceof MobileRecoveryUnsupportedError) {
                    this.expectedUnsupportedClose = true;
                  }
                  onError?.(normalized);
                })();
              onExit();
            },
          },
        ));
    this.domainEventStream = new SelfHealingStream(({ onExit }) =>
      this.startDomainEventStream({
        dispatchEvent: (event) => {
          for (const listener of this.domainEventListeners) {
            listener(event);
          }
        },
        onExit,
      }),
    );
    this.serverConfigStream = new SelfHealingStream(({ onExit }) =>
      this.startServerConfigStream({
        dispatchEvent: (event) => {
          for (const listener of this.serverConfigListeners) listener(event);
        },
        onExit,
      }),
    );
  }

  dispose() {
    if (this.disposePromise !== null) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      this.stopDomainEventStream();
      this.stopServerConfigStream();
      this.cancelClientInitialization();
      this.rejectClientPromise(new Error(CLIENT_DISPOSED_MESSAGE));
      await this.runtime.runPromise(Scope.close(this.clientScope, Exit.void));
      this.runtime.dispose();
    })();
    return this.disposePromise;
  }

  async refreshGitStatus(input: GitStatusInput): Promise<GitStatusResult> {
    const client = await this.getClient();
    try {
      return await this.runtime.runPromise(client[WS_METHODS.gitRefreshStatus](input));
    } catch (error) {
      throw new Error(formatRpcError(error), { cause: error });
    }
  }

  async getSnapshot(signal?: AbortSignal): Promise<OrchestrationReadModel> {
    try {
      return await runCancellable({
        runtime: this.runtime,
        effect: this.getClientEffect().pipe(
          Effect.flatMap((client) => client[ORCHESTRATION_WS_METHODS.getSnapshot]({})),
        ),
        signal,
        timeoutMs: MOBILE_SNAPSHOT_TIMEOUT_MS,
      });
    } catch (error) {
      throw new Error(formatRpcError(error), { cause: error });
    }
  }

  async getMobileThread(threadId: ThreadId, signal?: AbortSignal) {
    try {
      return await runCancellable({
        runtime: this.runtime,
        effect: this.getClientEffect().pipe(
          Effect.flatMap((client) =>
            client[ORCHESTRATION_WS_METHODS.getMobileThread]({ threadId }),
          ),
        ),
        signal,
        timeoutMs: MOBILE_THREAD_TIMEOUT_MS,
      });
    } catch (error) {
      throw new Error(formatRpcError(error), { cause: error });
    }
  }

  async getMobileRecoveryBaseline(
    input: MobileRecoveryBaselineInput,
    signal?: AbortSignal,
  ): Promise<MobileRecoveryBaseline> {
    try {
      return await runCancellable({
        runtime: this.runtime,
        effect: this.getClientEffect().pipe(
          Effect.flatMap((client) => client[MOBILE_RECOVERY_WS_METHODS.getBaseline](input)),
        ),
        signal,
        timeoutMs: MOBILE_SNAPSHOT_TIMEOUT_MS,
      });
    } catch (error) {
      const normalized = normalizeRecoveryRpcError(error, MOBILE_RECOVERY_WS_METHODS.getBaseline);
      if (normalized instanceof MobileRecoveryUnsupportedError) {
        this.expectedUnsupportedClose = true;
        throw normalized;
      }
      throw new Error(formatRpcError(error), { cause: error });
    }
  }

  async getMobileCommandOutcome(
    input: MobileRecoveryCommandOutcomeInput,
    signal?: AbortSignal,
  ): Promise<MobileRecoveryCommandOutcome> {
    try {
      return await runCancellable({
        runtime: this.runtime,
        effect: this.getClientEffect().pipe(
          Effect.flatMap((client) => client[MOBILE_RECOVERY_WS_METHODS.getCommandOutcome](input)),
        ),
        signal,
        timeoutMs: MOBILE_THREAD_TIMEOUT_MS,
      });
    } catch (error) {
      const normalized = normalizeRecoveryRpcError(
        error,
        MOBILE_RECOVERY_WS_METHODS.getCommandOutcome,
      );
      if (normalized instanceof MobileRecoveryUnsupportedError) {
        this.expectedUnsupportedClose = true;
        throw normalized;
      }
      throw new Error(formatRpcError(error), { cause: error });
    }
  }

  startMobileRecoveryStream(input: Parameters<MobileRecoveryStreamStarter>[0]): () => void {
    return this.startMobileRecoveryStreamRun(input);
  }

  async dispatchCommand(
    command: Parameters<
      MobileRpcProtocolClient[typeof ORCHESTRATION_WS_METHODS.dispatchCommand]
    >[0],
  ) {
    const client = await this.getClient();
    try {
      return await this.runtime.runPromise(
        client[ORCHESTRATION_WS_METHODS.dispatchCommand](command),
      );
    } catch (error) {
      throw new Error(formatRpcError(error), { cause: error });
    }
  }

  async getFullThreadDiff(
    input: Parameters<
      MobileRpcProtocolClient[typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff]
    >[0],
  ) {
    const client = await this.getClient();
    try {
      return await this.runtime.runPromise(
        client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input),
      );
    } catch (error) {
      throw new Error(formatRpcError(error), { cause: error });
    }
  }

  onDomainEvent(listener: (event: unknown) => void): () => void {
    this.domainEventListeners.add(listener);
    this.ensureDomainEventStream();
    return () => {
      this.domainEventListeners.delete(listener);
      if (this.domainEventListeners.size === 0) {
        this.stopDomainEventStream();
      }
    };
  }

  private ensureDomainEventStream() {
    this.domainEventStream.start();
  }

  private async getClient(): Promise<MobileRpcProtocolClient> {
    if (this.disposed) throw new Error(CLIENT_DISPOSED_MESSAGE);
    const client = await this.clientPromise;
    if (this.disposed) throw new Error(CLIENT_DISPOSED_MESSAGE);
    return client;
  }

  private getClientEffect() {
    return Effect.promise(() => this.clientPromise).pipe(
      Effect.flatMap((client) =>
        this.disposed
          ? Effect.fail(new MobileRpcClientDisposedError({ message: CLIENT_DISPOSED_MESSAGE }))
          : Effect.succeed(client),
      ),
    );
  }

  private stopDomainEventStream() {
    this.domainEventStream.stop();
  }

  private stopServerConfigStream() {
    this.serverConfigStream.stop();
  }

  onServerConfigEvent(listener: (event: unknown) => void): () => void {
    this.serverConfigListeners.add(listener);
    this.serverConfigStream.start();
    return () => {
      this.serverConfigListeners.delete(listener);
      if (this.serverConfigListeners.size === 0) this.stopServerConfigStream();
    };
  }
}
