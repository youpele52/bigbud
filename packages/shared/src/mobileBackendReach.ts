/**
 * Classifies a mobile backend origin by where a phone can reach it from. This
 * is static address evidence only: it never proves reachability, and it never
 * inspects credentials (callers pass an origin, not a full URL with tokens).
 */
export type MobileBackendReach =
  /** HTTPS on a Tailscale MagicDNS name: reachable off-LAN when Tailscale is connected on the phone. */
  | "tailnet-https"
  /** HTTPS on another host (custom setup); reachability depends on that host's network. */
  | "other-https"
  /** HTTPS on a private LAN address or `.local` name: same-network only. */
  | "lan-https"
  /** Plain HTTP to a Tailscale address: unencrypted and blocked from HTTPS pages. */
  | "tailnet-http"
  /** Plain HTTP to a private LAN address: same-network only. */
  | "lan-http"
  /** Loopback: reachable only from the computer itself. */
  | "loopback"
  /** Plain HTTP to another host. */
  | "other-http"
  | "invalid";

const TAILNET_DNS_SUFFIX = ".ts.net";

function parseIpv4(hostname: string): readonly number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
  return parseIpv4(hostname)?.[0] === 127;
}

function isTailnetHost(hostname: string): boolean {
  if (hostname.endsWith(TAILNET_DNS_SUFFIX)) return true;
  const octets = parseIpv4(hostname);
  // Tailscale assigns IPv4 addresses from the 100.64.0.0/10 CGNAT range.
  return octets !== null && octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127;
}

function isPrivateLanHost(hostname: string): boolean {
  if (hostname.endsWith(".local")) return true;
  const octets = parseIpv4(hostname);
  if (octets === null) return false;
  const [first, second = 0] = octets;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

export function classifyMobileBackendReach(origin: string): MobileBackendReach {
  let parsed: URL;
  try {
    parsed = new URL(origin.trim());
  } catch {
    return "invalid";
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "invalid";
  if (isLoopbackHost(hostname)) return "loopback";
  const secure = parsed.protocol === "https:";
  if (secure) {
    // Tailscale Serve certificates exist only for MagicDNS names, not raw 100.x addresses.
    if (hostname.endsWith(TAILNET_DNS_SUFFIX)) return "tailnet-https";
    return isPrivateLanHost(hostname) ? "lan-https" : "other-https";
  }
  if (isTailnetHost(hostname)) return "tailnet-http";
  return isPrivateLanHost(hostname) ? "lan-http" : "other-http";
}

/** True only for addresses designed to work away from the computer's own network. */
export function isOffNetworkMobileReach(reach: MobileBackendReach): boolean {
  return reach === "tailnet-https" || reach === "other-https";
}

/** Returns `protocol//host` with no path, query, fragment or userinfo, or null when invalid. */
export function toRedactedMobileOrigin(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}
