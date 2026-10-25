import { createHash } from "node:crypto";
import {
  currentV2RequestContext,
  runV2RequestContext,
  type V2RequestContext,
} from "./Client.guard.ts";
import { V2_THREAD_RPC, type V2ThreadEnvelope } from "./Orchestration.protocol.ts";
import type { V2LegacyThreadEnvelope } from "./Orchestration.protocol.legacy.ts";
import { v2Request, type OpencodeV2Client } from "./Client.ts";
import type { V2ThreadRegistration } from "./Orchestration.registration.ts";

export interface V2RpcAuthority {
  readonly rpcID: string;
  readonly method: "info" | "authorize" | "fence" | "receipt" | V2ThreadEnvelope["operation"];
  readonly directory: string;
  readonly bodyDigest: string;
  readonly ownerDigest?: string;
  readonly nativeSessionId?: string;
  readonly enrollmentNonce?: string;
}

/** A helper is not authority: the fetch boundary checks the serialized wire request as well. */
export async function assertV2OrchestrationRpc(
  context: V2RequestContext,
  url: URL,
  request: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) {
  const authority = context.orchestration;
  if (
    !authority ||
    url.pathname !== `/api/rpc/${encodeURIComponent(authority.rpcID)}/${authority.method}` ||
    (init?.method ?? (request instanceof Request ? request.method : "GET")) !== "POST" ||
    [...url.searchParams].length !== 1 ||
    url.searchParams.get("location[directory]") !== authority.directory
  )
    throw new Error("V2 thread-tools RPC authority rejected.");
  if (
    context.intent === "health" ||
    (context.intent === "cleanup" &&
      (!["inspect", "detach", "fence"].includes(authority.method) ||
        authority.nativeSessionId !== context.nativeSessionId ||
        !authority.ownerDigest ||
        !authority.enrollmentNonce))
  )
    throw new Error("V2 thread-tools RPC cleanup authority rejected.");
  const body =
    typeof init?.body === "string"
      ? init.body
      : request instanceof Request && !init?.body
        ? await request.clone().text()
        : undefined;
  if (
    body === undefined ||
    Buffer.byteLength(body) > 32768 ||
    createHash("sha256").update(body).digest("hex") !== authority.bodyDigest
  )
    throw new Error("V2 thread-tools RPC wire body rejected.");
  context.permit.assertCurrent();
  context.operationSignal?.throwIfAborted();
}

/** Signed owner operations cannot be replaced by native authentication or model-supplied metadata. */
export async function callV2ThreadRpc(
  client: OpencodeV2Client,
  directory: string,
  method: V2RpcAuthority["method"],
  input: V2ThreadEnvelope | V2LegacyThreadEnvelope | Record<string, never>,
  nativeSessionId?: string,
  observe?: (operation: Promise<unknown>) => void,
  signal?: AbortSignal,
  registration?: V2ThreadRegistration,
) {
  signal?.throwIfAborted();
  const context = currentV2RequestContext();
  if (!context || context.intent === "health")
    throw new Error("V2 thread-tools RPC requires consent.");
  const envelope =
    "ownerDigest" in input ? (input as V2ThreadEnvelope | V2LegacyThreadEnvelope) : undefined;
  if ((method === "info") !== !envelope || (envelope && envelope.operation !== method))
    throw new Error("V2 thread-tools RPC operation mismatch.");
  if (envelope?.protocol === "bigbud.thread.v1" && !["inspect", "detach"].includes(method))
    throw new Error("V2 legacy thread-tools authority is cleanup-only.");
  if (registration && envelope && registration.issuer !== envelope.issuer)
    throw new Error("V2 thread-tools registration issuer mismatch.");
  const rpcID = registration?.id ?? V2_THREAD_RPC;
  const authority: V2RpcAuthority = Object.freeze({
    rpcID,
    method,
    directory,
    bodyDigest: createHash("sha256").update(JSON.stringify({ input })).digest("hex"),
    ...(envelope
      ? {
          ownerDigest: envelope.ownerDigest,
          enrollmentNonce: envelope.enrollmentNonce,
          ...(nativeSessionId ? { nativeSessionId } : {}),
        }
      : {}),
  });
  return runV2RequestContext({ ...context, orchestration: authority }, () =>
    v2Request(
      `thread-tools ${method}`,
      (signal) => {
        const operation = client.rpc.call(
          {
            rpcID,
            method,
            location: { directory },
            input: JSON.parse(JSON.stringify(input)),
          },
          { signal },
        );
        observe?.(operation);
        return operation;
      },
      { timeoutMs: 5000, ...(signal ? { signal } : {}) },
    ),
  ).then((result) => result.output);
}
