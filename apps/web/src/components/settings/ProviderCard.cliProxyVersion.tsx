import { CLIPROXY_RECOMMENDED_VERSION } from "@bigbud/contracts/constants/cliProxy.constant.ts";
import type { CliProxyVersion } from "@bigbud/contracts/server/server.providers.ts";

import { CliProxyVersionNotice } from "../provider/CliProxyVersionNotice";

export function CliProxyVersionDetails({
  version,
  onCheckAgain,
  checking,
}: {
  readonly version: CliProxyVersion | undefined;
  readonly onCheckAgain?: (() => void) | undefined;
  readonly checking?: boolean | undefined;
}) {
  return (
    <div className="space-y-2 px-4 pb-3 sm:px-5">
      <p className="text-xs text-muted-foreground">
        Connected server version: {version?.runtimeVersion ?? "could not be verified"}. Installed
        PATH binary: {version?.installedVersion ?? "unknown"}. Recommended baseline:{" "}
        {version?.recommendedVersion ?? CLIPROXY_RECOMMENDED_VERSION}.
      </p>
      <CliProxyVersionNotice version={version} onCheckAgain={onCheckAgain} checking={checking} />
    </div>
  );
}
