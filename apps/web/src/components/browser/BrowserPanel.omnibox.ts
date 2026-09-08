const GOOGLE_SEARCH_URL = "https://www.google.com/search?q=";
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const UNSAFE_PROTOCOLS = new Set([
  "about:",
  "blob:",
  "data:",
  "file:",
  "ftp:",
  "javascript:",
  "mailto:",
  "tel:",
  "vbscript:",
]);
const EXPLICIT_SCHEME = /^([a-z][a-z\d+.-]*):/i;
const IPV4_HOSTNAME = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function buildGoogleSearchUrl(query: string): string {
  return `${GOOGLE_SEARCH_URL}${encodeURIComponent(query)}`;
}

export function getUnsupportedBrowserOmniboxScheme(input: string): string | null {
  const scheme = input.trim().match(EXPLICIT_SCHEME)?.[1]?.toLowerCase();
  return scheme && UNSAFE_PROTOCOLS.has(`${scheme}:`) ? scheme : null;
}

function isNavigableHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.includes(".") ||
    IPV4_HOSTNAME.test(hostname) ||
    hostname.includes(":")
  );
}

function resolveUnschemedUrl(input: string): string | null {
  try {
    const url = new URL(`https://${input}`);
    return url.username.length === 0 && isNavigableHostname(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

function hasExplicitPort(input: string): boolean {
  const authority = input.split(/[/?#]/, 1)[0] ?? "";
  return /(?:\]|[^:]+):\d+$/.test(authority);
}

export function resolveBrowserOmniboxInput(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  const explicitScheme = value.match(EXPLICIT_SCHEME)?.[1]?.toLowerCase();
  if (explicitScheme) {
    try {
      const url = new URL(value);
      if (HTTP_PROTOCOLS.has(url.protocol)) return url.toString();
      if (getUnsupportedBrowserOmniboxScheme(value)) return null;
    } catch {
      // A hostname and port can resemble a URL scheme before HTTPS is added.
    }

    const url = resolveUnschemedUrl(value);
    if (url && hasExplicitPort(value)) return url;
  }

  if (!/\s/.test(value)) {
    const url = resolveUnschemedUrl(value);
    if (url) return url;
  }

  return buildGoogleSearchUrl(value);
}
