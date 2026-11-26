import type { RemoteAgentWorkspaceClient } from "../../remote-agent/remoteAgentWorkspaceClient.ts";

/** Upper bound for resolving a fresh client and asking for one write receipt. */
export const REMOTE_WRITE_RECEIPT_TIMEOUT_MS = 10_000;

/**
 * Resolves the result hash of a write whose response was lost, when the agent proves it applied
 * that exact operation (`workspace.write` 1.2). One bounded attempt: a fresh client, one receipt
 * query, never a second write. Any other outcome (not applied, older agent, resolution failure,
 * timeout) returns undefined and the caller keeps the outcome unknown.
 */
export async function resolveRemoteWriteReceipt(input: {
  readonly resolve: () => Promise<RemoteAgentWorkspaceClient>;
  readonly operationId: string;
  readonly requestDigest: Uint8Array;
  readonly timeoutMs?: number;
}): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(
      () => resolve(undefined),
      input.timeoutMs ?? REMOTE_WRITE_RECEIPT_TIMEOUT_MS,
    );
  });
  const query = (async () => {
    const client = await input.resolve();
    const receipt = await client.queryWriteReceipt({
      operationId: input.operationId,
      requestDigest: input.requestDigest,
    });
    return receipt.applied ? receipt.resultSha256 : undefined;
  })().catch(() => undefined);
  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
