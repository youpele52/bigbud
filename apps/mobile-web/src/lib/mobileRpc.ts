import {
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
  WS_METHODS,
} from "@bigbud/contracts";
import { MobileWsRpcGroup } from "@bigbud/contracts/server/rpc.mobile";
import { Effect, Exit, ManagedRuntime, Scope, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";

import {
  createMobileRpcProtocolLayer,
  type MobileWsProtocolLifecycleHandlers,
} from "./mobileRpc.protocol";

const makeMobileRpcProtocolClient = RpcClient.make(MobileWsRpcGroup);
type MobileRpcProtocolClient =
  typeof makeMobileRpcProtocolClient extends Effect.Effect<infer Client, any, any> ? Client : never;
const MOBILE_SNAPSHOT_TIMEOUT_MS = 10_000;

function formatRpcError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export class MobileRpcClient {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private readonly clientScope: Scope.Closeable;
  private readonly clientPromise: Promise<MobileRpcProtocolClient>;

  constructor(
    private readonly wsUrl: string,
    lifecycleHandlers?: MobileWsProtocolLifecycleHandlers,
  ) {
    this.runtime = ManagedRuntime.make(createMobileRpcProtocolLayer(wsUrl, lifecycleHandlers));
    this.clientScope = this.runtime.runSync(Scope.make());
    this.clientPromise = this.runtime.runPromise(
      Scope.provide(this.clientScope)(makeMobileRpcProtocolClient),
    );
  }

  async dispose() {
    await this.runtime.runPromise(Scope.close(this.clientScope, Exit.void));
    this.runtime.dispose();
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
    let closed = false;
    const cancel = this.runtime.runCallback(
      Effect.promise(() => this.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(client[WS_METHODS.subscribeOrchestrationDomainEvents]({}), (event) =>
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
