import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Runtime from "effect/Runtime";

/** Treat only a requested managed-service signal with clean interrupt-only teardown as success. */
export function makeManagedServiceTeardown(
  signalReceived: () => boolean,
  cleanup: () => void,
): Runtime.Teardown {
  return (exit, onExit) => {
    const requestedStop =
      signalReceived() && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
    cleanup();
    if (requestedStop) {
      onExit(0);
      return;
    }
    Runtime.defaultTeardown(exit, onExit);
  };
}
