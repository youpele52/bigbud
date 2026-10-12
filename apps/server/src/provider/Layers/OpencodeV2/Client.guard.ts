import { AsyncLocalStorage } from "node:async_hooks";
import type { V2ConsentPermit, V2ConsentAuthority } from "./Application.consent.ts";

export interface V2RequestContext {
  readonly transport: string;
  readonly permit: V2ConsentPermit;
  readonly intent: "execute" | "health" | "cleanup";
  readonly nativeSessionId?: string;
}
const contexts = new AsyncLocalStorage<V2RequestContext>();
export const currentV2RequestContext = () => contexts.getStore();
export const runV2RequestContext = <T>(context: V2RequestContext, run: () => T): T =>
  contexts.run(context, run);

/** Validate after registration awaits at the last synchronous point before fetch. */
export function assertV2RequestContext(transport: string, url: URL, method: string) {
  const context = contexts.getStore();
  if (!context || context.transport !== transport)
    throw new Error("V2 shared request authority missing/mismatched.");
  context.permit.assertCurrent();
  if (
    context.intent === "health" &&
    (method !== "GET" || !["/api/info", "/openapi.json"].includes(url.pathname))
  )
    throw new Error("V2 preconsent request rejected.");
  if (context.intent === "cleanup") {
    const root = `/api/session/${encodeURIComponent(context.nativeSessionId ?? "")}`;
    const route = url.pathname;
    const read = method === "GET" && (route === root || route === `${root}/inbox`);
    const cancel =
      method === "DELETE" &&
      (route.startsWith(`${root}/inbox/`) || route.startsWith(`${root}/form/`));
    const interrupt =
      method === "POST" &&
      route === `${root}/interrupt` &&
      url.searchParams.get("resume") === "false";
    if (!context.nativeSessionId || (!read && !cancel && !interrupt))
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
) {
  if (!transport) return run();
  const controller = new AbortController();
  const permit: V2ConsentPermit = {
    revision: -1,
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
    release: () => {},
  };
  return contexts.run({ transport, permit, intent: "cleanup", nativeSessionId }, run);
}
