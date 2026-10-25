import { Effect, Queue, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { DEFAULT_TERMINAL_ID, type TerminalEvent, WS_METHODS } from "@bigbud/contracts";
import {
  type TerminalEventsSubscriptionInput,
  type TerminalOutputAckInput,
  TerminalSessionStreamInput,
  type TerminalSessionStreamItem,
} from "@bigbud/contracts/workspace/terminal.stream.ts";
import type { TerminalSearchInput } from "@bigbud/contracts/workspace/terminal.search.ts";

import { observeRpcEffect, observeRpcStream } from "../observability/RpcInstrumentation";
import { TerminalOutputDelivery } from "../terminal/TerminalOutputDelivery";
import type { WsRpcContext } from "./wsRpcContext";

/**
 * Terminal event streams. The global stream feeds sidebar/agent state (and, with
 * `legacyDetection`, only the output that client-side agent detection needs); each mounted view
 * opens a terminal-scoped stream whose output is flow-controlled by parse acknowledgements.
 */
export function makeWsRpcTerminalSessionHandlers(context: WsRpcContext) {
  const deliveries = new Map<string, TerminalOutputDelivery>();
  const manager = context.terminalManager;

  return {
    [WS_METHODS.subscribeTerminalEvents]: (input: TerminalEventsSubscriptionInput) =>
      observeRpcStream(
        WS_METHODS.subscribeTerminalEvents,
        Stream.callback<TerminalEvent>((queue) =>
          Effect.acquireRelease(
            manager.subscribe(
              (event) => Queue.offer(queue, event),
              input.outputScope ? { outputScope: input.outputScope } : undefined,
            ),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        ),
        { "rpc.aggregate": "terminal" },
      ),
    [WS_METHODS.subscribeTerminalSession]: (input: typeof TerminalSessionStreamInput.Type) =>
      observeRpcStream(
        WS_METHODS.subscribeTerminalSession,
        Stream.callback<TerminalSessionStreamItem>((queue) =>
          Effect.gen(function* () {
            const threadId = input.threadId;
            const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
            const subscriptionId = randomUUID();
            const runFork = Effect.runForkWith(yield* Effect.services());
            const setHeld = (held: boolean) => {
              if (!manager.setOutputHold) return;
              runFork(
                manager
                  .setOutputHold({ threadId, terminalId, holderId: subscriptionId, held })
                  .pipe(Effect.ignoreCause({ log: true })),
              );
            };
            const delivery = new TerminalOutputDelivery({
              emit: (event) => Queue.offerUnsafe(queue, event),
              setHeld,
              // The client resynchronizes from a snapshot when its subscription restarts.
              overflow: () => Queue.endUnsafe(queue),
            });
            yield* Effect.acquireRelease(
              manager.subscribe((event) =>
                Effect.sync(() => {
                  if (event.threadId === threadId && event.terminalId === terminalId)
                    delivery.push(event);
                }),
              ),
              (unsubscribe) =>
                Effect.sync(() => {
                  unsubscribe();
                  deliveries.delete(subscriptionId);
                  delivery.close();
                }),
            );
            // Registered before `subscribed`, so no event after the client's open can be missed.
            deliveries.set(subscriptionId, delivery);
            Queue.offerUnsafe(queue, { type: "subscribed", subscriptionId });
            delivery.start();
          }),
        ),
        { "rpc.aggregate": "terminal" },
      ),
    [WS_METHODS.terminalOutputAck]: (input: TerminalOutputAckInput) =>
      observeRpcEffect(
        WS_METHODS.terminalOutputAck,
        Effect.sync(() => deliveries.get(input.subscriptionId)?.acknowledge(input.processedChars)),
        { "rpc.aggregate": "terminal" },
      ),
    [WS_METHODS.terminalSearch]: (input: TerminalSearchInput) =>
      observeRpcEffect(
        WS_METHODS.terminalSearch,
        manager.search?.(input) ?? Effect.succeed({ hits: [], truncated: false }),
        { "rpc.aggregate": "terminal" },
      ),
  };
}
