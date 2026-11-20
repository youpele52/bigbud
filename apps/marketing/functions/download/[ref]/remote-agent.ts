import {
  handleRemoteAgentDownload,
  type RemoteAgentDownloadEnv,
} from "../../_lib/remoteAgentDownload";

/** Cloudflare Pages Function for `/download/<ref>/remote-agent`. */

interface PagesFunctionContext {
  readonly env: RemoteAgentDownloadEnv;
  readonly params: Readonly<Record<string, string | string[] | undefined>>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

/** Workers expose the zone cache as `caches.default`; the DOM typings do not declare it. */
function edgeCache(): Cache {
  return (globalThis.caches as unknown as { readonly default: Cache }).default;
}

export const onRequestGet = (context: PagesFunctionContext): Promise<Response> =>
  handleRemoteAgentDownload(context.params.ref, {
    env: context.env,
    fetch: (input, init) => fetch(input, init),
    cache: edgeCache(),
    waitUntil: (promise) => context.waitUntil(promise),
  });
