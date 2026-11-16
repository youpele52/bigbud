import { useState } from "react";
import { useMobileHosts } from "../../context/MobileHostsContext";
import { mobileHostNavigationURL } from "../../logic/mobileDeploymentPolicy";
import { Button } from "../ui/button";
import { MobileCard, MobileMuted, MobilePage, MobileTitle } from "./MobileShell";

/** A host-served app navigates between origins; it never transfers a pairing/session secret. */
export function MobileCrossHostNavigation({ backendOrigin }: { backendOrigin: string }) {
  const context = useMobileHosts();
  const [notice, setNotice] = useState<string | null>(null);
  const destination = mobileHostNavigationURL(backendOrigin);
  function remember() {
    const known = context?.hosts.value.collection.entries.find(
      (entry) => entry.backendOrigin === backendOrigin,
    )?.pin.authority.authorityId;
    const saved = context?.directory.remember({
      backendOrigin,
      ...(known ? { authorityId: known } : {}),
    });
    setNotice(
      saved
        ? "Host link remembered without credentials."
        : "Could not save this host link. Existing data was kept.",
    );
  }
  return (
    <MobilePage className="min-w-0">
      <MobileCard className="min-w-0">
        <MobileTitle>Open the host's own mobile app</MobileTitle>
        <MobileMuted className="mt-2 [overflow-wrap:anywhere]">{backendOrigin}</MobileMuted>
        <p className="mt-3 text-sm">
          This app keeps credentials on their own origin. Continue to the other host and pair there
          if needed. No existing session or pairing secret is transferred.
        </p>
        {destination ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <a
              className="inline-flex min-h-11 items-center rounded-md bg-primary px-3 text-sm text-primary-foreground"
              href={destination}
              referrerPolicy="no-referrer"
            >
              Open host mobile app
            </a>
            {context ? (
              <Button className="min-h-11" variant="outline" onClick={remember}>
                Remember host link
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-warning">
            Open this host's private HTTPS mobile address to pair there.
          </p>
        )}
        {notice ? (
          <p className="mt-2 text-xs text-muted-foreground" role="status">
            {notice}
          </p>
        ) : null}
      </MobileCard>
    </MobilePage>
  );
}
