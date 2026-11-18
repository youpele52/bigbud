/**
 * Shared bound for provider adapter runtime-event queues (F-B3).
 *
 * Adapter queues carry ordered provider events that drive thread state (turn start/completion,
 * messages, approvals), so they must never drop. They are bounded with the default `suspend`
 * strategy instead: once {@link PROVIDER_ADAPTER_EVENT_QUEUE_CAPACITY} events wait, the producer's
 * `Queue.offer` / `PubSub.publish` suspends until the ProviderService monitor catches up. The
 * backpressure reaches the provider's own transport (its stdout pipe or SDK iterator), so a stalled
 * consumer holds memory flat instead of buffering the provider's output without limit.
 *
 * Codex and OpenCode v2 used this capacity already; every other adapter now shares it.
 *
 * @module providerEventQueueBounds
 */
import { PubSub, Queue } from "effect";

/** Events an adapter may buffer before its producer waits (backpressure, never dropping). */
export const PROVIDER_ADAPTER_EVENT_QUEUE_CAPACITY = 256;

/** A backpressured adapter event queue (single consumer). */
export const makeProviderAdapterEventQueue = <A>() =>
  Queue.bounded<A>(PROVIDER_ADAPTER_EVENT_QUEUE_CAPACITY);

/** A backpressured adapter event PubSub: publishers wait for the slowest subscriber. */
export const makeProviderAdapterEventPubSub = <A>() =>
  PubSub.bounded<A>(PROVIDER_ADAPTER_EVENT_QUEUE_CAPACITY);
