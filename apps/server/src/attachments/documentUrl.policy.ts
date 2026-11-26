import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export class DocumentUrlError extends Error {}

export const MAX_DOCUMENT_URL_LENGTH = 2048;

export function validateDocumentUrl(url: URL): void {
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.href.length > MAX_DOCUMENT_URL_LENGTH
  ) {
    throw new DocumentUrlError(
      "Enter an HTTP or HTTPS URL without credentials (up to 2048 characters).",
    );
  }
}

const privateV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  privateV4.addSubnet(network, prefix);
}

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const specialV6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23], // IETF assignments, including transition and benchmarking ranges
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3ffe::", 16],
  ["3fff::", 20],
] as const) {
  specialV6.addSubnet(network, prefix, "ipv6");
}

export function isPublicDocumentAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return !privateV4.check(address);
    case 6:
      return globalV6.check(address, "ipv6") && !specialV6.check(address, "ipv6");
    default:
      return false;
  }
}

export function documentHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

type ResolveAddresses = (hostname: string) => Promise<readonly { address: string }[]>;

export const resolveDocumentAddresses: ResolveAddresses = (hostname) =>
  lookup(hostname, { all: true });

export async function withDocumentAbort<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
      run(),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export async function resolvePublicDocumentAddresses(
  url: URL,
  signal: AbortSignal,
  resolve: ResolveAddresses,
): Promise<string[]> {
  const hostname = documentHostname(url);
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await withDocumentAbort(signal, () => resolve(hostname)).catch(() => {
        signal.throwIfAborted();
        throw new DocumentUrlError(
          "Could not resolve the document host. Check the URL and try again.",
        );
      });
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicDocumentAddress(address))
  ) {
    throw new DocumentUrlError("Only public document URLs are allowed, including after redirects.");
  }
  const unique = [...new Set(addresses.map(({ address }) => address))];
  // Try the other address family early without changing the preferred first answer.
  const alternate = unique.findIndex((address) => isIP(address) !== isIP(unique[0]!));
  if (alternate > 1) unique.splice(1, 0, ...unique.splice(alternate, 1));
  return unique;
}
