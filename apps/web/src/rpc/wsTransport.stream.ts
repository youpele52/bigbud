import { Cause, Effect, Exit, ManagedRuntime, Stream } from "effect";
import type { RpcClient } from "effect/unstable/rpc";

import type { WsRpcProtocolClient } from "./protocol";
import { markWsInboundActivity } from "./wsActivity";
import {
  withWsInitialApplicationDeadline,
  type WsInitialApplicationDeadline,
} from "./wsTransport.initialValue";

/** Runs one scoped stream attempt, fencing listeners before applying inbound values. */
export function runWsStreamOnSession<TValue>(
  session: {
    readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
    readonly clientPromise: Promise<WsRpcProtocolClient>;
  },
  connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
  listener: (value: TValue) => void | Promise<void>,
  isActive: () => boolean,
  markValueReceived: () => void,
  markValueApplied: () => void,
  markListenerFailure: (error: unknown) => unknown,
  initialApplication?: WsInitialApplicationDeadline,
): { readonly cancel: () => void; readonly completed: Promise<void> } {
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: unknown) => void;
  let listenerFailure: unknown;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  const cancel = session.runtime.runCallback(
    Effect.scoped(
      withWsInitialApplicationDeadline(initialApplication, (markInitialApplied) =>
        Effect.promise(() => session.clientPromise).pipe(
          Effect.flatMap((client) =>
            Stream.runForEach(connect(client), (value) =>
              Effect.promise(() => {
                if (!isActive()) return Promise.resolve();
                markWsInboundActivity();
                markValueReceived();
                return Promise.resolve()
                  .then(() => {
                    if (isActive()) return listener(value);
                  })
                  .then(() => {
                    if (isActive()) {
                      markValueApplied();
                      markInitialApplied();
                    }
                  })
                  .catch((error: unknown) => {
                    listenerFailure = markListenerFailure(error);
                    return Promise.reject(listenerFailure);
                  });
              }),
            ),
          ),
        ),
      ),
    ),
    {
      onExit: (exit) => {
        if (Exit.isSuccess(exit)) resolveCompleted();
        else rejectCompleted(listenerFailure ?? Cause.squash(exit.cause));
      },
    },
  );
  return { cancel, completed };
}
