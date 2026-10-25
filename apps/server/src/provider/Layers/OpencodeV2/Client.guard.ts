import { AsyncLocalStorage } from "node:async_hooks";
import type { V2ConsentPermit, V2ConsentAuthority } from "./Application.consent.ts";
import { runDetachedV2Caller, captureV2CallerGuard } from "./Runtime.caller.ts";
import { inV2Settlement } from "./Runtime.activation.hold.ts";
import { logV2SettlementDiagnostic } from "./Runtime.settlement.log.ts";

export interface V2RequestContext {
  readonly transport: string;
  readonly permit: V2ConsentPermit;
  readonly intent: "execute" | "health" | "cleanup";
  readonly nativeSessionId?: string;
  readonly operationSignal?: AbortSignal;
  readonly operationGuard?: () => void;
  readonly observeOperation?: (operation: Promise<unknown>) => void;
  readonly orchestration?: import("./Client.guard.orchestration.ts").V2RpcAuthority;
}
const contexts = new AsyncLocalStorage<V2RequestContext>();
export const currentV2RequestContext = () => contexts.getStore();
export interface V2OperationAuthority {
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}

/** Capture consent, the short operation fence and explicit caller authority before any hop.
 * This is a mutation fence only: it creates no transport/config/native execution permission. */
export function captureV2OperationAuthority(extra?: V2OperationAuthority): V2OperationAuthority {
  const context = contexts.getStore(),
    caller = context?.intent === "cleanup" ? () => {} : captureV2CallerGuard();
  const signals = [context?.permit.signal, context?.operationSignal, extra?.signal].filter(
    (signal): signal is AbortSignal => !!signal,
  );
  const signal = signals.length ? AbortSignal.any(signals) : new AbortController().signal;
  return {
    signal,
    assertCurrent: () => {
      context?.permit.assertCurrent();
      context?.operationGuard?.();
      extra?.assertCurrent();
      signal.throwIfAborted();
      caller();
    },
  };
}
export function assertV2OperationCurrent() {
  const context = contexts.getStore();
  context?.permit.assertCurrent();
  context?.operationSignal?.throwIfAborted();
  context?.operationGuard?.();
}
export const runV2RequestContext = <T>(context: V2RequestContext, run: () => T): T =>
  contexts.run(context, run);
/** Validate after registration awaits at the last synchronous point before fetch. Rejections
 * inside settlement reads are logged with pathname and intent only; behavior is unchanged. */
export function assertV2RequestContext(transport: string, url: URL, method: string) {
  try {
    return assertV2RequestContextOnce(transport, url, method);
  } catch (error) {
    if (inV2Settlement())
      logV2SettlementDiagnostic("OpenCode v2 settlement request authority rejected", {
        pathname: url.pathname,
        intent: contexts.getStore()?.intent ?? "none",
      });
    throw error;
  }
}

function assertV2RequestContextOnce(transport: string, url: URL, method: string) {
  const context = contexts.getStore();
  if (!context || context.transport !== transport)
    throw new Error("V2 shared request authority missing/mismatched.");
  context.permit.assertCurrent();
  context.operationSignal?.throwIfAborted();
  context.operationGuard?.();
  if (url.pathname === "/api/config") {
    if (context.intent !== "execute" || !context.permit.assertNativeConfigRead)
      throw new Error("V2 native configuration-read authority is missing.");
    context.permit.assertNativeConfigRead();
  }
  if (url.pathname.startsWith("/api/rpc/")) {
    if (!context.orchestration || context.intent === "health")
      throw new Error("V2 shared RPC authority missing.");
    return context;
  }
  if (
    context.intent === "health" &&
    (method !== "GET" || !["/api/info", "/openapi.json"].includes(url.pathname))
  )
    throw new Error("V2 preconsent request rejected.");
  if (context.intent === "cleanup") {
    const root = `/api/session/${encodeURIComponent(context.nativeSessionId ?? "")}`;
    const route = url.pathname;
    const read =
      method === "GET" &&
      [root, `${root}/inbox`, `${root}/form`, `${root}/permission`].includes(route);
    // Dead-backend retirement must prove the old owner's native turn is idle; the official
    // running-session map is read-only and carries no session content.
    const running = method === "GET" && route === "/api/session/active";
    const cancel =
      method === "DELETE" &&
      (route.startsWith(`${root}/inbox/`) || route.startsWith(`${root}/form/`));
    const interrupt =
      method === "POST" &&
      route === `${root}/interrupt` &&
      url.searchParams.get("resume") === "false";
    if (!context.nativeSessionId || (!read && !running && !cancel && !interrupt))
      throw new Error("V2 original-owner cleanup route rejected.");
  }
  return context;
}

/** Capture before the operation's first await; queued work retains the original revision. */
export async function runAuthorizedV2<T>(
  authority: V2ConsentAuthority | undefined,
  transport: string | undefined,
  run: () => Promise<T>,
) {
  if (!authority || !transport) return run();
  const existing = contexts.getStore();
  if (existing?.intent !== "cleanup") existing?.permit.assertCurrent();
  if (existing?.transport === transport && existing.intent === "execute") {
    existing.permit.assertCurrent();
    return run();
  }
  const permit = authority.capture();
  try {
    const result = await contexts.run({ transport, permit, intent: "execute" }, run);
    permit.assertCurrent();
    return result;
  } finally {
    permit.release();
  }
}

/** Cleanup is explicitly scoped to the old owner, not a general consent bypass. */
export function runV2Cleanup<T>(
  transport: string | undefined,
  nativeSessionId: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
) {
  if (!transport) return runDetachedV2Caller(run);
  const controller = new AbortController();
  const operationSignal = signal ?? contexts.getStore()?.operationSignal;
  const cleanupSignal = operationSignal
    ? AbortSignal.any([controller.signal, operationSignal])
    : controller.signal;
  const permit: V2ConsentPermit = {
    revision: -1,
    signal: cleanupSignal,
    assertCurrent: () => cleanupSignal.throwIfAborted(),
    release: () => {},
  };
  return runDetachedV2Caller(() =>
    contexts.run(
      {
        transport,
        permit,
        intent: "cleanup",
        nativeSessionId,
        ...(operationSignal ? { operationSignal } : {}),
        ...(contexts.getStore()?.operationGuard
          ? { operationGuard: contexts.getStore()!.operationGuard }
          : {}),
        ...(contexts.getStore()?.observeOperation
          ? { observeOperation: contexts.getStore()!.observeOperation }
          : {}),
      },
      run,
    ),
  );
}
