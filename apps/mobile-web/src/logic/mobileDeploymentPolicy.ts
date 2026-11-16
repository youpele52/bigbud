export interface MobileDeploymentPolicy {
  readonly appOrigin: string;
  readonly hostedCompatibility: boolean;
}
const HOSTED_COMPATIBILITY_ORIGIN = "https://mobile.bigbud.app";

function origin(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      url.origin === value
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
function loopback(value: string) {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** Deployment policy cannot be enabled by a query/fragment or by a production environment flag. */
export function resolveMobileDeploymentPolicy(
  appOrigin: string,
  options: {
    readonly development?: boolean;
    readonly hostedFixtureOrigin?: string;
  } = {},
): MobileDeploymentPolicy {
  const canonical = origin(appOrigin) ?? "";
  return {
    appOrigin: canonical,
    hostedCompatibility:
      canonical === HOSTED_COMPATIBILITY_ORIGIN ||
      (!!options.development &&
        !!options.hostedFixtureOrigin &&
        loopback(canonical) &&
        origin(options.hostedFixtureOrigin) === canonical),
  };
}
export function currentMobileDeploymentPolicy() {
  return resolveMobileDeploymentPolicy(
    typeof window === "undefined" ? "" : (window.location?.origin ?? ""),
    {
      development: import.meta.env.DEV,
      hostedFixtureOrigin: import.meta.env.VITE_MOBILE_HOSTED_FIXTURE_ORIGIN,
    },
  );
}
export function allowsMobileCredentialOrigin(
  policy: MobileDeploymentPolicy,
  backendOrigin: string,
): boolean {
  const canonical = origin(backendOrigin);
  return (
    !!canonical &&
    (canonical === policy.appOrigin || (!!policy.appOrigin && policy.hostedCompatibility))
  );
}

/** Directory navigation carries no session, pairing ID, token, query or fragment. */
export function mobileHostNavigationURL(backendOrigin: string): string | null {
  const canonical = origin(backendOrigin);
  return canonical?.startsWith("https:") ? `${canonical}/mobile/` : null;
}
