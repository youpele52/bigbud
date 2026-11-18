import type { DesktopRemoteBackendAssetBinding } from "@bigbud/contracts/server/ipc.desktopRemoteBackend.ts";

/** Mirrors the server's lease schema: loopback relay origin and 64-hex local credential. */
const LEASE_BASE_URL = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/;
const LEASE_CREDENTIAL = /^[a-f0-9]{64}$/;
const CLIENT_RPC_REVISION_HEADER = "x-bigbud-client-rpc-revision";
const CLIENT_RPC_REVISION = "1";

interface AssetBinding {
  readonly origin: string;
  readonly headers: Readonly<Record<string, string>>;
}

export function parseRemoteBackendAssetBinding(value: unknown): AssetBinding | null {
  if (!value || typeof value !== "object") return null;
  const { baseUrl, localCredential } = value as Partial<DesktopRemoteBackendAssetBinding>;
  if (typeof baseUrl !== "string" || typeof localCredential !== "string") return null;
  const port = LEASE_BASE_URL.exec(baseUrl)?.[1];
  if (!port || Number(port) < 1 || Number(port) > 65_535) return null;
  if (!LEASE_CREDENTIAL.test(localCredential)) return null;
  return {
    origin: baseUrl,
    headers: {
      Authorization: `Bearer ${localCredential}`,
      [CLIENT_RPC_REVISION_HEADER]: CLIENT_RPC_REVISION,
    },
  };
}

type HeadersListener = (
  details: {
    readonly url: string;
    readonly webContentsId?: number;
    readonly requestHeaders: Record<string, string>;
  },
  callback: (response: { readonly requestHeaders: Record<string, string> }) => void,
) => void;

export interface HeaderInjectionSession {
  readonly webRequest: {
    onBeforeSendHeaders: (
      filter: { readonly urls: string[] },
      listener: HeadersListener | null,
    ) => void;
  };
}

/** Tag-loaded assets (img, iframe, video) cannot carry headers. One listener on the renderer
 * session adds the lease credential, but only for requests made by the bound window itself to its
 * own lease origin; the local window and every other origin are left untouched. */
export function createRemoteBackendAssetHeaders(session: HeaderInjectionSession) {
  const bindings = new Map<number, AssetBinding>();
  let installed = false;
  const listener: HeadersListener = (details, callback) => {
    const binding =
      details.webContentsId === undefined ? undefined : bindings.get(details.webContentsId);
    let sameOrigin = false;
    try {
      sameOrigin = binding !== undefined && new URL(details.url).origin === binding.origin;
    } catch {
      sameOrigin = false;
    }
    callback({
      requestHeaders:
        binding && sameOrigin
          ? { ...details.requestHeaders, ...binding.headers }
          : details.requestHeaders,
    });
  };
  return {
    bind(webContentsId: number, binding: AssetBinding): void {
      bindings.set(webContentsId, binding);
      if (installed) return;
      installed = true;
      session.webRequest.onBeforeSendHeaders({ urls: ["http://127.0.0.1/*"] }, listener);
    },
    unbind(webContentsId: number): void {
      bindings.delete(webContentsId);
      if (bindings.size > 0 || !installed) return;
      installed = false;
      session.webRequest.onBeforeSendHeaders({ urls: ["http://127.0.0.1/*"] }, null);
    },
    has: (webContentsId: number) => bindings.has(webContentsId),
  };
}
