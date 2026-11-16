import {
  prepareDownloadFixture,
  installCommand,
  manifest,
} from "./remoteAgentDownload.linux.fixtures.ts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

describe.runIf(linuxControlAvailable)(
  "manual download refuses oversized responses before publication",
  () => {
    let fixture: ReturnType<typeof createLinuxControlFixture>;
    afterEach(() => fixture?.close());
    for (const downloader of ["curl", "wget"]) {
      it.each(["metadata", "binary"])(
        `${downloader} rejects oversized %s and preserves current bytes`,
        async (kind) => {
          fixture = createLinuxControlFixture({ image: "node:24.13.1-bookworm" });
          await prepareDownloadFixture(
            fixture,
            downloader,
            `case "$*" in
  *install-source*) ${kind === "metadata" ? "head -c 4096 /dev/zero" : `printf '%s' '${manifest}'`} ;;
  *) head -c 4096 /dev/zero ;;
esac`,
          );
          await expect(fixture.run(installCommand)).rejects.toThrow("Could not download");
          expect(await fixture.run("cat /tmp/test-home/.bigbud/agent/bin/current")).toBe("working");
          expect(
            (
              await fixture.run(
                "find /tmp/test-home/.bigbud/agent/inbox -mindepth 1 -maxdepth 1 -printf '%f\\n'",
              )
            ).trim(),
          ).toBe(".claim.lock");
        },
      );
    }
  },
);
