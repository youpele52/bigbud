import type * as RpcMessage from "effect/unstable/rpc/RpcMessage";

/**
 * JSON-RPC lets a peer use string request ids (for example UUIDs). Effect RPC
 * keeps request ids as decimal `bigint`s: the server does `BigInt(id)` and the
 * ndjson encoder writes `Number(requestId)`, so a non-numeric id from the agent
 * crashed the client's RPC server and could never be answered.
 *
 * Incoming agent requests with a non-decimal id get a synthetic decimal id above
 * the exact-integer JSON range, which an agent's numeric ids cannot reach. The
 * response encoded for that synthetic id is rewritten to carry the agent's exact
 * original string id. Decimal ids are untouched (previous behaviour).
 */
const SYNTHETIC_BASE = 2n ** 53n + 1n;
const DECIMAL = /^\d+$/;

type Encoded = string | Uint8Array;

export interface AcpRequestIdMap {
  /** Replace a non-decimal agent request id with a synthetic decimal one. */
  readonly incoming: <M extends RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded>(
    message: M,
  ) => M;
  /** The agent's original id for an outgoing response, if it was remapped. */
  readonly originalFor: (message: unknown) => string | undefined;
  /** Rewrite one encoded ndjson response to the original string id. */
  readonly restore: (encoded: Encoded, original: string) => Encoded;
  /** Forget a mapping once its final response was sent. */
  readonly settle: (message: unknown) => void;
  readonly size: () => number;
}

function requestIdOf(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const value = (message as { requestId?: unknown }).requestId;
  return typeof value === "string" || typeof value === "bigint" ? String(value) : undefined;
}

export function makeAcpRequestIdMap(): AcpRequestIdMap {
  const originals = new Map<string, string>();
  let next = SYNTHETIC_BASE;
  return {
    incoming: (message) => {
      if (message._tag !== "Request") return message;
      const id = String((message as { id: unknown }).id);
      if (id === "" || DECIMAL.test(id)) return message;
      const synthetic = String(next);
      next += 1n;
      originals.set(synthetic, id);
      return { ...message, id: synthetic };
    },
    originalFor: (message) => {
      const id = requestIdOf(message);
      return id === undefined ? undefined : originals.get(id);
    },
    restore: (encoded, original) => {
      const text = typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded);
      const trailing = text.endsWith("\n") ? "\n" : "";
      const value = JSON.parse(text) as Record<string, unknown>;
      value.id = original;
      const restored = `${JSON.stringify(value)}${trailing}`;
      return typeof encoded === "string" ? restored : new TextEncoder().encode(restored);
    },
    settle: (message) => {
      if (typeof message !== "object" || message === null) return;
      if ((message as { _tag?: unknown })._tag !== "Exit") return;
      const id = requestIdOf(message);
      if (id !== undefined) originals.delete(id);
    },
    size: () => originals.size,
  };
}
