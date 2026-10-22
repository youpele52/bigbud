import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import {
  type FromClientEncoded,
  RequestId,
  type ResponseExitEncoded,
  ResponseExitDieEncoded,
} from "effect/unstable/rpc/RpcMessage";

const UNKNOWN_REQUEST_TAG_PREFIX = "Unknown request tag: ";

/**
 * Diagnostics and discovery RPCs an older server may not know. The server answers an unknown tag with a
 * connection-wide Defect; for these tags it must fail only the request, never the session.
 */
export const OPTIONAL_WS_RPC_TAGS: ReadonlySet<string> = new Set([
  WS_METHODS.serverReportWsConnectionDiagnostics,
  WS_METHODS.serverGetWsConnectionDiagnostics,
  WS_METHODS.serverListSshConfigHosts,
  WS_METHODS.serverListRemoteFolders,
]);

const unsupportedTags = new Set<string>();

/** True once the server rejected `tag` as unknown; callers skip sending it for this page. */
export function isOptionalWsRpcUnsupported(tag: string): boolean {
  return unsupportedTags.has(tag);
}

export function resetOptionalWsRpcSupportForTests(): void {
  unsupportedTags.clear();
}

export class WsOptionalRpcUnsupportedError extends Error {
  constructor(tag: string) {
    super(`${UNKNOWN_REQUEST_TAG_PREFIX}${tag}`);
    this.name = "WsOptionalRpcUnsupportedError";
  }
}

function defectMessage(defect: unknown): string {
  if (typeof defect === "string") return defect;
  if (typeof defect === "object" && defect !== null && "message" in defect) {
    const { message } = defect as { readonly message: unknown };
    if (typeof message === "string") return message;
  }
  return "";
}

/** The optional tag named by an unknown-tag defect, or null for any other defect. */
export function unknownOptionalRpcTag(defect: unknown): string | null {
  const message = defectMessage(defect).trim();
  if (!message.startsWith(UNKNOWN_REQUEST_TAG_PREFIX)) return null;
  const tag = message.slice(UNKNOWN_REQUEST_TAG_PREFIX.length).trim();
  return OPTIONAL_WS_RPC_TAGS.has(tag) ? tag : null;
}

/** Tracks in-flight optional requests on one physical protocol so a defect can be scoped. */
export class WsOptionalRpcTracker {
  private readonly inFlight = new Map<string, string>();

  trackSent(request: FromClientEncoded): void {
    if (request._tag === "Request" && OPTIONAL_WS_RPC_TAGS.has(request.tag)) {
      this.inFlight.set(request.id, request.tag);
    } else if (request._tag === "Interrupt") {
      this.inFlight.delete(request.requestId);
    }
  }

  settle(requestId: string): void {
    this.inFlight.delete(requestId);
  }

  clear(): void {
    this.inFlight.clear();
  }

  /**
   * Per-request failures that replace an unknown-tag defect for an optional RPC, or null when
   * the defect is a real protocol failure. An empty list means nothing is left to fail.
   */
  scopeUnknownTagDefect(defect: unknown): ResponseExitEncoded[] | null {
    const tag = unknownOptionalRpcTag(defect);
    if (!tag) return null;
    unsupportedTags.add(tag);
    const exits: ResponseExitEncoded[] = [];
    for (const [requestId, requestTag] of this.inFlight) {
      if (requestTag !== tag) continue;
      this.inFlight.delete(requestId);
      exits.push(
        ResponseExitDieEncoded({
          requestId: RequestId(requestId),
          defect: `${UNKNOWN_REQUEST_TAG_PREFIX}${tag}`,
        }),
      );
    }
    return exits;
  }
}
