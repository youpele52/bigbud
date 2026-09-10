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
  type MobileRecoveryFrame,
  type MobileRecoverySubscriptionInput,
} from "@bigbud/contracts/server/mobile.recovery";
import { MobileWsRpcGroup } from "@bigbud/contracts/server/rpc.mobile";
import { Effect, Exit, ManagedRuntime, Scope, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";

import {
  createMobileRpcProtocolLayer,
  type MobileWsProtocolLifecycleHandlers,
} from "./mobileRpc.protocol";
import { normalizeRecoveryRpcError } from "./mobileRpc.errors";
import { SelfHealingStream } from "./selfHealingStream";

const makeMobileRpcProtocolClient = RpcClient.make(MobileWsRpcGroup);
type MobileRpcProtocolClient =
  typeof makeMobileRpcProtocolClient extends Effect.Effect<infer Client, any, any> ? Client : never;
const MOBILE_SNAPSHOT_TIMEOUT_MS = 45_000;
const MOBILE_THREAD_TIMEOUT_MS = 45_000;

type MobileRpcRuntime = Pick<
  ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>,
  "dispose" | "runCallback" | "runPromise" | "runSync"
>;

type DomainEventStreamStarter = (input: {
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
  readonly startMobileRecoveryStream?: MobileRecoveryStreamStarter;
}

function formatRpcError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function noopCancel() {}

function runCancellable<A, E>(input: {
  readonly runtime: MobileRpcRuntime;
  readonly effect: Effect.Effect<A, E, RpcClient.Protocol>;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
}) {
  return new Promise<A>((resolve, reject) => {
    let settled = false;
    let cancel: (interruptor?: number) => void = noopCancel;
    const timeoutId = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      cancel();
      cleanup();
      reject(new Error("Timed out waiting for mobile recovery."));
    }, input.timeoutMs);
    const cleanup = () => {
      globalThis.clearTimeout(timeoutId);
      input.signal?.removeEventListener("abort", abort);
    };
    const finish = (exit: Exit.Exit<A, E>) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (Exit.isSuccess(exit)) {
        resolve(exit.value);
      } else {
        reject(exit.cause);
      }
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cancel();
      cleanup();
      reject(new Error("Mobile recovery request was cancelled."));
    };
    if (input.signal?.aborted) {
      abort();
      return;
    }
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      cancel = input.runtime.runCallback(input.effect, { onExit: finish });
    } catch (error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
  });
}

export class MobileRpcClient {
  private readonly runtime: MobileRpcRuntime;
  private readonly clientScope: Scope.Closeable;
  private readonly clientPromise: Promise<MobileRpcProtocolClient>;
  private readonly domainEventListeners = new Set<(event: unknown) => void>();
  private readonly domainEventStream: SelfHealingStream;
  private readonly startDomainEventStream: DomainEventStreamStarter;
  private readonly startMobileRecoveryStreamRun: MobileRecoveryStreamStarter;

  constructor(
    private readonly wsUrl: string,
    lifecycleHandlers?: MobileWsProtocolLifecycleHandlers,
    options?: MobileRpcClientOptions,
  ) {
    this.runtime =
      options?.runtime ??
      ManagedRuntime.make(createMobileRpcProtocolLayer(wsUrl, lifecycleHandlers));
    this.clientScope = options?.clientScope ?? this.runtime.runSync(Scope.make());
    this.clientPromise =
      options?.clientPromise ??
      this.runtime.runPromise(Scope.provide(this.clientScope)(makeMobileRpcProtocolClient));
    this.startDomainEventStream =
      options?.startDomainEventStream ??
      (({ dispatchEvent, onExit }) =>
        this.runtime.runCallback(
          Effect.promise(() => this.clientPromise).pipe(
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
    this.startMobileRecoveryStreamRun =
      options?.startMobileRecoveryStream ??
      (({ recoveryAttemptId, serverEpoch, baselineSequence, dispatchFrame, onError, onExit }) =>
        this.runtime.runCallback(
          Effect.promise(() => this.clientPromise).pipe(
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
                onError?.(
                  normalizeRecoveryRpcError(exit.cause, MOBILE_RECOVERY_WS_METHODS.subscribe),
                );
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
  }

  async dispose() {
    this.stopDomainEventStream();
    await this.runtime.runPromise(Scope.close(this.clientScope, Exit.void));
    this.runtime.dispose();
  }

  async refreshGitStatus(input: GitStatusInput): Promise<GitStatusResult> {
    const client = await this.clientPromise;
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
        effect: Effect.promise(() => this.clientPromise).pipe(
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
        effect: Effect.promise(() => this.clientPromise).pipe(
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
        effect: Effect.promise(() => this.clientPromise).pipe(
          Effect.flatMap((client) => client[MOBILE_RECOVERY_WS_METHODS.getBaseline](input)),
        ),
        signal,
        timeoutMs: MOBILE_SNAPSHOT_TIMEOUT_MS,
      });
    } catch (error) {
      const normalized = normalizeRecoveryRpcError(error, MOBILE_RECOVERY_WS_METHODS.getBaseline);
      if (normalized !== error) throw normalized;
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
    const client = await this.clientPromise;
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
    const client = await this.clientPromise;
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

  private stopDomainEventStream() {
    this.domainEventStream.stop();
  }

  onServerConfigEvent(listener: (event: unknown) => void): () => void {
    let closed = false;
    const cancel = this.runtime.runCallback(
      Effect.promise(() => this.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(client[WS_METHODS.subscribeServerConfig]({}), (event) =>
            Effect.sync(() => {
              if (!closed) {
                listener(event);
              }
            }),
          ),
        ),
        Effect.catch(() => Effect.void),
      ),
    );
    return () => {
      closed = true;
      cancel();
    };
  }
}
