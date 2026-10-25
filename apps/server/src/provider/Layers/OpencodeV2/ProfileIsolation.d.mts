/** POSIX ownership/permission inspection; Windows stays unavailable without verified ACL support. */
export function inspectPrivateV2Profile(
  root: string,
  options?: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly maxEntries?: number;
    readonly marker?: boolean;
    readonly application?: boolean;
  },
): Promise<void>;
