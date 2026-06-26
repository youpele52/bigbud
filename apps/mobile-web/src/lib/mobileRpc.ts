import {
  ORCHESTRATION_WS_METHODS,
  type GitStatusInput,
  type GitStatusResult,
  type OrchestrationReadModel,
  type ThreadId,
  WS_METHODS,
} from "@bigbud/contracts";
import { MobileWsRpcGroup } from "@bigbud/contracts/server/rpc.mobile";
import { Effect, Exit, ManagedRuntime, Scope, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";

import {
  createMobileRpcProtocolLayer,
  type MobileWsProtocolLifecycleHandlers,
} from "./mobileRpc.protocol";
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

interface MobileRpcClientOptions {
  readonly clientPromise?: Promise<MobileRpcProtocolClient>;
  readonly clientScope?: Scope.Closeable;
  readonly runtime?: MobileRpcRuntime;
  readonly startDomainEventStream?: DomainEventStreamStarter;
}

function formatRpcError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export class MobileRpcClient {
  private readonly runtime: MobileRpcRuntime;
  private readonly clientScope: Scope.Closeable;
  private readonly clientPromise: Promise<MobileRpcProtocolClient>;
  private readonly domainEventListeners = new Set<(event: unknown) => void>();
  private readonly domainEventStream: SelfHealingStream;
  private readonly startDomainEventStream: DomainEventStreamStarter;

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
              Stream.runForEach(
                client[WS_METHODS.subscribeOrchestrationDomainEvents]({}),
                (event) =>
                  Effect.sync(() => {
                    dispatchEvent(event);
                  }),
              ),
            ),
            Effect.catch(() => Effect.void),
            Effect.ensuring(Effect.sync(onExit)),
          ),
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

  async getSnapshot(): Promise<OrchestrationReadModel> {
    const client = await this.clientPromise;
    try {
      return await Promise.race([
        this.runtime.runPromise(client[ORCHESTRATION_WS_METHODS.getSnapshot]({})),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => {
            reject(new Error("Timed out waiting for the desktop snapshot."));
          }, MOBILE_SNAPSHOT_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      throw new Error(formatRpcError(error), { cause: error });
    }
  }

  async getMobileThread(threadId: ThreadId) {
    const client = await this.clientPromise;
    try {
      return await Promise.race([
        this.runtime.runPromise(client[ORCHESTRATION_WS_METHODS.getMobileThread]({ threadId })),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => {
            reject(new Error("Timed out waiting for the desktop thread."));
          }, MOBILE_THREAD_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      throw new Error(formatRpcError(error), { cause: error });
    }
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
