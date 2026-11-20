import { handleRemoteAgentDownload, type RemoteAgentDownloadEnv } from "./remoteAgentDownload";

/**
 * Request routing for the Cloudflare Pages advanced-mode worker (`dist/_worker.js`). Only
 * `/download/<ref>/remote-agent` is handled here; every other request goes to the static assets so
 * pages, the 404 page, headers and caching behave exactly as a Functions-free Pages deploy.
 */

export interface MarketingWorkerEnv extends RemoteAgentDownloadEnv {
  readonly ASSETS: { readonly fetch: (request: Request) => Promise<Response> };
}

export interface MarketingWorkerContext {
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

const REMOTE_AGENT_PATH = /^\/download\/([^/]+)\/remote-agent$/;

/** Returns the raw `<ref>` segment, `undefined` when it cannot be decoded, or `null` for no match. */
export function matchRemoteAgentRef(pathname: string): string | undefined | null {
  const match = REMOTE_AGENT_PATH.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return undefined;
  }
}

/** Workers expose the zone cache as `caches.default`; the DOM typings do not declare it. */
function edgeCache(): Cache {
  return (globalThis.caches as unknown as { readonly default: Cache }).default;
}

export async function handleMarketingRequest(
  request: Request,
  env: MarketingWorkerEnv,
  context: MarketingWorkerContext,
): Promise<Response> {
  const isRead = request.method === "GET" || request.method === "HEAD";
  const ref = isRead ? matchRemoteAgentRef(new URL(request.url).pathname) : null;
  if (ref === null) return env.ASSETS.fetch(request);

  const response = await handleRemoteAgentDownload(ref, {
    env,
    fetch: (input, init) => fetch(input, init),
    cache: edgeCache(),
    waitUntil: (promise) => context.waitUntil(promise),
  });
  return request.method === "HEAD" ? new Response(null, response) : response;
}
