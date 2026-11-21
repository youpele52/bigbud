import { Effect, Queue, Stream } from "effect";
import { randomUUID } from "node:crypto";
import { DEFAULT_TERMINAL_ID, WS_METHODS } from "@bigbud/contracts";
import {
  type TerminalEventsSubscriptionInput,
  type TerminalEventsStreamItem,
  type TerminalOutputAckInput,
  TerminalSessionStreamInput,
  type TerminalSessionStreamRpcItem,
} from "@bigbud/contracts/workspace/terminal.stream.ts";
import type { TerminalSearchInput } from "@bigbud/contracts/workspace/terminal.search.ts";
import type { TerminalViewInput } from "@bigbud/contracts/workspace/terminal.activity.ts";
import { sshMonitorCallerId } from "../ssh/sshMonitor.connections.ts";
import type { TerminalRecoveryInput } from "@bigbud/contracts/workspace/terminal.recovery.ts";

import { observeRpcEffect, observeRpcStream } from "../observability/RpcInstrumentation";
import { TerminalOutputDelivery } from "../terminal/TerminalOutputDelivery";
import type { WsRpcContext } from "./wsRpcContext";
import { makeBoundedTerminalEventOffer } from "./wsRpcHandlers.terminalEvents.ts";

/**
 * Terminal event streams. The global stream feeds sidebar/agent state (and, with
 * `legacyDetection`, only the output that client-side agent detection needs); each mounted view
 * opens a terminal-scoped stream whose output is flow-controlled by parse acknowledgements.
 */
export function makeWsRpcTerminalSessionHandlers(context: WsRpcContext) {
  const deliveries = new Map<string, TerminalOutputDelivery>();
  const manager = context.terminalManager;

  return {
    [WS_METHODS.terminalRecovery]: (input: TerminalRecoveryInput) =>
      observeRpcEffect(
        WS_METHODS.terminalRecovery,
        manager.recovery?.(input) ??
          Effect.succeed({ type: "unavailable" as const, reason: "recovery-unavailable" }),
        { "rpc.aggregate": "terminal" },
      ),
    [WS_METHODS.subscribeTerminalEvents]: (input: TerminalEventsSubscriptionInput) =>
      observeRpcStream(
        WS_METHODS.subscribeTerminalEvents,
        Stream.callback<TerminalEventsStreamItem>((queue) => {
          const offer = makeBoundedTerminalEventOffer(queue);
          const activity = input.includeWork ? context.terminalActivity : undefined;
          const lifecycle = input.includeLifecycle ? manager.subscribeLifecycle : undefined;
          return Effect.andThen(
            Effect.all([
              activity
                ? Effect.acquireRelease(activity.subscribe(offer), (unsubscribe) =>
                    Effect.sync(unsubscribe),
                  )
                : Effect.void,
              lifecycle
                ? Effect.acquireRelease(lifecycle(offer), (unsubscribe) => Effect.sync(unsubscribe))
                : Effect.void,
            ]),
            Effect.acquireRelease(
              manager.subscribe(offer, {
                ...(input.outputScope ? { outputScope: input.outputScope } : {}),
                ...(input.includeInventory ? { onInventory: offer } : {}),
              }),
              (unsubscribe) => Effect.sync(unsubscribe),
            ),
          );
        }),
        { "rpc.aggregate": "terminal" },
      ),
    [WS_METHODS.subscribeTerminalSession]: (input: typeof TerminalSessionStreamInput.Type) =>
      observeRpcStream(
        WS_METHODS.subscribeTerminalSession,
        Stream.callback<TerminalSessionStreamRpcItem>((queue) =>
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
            if (manager.subscribeSession) {
              // Host sessions: the screen first (with `acceptScreen`), live output cut after it,
              // and the renderer counted as attached for the host's query responder (§8.9).
              const handle = yield* Effect.acquireRelease(
                manager.subscribeSession(
                  { threadId, terminalId, acceptScreen: input.acceptScreen === true },
                  {
                    screen: (item) => Queue.offerUnsafe(queue, item),
                    event: (event) => delivery.push(event),
                    overflow: () => Queue.endUnsafe(queue),
                  },
                ),
                (handle) =>
                  Effect.sync(() => {
                    handle.unsubscribe(delivery.diagnostics.acknowledgedChars);
                    deliveries.delete(subscriptionId);
                    delivery.close();
                  }),
              );
              deliveries.set(subscriptionId, delivery);
              Queue.offerUnsafe(queue, { type: "subscribed", subscriptionId });
              // Screen items go straight to the queue, ahead of the delivery's first event.
              delivery.start();
              handle.start();
              return;
            }
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
    [WS_METHODS.terminalView]: (input: TerminalViewInput, options?: { clientId: number }) =>
      observeRpcEffect(
        WS_METHODS.terminalView,
        Effect.suspend(() => {
          const caller = sshMonitorCallerId(context.monitorInstanceId, options?.clientId);
          return caller && context.terminalActivity
            ? context.terminalActivity.view(caller, input)
            : Effect.void;
        }),
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
