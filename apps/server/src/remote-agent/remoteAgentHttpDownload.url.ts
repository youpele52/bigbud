export interface RemoteAgentDownloadUrlPolicy {
  readonly allowedOrigins?: ReadonlySet<string>;
  readonly allowLoopbackHttp?: boolean;
}

const RELEASE_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com"]);

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function parseAndValidateDownloadUrl(
  value: string,
  policy: RemoteAgentDownloadUrlPolicy,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("download URL is invalid");
  }
  if (url.username || url.password)
    throw new Error("credential-bearing download URLs are forbidden");
  const loopbackFixture =
    policy.allowLoopbackHttp && url.protocol === "http:" && isLoopback(url.hostname);
  if (url.protocol !== "https:" && !loopbackFixture) {
    throw new Error("download URL must use HTTPS");
  }
  const allowedOrigin = policy.allowedOrigins?.has(url.origin) ?? false;
  const approvedReleaseHost = !policy.allowedOrigins && RELEASE_HOSTS.has(url.hostname);
  const approvedFixture = !policy.allowedOrigins && loopbackFixture;
  if (!allowedOrigin && !approvedReleaseHost && !approvedFixture) {
    throw new Error("download URL host is not approved");
  }
  return url;
}

export function sanitizedDownloadHost(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}
