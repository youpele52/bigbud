import type { CliProxyVersion } from "@bigbud/contracts/server/server.providers.ts";

import { useBannerDismissal } from "../../stores/ui/useBannerDismissal";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { ChatBanner } from "../chat/common/ChatBanner";
import { StatusBanner } from "../common/StatusBanner";
import { Button } from "../ui/button";
import { cliProxyUpdateMessage } from "./CliProxyVersionNotice.logic";

export function CliProxyVersionNotice({
  version,
  placement = "settings",
  onCheckAgain,
  checking = false,
}: {
  readonly version: CliProxyVersion | undefined;
  readonly placement?: "chat" | "settings";
  readonly onCheckAgain?: (() => void) | undefined;
  readonly checking?: boolean | undefined;
}) {
  const { dismissed, dismiss } = useBannerDismissal(
    version ? ["provider-update", "cliProxy", version.recommendedVersion] : undefined,
  );
  const message = version ? cliProxyUpdateMessage(version) : null;
  if (!version || !message || dismissed) return null;
  const Banner = placement === "chat" ? ChatBanner : StatusBanner;
  return (
    <Banner
      variant="warning"
      role="status"
      title="CLIProxyAPI update recommended"
      description={
        <div className="space-y-2 text-sm">
          <p>{message}</p>
          <details>
            <summary className="cursor-pointer text-xs">Manual update guidance</summary>
            <div className="mt-2 space-y-2 text-xs">
              {version.installation === "homebrew" ? (
                <p>
                  A Homebrew installation was detected. To update that binary manually, run{" "}
                  <code>brew upgrade cliproxyapi</code>. If you manage the connected server with
                  Homebrew, wait until active requests finish before running{" "}
                  <code>brew services restart cliproxyapi</code>.
                </p>
              ) : (
                <p>
                  Update using your installation method or ask the service owner. Wait until active
                  requests finish before restarting the connected server.
                </p>
              )}
              <p>
                Updating an installed binary does not change an already-running server. bigbud does
                not update or restart CLIProxyAPI automatically. This baseline is a recommendation,
                not a live compatibility test.
              </p>
            </div>
          </details>
        </div>
      }
      action={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void ensureNativeApi()
                .shell.openExternal("https://github.com/router-for-me/CLIProxyAPI/releases")
                .catch((error: unknown) =>
                  console.warn("Failed to open CLIProxyAPI releases", error),
                );
            }}
          >
            Release notes
          </Button>
          {onCheckAgain ? (
            <Button variant="outline" size="sm" disabled={checking} onClick={onCheckAgain}>
              {checking ? "Checking..." : "Check again"}
            </Button>
          ) : null}
        </>
      }
      dismissLabel="Dismiss CLIProxyAPI update recommendation"
      onDismiss={dismiss}
    />
  );
}
