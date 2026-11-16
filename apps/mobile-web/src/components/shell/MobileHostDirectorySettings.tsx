import { MobileHostDestination } from "./MobileHostDestination";
import { useState } from "react";
import { useMobileHosts } from "../../context/MobileHostsContext";
import { canonicalMobileHostOrigin } from "../../lib/mobileHostSessions.logic";
import { mobileHostNavigationURL } from "../../logic/mobileDeploymentPolicy";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function MobileHostDirectorySettings() {
  const context = useMobileHosts();
  const [origin, setOrigin] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  if (!context) return null;
  const entries = context.directory.state.ok ? context.directory.state.entries : [];
  function remember() {
    const canonical = canonicalMobileHostOrigin(origin.trim());
    if (!canonical) {
      setNotice("Enter an HTTPS origin without a path, query or credentials.");
      return;
    }
    const saved = context?.directory.remember({ backendOrigin: canonical });
    setNotice(
      saved
        ? "Host link remembered. Pairing stays on that host's origin."
        : "Could not save the link. Existing data was kept.",
    );
    if (saved) setOrigin("");
  }
  return (
    <section className="grid min-w-0 gap-2 border-t border-border pt-3" aria-label="Host links">
      <h2 className="text-sm font-semibold">Host links</h2>
      <p className="text-xs text-muted-foreground">
        These links contain no credentials. Opening a host navigates to its own mobile app.
      </p>
      <label className="grid min-w-0 gap-1 text-xs" htmlFor="mobile-host-link-origin">
        Private HTTPS origin
        <Input
          id="mobile-host-link-origin"
          className="min-h-11 text-sm [&_input]:min-h-11"
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
          placeholder="https://host.example"
          autoComplete="off"
        />
      </label>
      <Button className="min-h-11" variant="outline" onClick={remember}>
        Remember host link
      </Button>
      {entries.map((entry) => (
        <div className="flex min-w-0 flex-wrap items-center gap-2" key={entry.backendOrigin}>
          <a
            className="inline-flex min-h-11 min-w-0 flex-1 items-center break-words text-sm underline"
            href={mobileHostNavigationURL(entry.backendOrigin) ?? undefined}
            referrerPolicy="no-referrer"
          >
            <MobileHostDestination origin={entry.backendOrigin} label={entry.displayName} />
          </a>
          <button
            className="min-h-11 rounded-md px-2 text-sm text-muted-foreground"
            type="button"
            onClick={() => {
              if (!context.directory.forget(entry.backendOrigin))
                setNotice("Could not remove the link. Existing data was kept.");
            }}
            aria-label={`Remove link ${entry.backendOrigin}`}
          >
            Remove link
          </button>
        </div>
      ))}
      {!context.directory.state.ok ? (
        <p role="alert" className="text-xs text-warning">
          Saved host links could not be read and were not changed.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
