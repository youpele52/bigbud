/** Opens (or focuses) the one renderer window bound to a remote backend profile. The desktop
 * shell validates the profile ID shape only; the window itself resolves the relay profile. */
export type DesktopOpenRemoteBackendWindowResult =
  | { readonly status: "opened" }
  | { readonly status: "unavailable"; readonly reason: "invalid-profile" | "not-supported" };

export interface DesktopRemoteBackendAssetBinding {
  /** Loopback relay lease origin (`http://127.0.0.1:<port>`). */
  readonly baseUrl: string;
  /** The lease's local credential; attached only to requests from the bound window. */
  readonly localCredential: string;
}

export interface DesktopRemoteBackendBridge {
  openRemoteBackendWindow?: (profileId: string) => Promise<DesktopOpenRemoteBackendWindowResult>;
  /** Bound windows only: tag-loaded assets (img, iframe) cannot set headers, so the shell adds the
   * lease credential and client RPC revision to this window's requests to the lease origin. */
  bindRemoteBackendAssets?: (binding: DesktopRemoteBackendAssetBinding) => Promise<boolean>;
}
