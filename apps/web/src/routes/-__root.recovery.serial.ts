export interface AsyncOperationQueue {
  enqueue<TResult>(operation: () => Promise<TResult>): Promise<TResult>;
}

export function createAsyncOperationQueue(): AsyncOperationQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue: <TResult>(operation: () => Promise<TResult>) => {
      const next = tail.then(operation);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

export function serializeAsyncCalls<TArgs extends readonly unknown[], TResult>(
  operation: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  const queue = createAsyncOperationQueue();
  return (...args) => queue.enqueue(() => operation(...args));
}
