const MAX_QUEUED_CONTROLS = 64;

/** Controls retain arrival order; a read-only poll never queues behind another operation. */
export function makeProofTerminalQueue(interactive: boolean) {
  let pending: { kind: "control" | "poll"; result: Promise<unknown> } | undefined;
  let queuedControls = 0;

  function enqueue<A>(kind: "control" | "poll", operation: () => Promise<A>) {
    const prior = pending?.result;
    const result = (async () => {
      await prior?.catch(() => undefined);
      return operation();
    })().finally(() => {
      if (pending?.result === result) pending = undefined;
    });
    pending = { kind, result };
    return result;
  }
  return {
    async control<A>(operation: () => Promise<A>, closing = false) {
      if (!interactive && pending?.kind === "control")
        throw new Error("A proof terminal operation is already in flight.");
      if (queuedControls >= MAX_QUEUED_CONTROLS + (closing ? 1 : 0))
        throw new Error("The proof terminal operation queue is busy.");
      queuedControls++;
      try {
        return await enqueue("control", operation);
      } finally {
        queuedControls--;
      }
    },
    poll: <A>(operation: () => Promise<A>) => (pending ? undefined : enqueue("poll", operation)),
  };
}
