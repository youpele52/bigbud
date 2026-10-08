import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Closes the SDK runtime on interruption even if its initialization promise never settles. */
export function withClaudeProbeRuntime<A>(
  binaryPath: string,
  use: (runtime: ReturnType<typeof query>) => Promise<A>,
) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const abortController = new AbortController();
      const runtime = query({
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abortController.signal);
        })(),
        options: {
          pathToClaudeCodeExecutable: binaryPath,
          abortController,
          settingSources: ["user", "project", "local"],
          allowedTools: [],
          stderr: () => {},
        },
      });
      return { abortController, runtime };
    }),
    ({ abortController, runtime }) =>
      Effect.tryPromise(async (signal) => {
        const onAbort = () => abortController.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        try {
          return await use(runtime);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      }),
    ({ abortController, runtime }) =>
      Effect.sync(() => {
        abortController.abort();
        runtime.close();
      }),
  );
}
