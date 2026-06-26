import * as os from "node:os";

const LOOPBACK_HOST = "127.0.0.1";
const WILDCARD_IPV4_HOST = "0.0.0.0";

interface NetworkAddressCandidate {
  readonly address: string;
  readonly score: number;
}

export interface ResolveDesktopMobileRemoteNetworkInput {
  readonly serverSettingsPath: string;
  readonly hostOverride?: string | undefined;
  readonly networkInterfaces?: typeof os.networkInterfaces;
}

export interface DesktopMobileRemoteNetwork {
  readonly bindHost: string;
  readonly clientHost: string;
  readonly advertisedHost: string;
}

function isWildcardHost(host: string): boolean {
  return host === WILDCARD_IPV4_HOST || host === "::" || host === "[::]";
}

function normalizeHostOverride(hostOverride: string | undefined): string | undefined {
  const trimmed = hostOverride?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function scoreIpv4Address(address: string): number {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return -1;
  }

  const [first = -1, second = -1] = octets;
  if (first === 10) {
    return 3;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return 3;
  }
  if (first === 192 && second === 168) {
    return 3;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return 2;
  }
  if (first === 169 && second === 254) {
    return -1;
  }
  return 1;
}

export function resolveAdvertisedIpv4Host(
  networkInterfaces: typeof os.networkInterfaces = os.networkInterfaces,
): string | null {
  const candidates: NetworkAddressCandidate[] = [];

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) {
        continue;
      }
      if (address.family !== "IPv4") {
        continue;
      }
      const score = scoreIpv4Address(address.address);
      if (score < 0) {
        continue;
      }
      candidates.push({
        address: address.address,
        score,
      });
    }
  }

  candidates.sort(
    (left, right) => right.score - left.score || left.address.localeCompare(right.address),
  );
  return candidates[0]?.address ?? null;
}

export function resolveDesktopMobileRemoteNetwork({
  hostOverride,
  networkInterfaces = os.networkInterfaces,
}: ResolveDesktopMobileRemoteNetworkInput): DesktopMobileRemoteNetwork {
  const normalizedHostOverride = normalizeHostOverride(hostOverride);

  if (normalizedHostOverride) {
    const advertisedHost = isWildcardHost(normalizedHostOverride)
      ? (resolveAdvertisedIpv4Host(networkInterfaces) ?? LOOPBACK_HOST)
      : normalizedHostOverride;

    return {
      bindHost: normalizedHostOverride,
      clientHost: isWildcardHost(normalizedHostOverride) ? LOOPBACK_HOST : normalizedHostOverride,
      advertisedHost,
    };
  }

  return {
    bindHost: LOOPBACK_HOST,
    clientHost: LOOPBACK_HOST,
    advertisedHost: LOOPBACK_HOST,
  };
}
