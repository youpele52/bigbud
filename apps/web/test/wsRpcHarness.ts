import { Effect, Exit, Layer, Option, PubSub, Queue, Scope, Stream } from "effect";
import { WS_METHODS, WsRpcGroup } from "@bigbud/contracts";
import { ThreadRetentionMutationAuthorization } from "@bigbud/contracts/server/rpc.retention";
import type { ServerThreadRetentionError } from "@bigbud/contracts/server/threadRetention";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import type * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";

const allowRetentionMutations: RpcMiddleware.RpcMiddleware<
  never,
  ServerThreadRetentionError,
  never
> = (effect) => effect;

type RpcWriter = Parameters<RpcServer.Protocol["Service"]["run"]>[0];

type BrowserWsClient = {
  send: (data: string) => void;
};

export type NormalizedWsRpcRequestBody = {
  _tag: string;
  [key: string]: unknown;
};

type UnaryResolverResult = unknown | Promise<unknown>;

interface BrowserWsRpcHarnessOptions {
  readonly resolveUnary?: (request: NormalizedWsRpcRequestBody) => UnaryResolverResult;
  readonly getInitialStreamValues?: (
    request: NormalizedWsRpcRequestBody,
  ) => ReadonlyArray<unknown> | undefined;
}

const STREAM_METHODS = new Set<string>([
  WS_METHODS.gitRunStackedAction,
  WS_METHODS.subscribeOrchestrationDomainEvents,
  WS_METHODS.subscribeTerminalEvents,
  WS_METHODS.subscribeTerminalSession,
  WS_METHODS.subscribeServerConfig,
  WS_METHODS.subscribeServerLifecycle,
  WS_METHODS.subscribeThinkingActivityDeltas,
]);

const ALL_RPC_METHODS = Array.from(WsRpcGroup.requests.keys());

function normalizeRequest(tag: string, payload: unknown): NormalizedWsRpcRequestBody {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      _tag: tag,
      ...(payload as Record<string, unknown>),
    };
  }
  return { _tag: tag, payload };
}

function asEffect(result: UnaryResolverResult): Effect.Effect<unknown, Error> {
  const effect = result as Effect.Effect<unknown, Error>;
  if (Effect.isEffect(effect)) return effect;
  if (result instanceof Promise) {
    return Effect.promise(() => result);
  }
  return Effect.succeed(result);
}

export class BrowserWsRpcHarness {
  readonly requests: Array<NormalizedWsRpcRequestBody> = [];

  private readonly parser = RpcSerialization.json.makeUnsafe();
  private client: BrowserWsClient | null = null;
  private scope: Scope.Closeable | null = null;
  private serverReady: Promise<RpcWriter> | null = null;
  private readonly connections = new Map<
    BrowserWsClient,
    { scope: Scope.Closeable; ready: Promise<RpcWriter> }
  >();
  private resolveUnary: NonNullable<BrowserWsRpcHarnessOptions["resolveUnary"]> = () => ({});
  private getInitialStreamValues: NonNullable<
    BrowserWsRpcHarnessOptions["getInitialStreamValues"]
  > = () => [];
  private streamPubSubs = new Map<string, PubSub.PubSub<unknown>>();

  async reset(options?: BrowserWsRpcHarnessOptions): Promise<void> {
    await this.disconnect();
    this.requests.length = 0;
    this.resolveUnary = options?.resolveUnary ?? (() => ({}));
    this.getInitialStreamValues = options?.getInitialStreamValues ?? (() => []);
    this.initializeStreamPubSubs();
  }

  connect(client: BrowserWsClient): void {
    if (this.streamPubSubs.size === 0) {
      this.initializeStreamPubSubs();
    }
    this.client = client;
    this.scope = Effect.runSync(Scope.make());
    let resolveReady!: (writer: RpcWriter) => void;
    let rejectReady!: (error: unknown) => void;
    this.serverReady = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const scope = this.scope;
    this.connections.set(client, { scope, ready: this.serverReady });
    const protocol = RpcServer.Protocol.of({
      run: (write) => Effect.sync(() => resolveReady(write)).pipe(Effect.andThen(Effect.never)),
      disconnects: Effect.runSync(Queue.unbounded<number>()),
      send: (_clientId, response) => this.sendResponse(response, client),
      end: () => Effect.void,
      clientIds: Effect.succeed(new Set([0])),
      initialMessage: Effect.succeed(Option.none()),
      supportsAck: true,
      supportsTransferables: false,
      supportsSpanPropagation: true,
    });
    void Effect.runPromise(
      RpcServer.make(WsRpcGroup).pipe(
        Effect.provide(
          Layer.mergeAll(
            this.makeLayer(),
            Layer.succeed(ThreadRetentionMutationAuthorization, allowRetentionMutations),
            Layer.succeed(RpcServer.Protocol, protocol),
          ),
        ),
        Effect.forkIn(scope),
      ),
    ).catch(rejectReady);
  }

  async disconnect(): Promise<void> {
    await Promise.all(
      [...this.connections.values()].map(({ scope }) =>
        Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined),
      ),
    );
    this.connections.clear();
    this.scope = null;
    for (const pubsub of this.streamPubSubs.values()) {
      Effect.runSync(PubSub.shutdown(pubsub));
    }
    this.streamPubSubs.clear();
    this.serverReady = null;
    this.client = null;
  }

  private initializeStreamPubSubs(): void {
    this.streamPubSubs = new Map(
      Array.from(STREAM_METHODS, (method) => [method, Effect.runSync(PubSub.unbounded<unknown>())]),
    );
  }

  async onMessage(rawData: string, client?: BrowserWsClient): Promise<void> {
    const ready = client ? this.connections.get(client)?.ready : this.serverReady;
    if (!ready) return; // Ignore late control frames from a disconnected test client.
    const write = await ready;
    const messages = this.parser.decode(rawData);
    for (const message of messages) {
      await Effect.runPromise(write(0, message as never));
    }
  }

  emitStreamValue(method: string, value: unknown): void {
    const pubsub = this.streamPubSubs.get(method);
    if (!pubsub) {
      throw new Error(`No stream registered for ${method}`);
    }
    const subscription = this.requests.findLast((request) => request._tag === method);
    const item =
      method === WS_METHODS.subscribeOrchestrationDomainEvents &&
      value &&
      typeof value === "object" &&
      "sequence" in value
        ? {
            type: "batch",
            route: "direct-unmanaged",
            consumerId: subscription?.consumerId ?? "browser-test",
            consumerGeneration: 0,
            serverEpoch: "browser-test",
            subscriptionGeneration: 0,
            batchId: `browser-event-${value.sequence}`,
            events: [value],
          }
        : value;
    Effect.runSync(PubSub.publish(pubsub, item));
  }

  private makeLayer() {
    const handlers: Record<string, (payload: unknown) => unknown> = {};
    for (const method of ALL_RPC_METHODS) {
      handlers[method] = STREAM_METHODS.has(method)
        ? (payload) => this.handleStream(method, payload)
        : (payload) => this.handleUnary(method, payload);
    }
    return WsRpcGroup.toLayer(handlers as never);
  }

  private sendResponse(response: unknown, client: BrowserWsClient) {
    return Effect.sync(() => {
      if (!this.connections.has(client)) {
        return;
      }
      const encoded = this.parser.encode(response);
      if (typeof encoded === "string") {
        client.send(encoded);
      }
    });
  }

  private handleUnary(method: string, payload: unknown) {
    const request = normalizeRequest(method, payload);
    this.requests.push(request);
    return asEffect(this.resolveUnary(request));
  }

  private handleStream(method: string, payload: unknown) {
    const request = normalizeRequest(method, payload);
    this.requests.push(request);
    const pubsub = this.streamPubSubs.get(method);
    if (!pubsub) {
      throw new Error(`No stream registered for ${method}`);
    }
    // Like the server, a terminal-scoped stream always starts with its registration item.
    const registration =
      method === WS_METHODS.subscribeTerminalSession
        ? [{ type: "subscribed", subscriptionId: `harness-${this.requests.length}` }]
        : [];
    // Subscribe before sending initial values: client ACK backpressure must not lose live events.
    return Stream.unwrap(
      Effect.map(PubSub.subscribe(pubsub), (subscription) =>
        Stream.fromIterable([
          ...registration,
          ...(this.getInitialStreamValues(request) ?? []),
        ]).pipe(Stream.concat(Stream.fromEffectRepeat(PubSub.take(subscription)))),
      ),
    );
  }
}
