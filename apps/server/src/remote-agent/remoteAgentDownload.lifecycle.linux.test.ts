import { afterEach, describe, expect, it } from "vitest";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";
import {
  prepareDownloadFixture,
  installCommand,
  manifest,
  payloadSha,
} from "./remoteAgentDownload.linux.fixtures.ts";

describe.runIf(linuxControlAvailable)("manual download complete-script lifecycle", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  afterEach(() => fixture?.close());
  for (const downloader of ["curl", "wget"]) {
    it(`${downloader} publishes only complete bytes and preserves the working build`, async () => {
      fixture = createLinuxControlFixture({ image: "node:24.13.1-bookworm" });
      await prepareDownloadFixture(
        fixture,
        downloader,
        `case "$*" in *install-source*) printf '%s' '${manifest}';; *) printf x;; esac`,
      );
      await fixture.run(installCommand);
      expect(
        await fixture.run(
          `cat /tmp/test-home/.bigbud/agent/inbox/${payloadSha}/bigbud-remote-agent /tmp/test-home/.bigbud/agent/bin/current`,
        ),
      ).toBe("xworking");
      await fixture.run(installCommand); // Already verified inbox is idempotent.
    });
    it(`${downloader} rejects a valid-looking partial response with a failed transport`, async () => {
      fixture = createLinuxControlFixture({ image: "node:24.13.1-bookworm" });
      await prepareDownloadFixture(
        fixture,
        downloader,
        `case "$*" in *install-source*) printf '%s' '${manifest}';; *) printf x; exit 7;; esac`,
      );
      await expect(fixture.run(installCommand)).rejects.toThrow("Could not download");
      expect(
        (
          await fixture.run(
            "find /tmp/test-home/.bigbud/agent/inbox -mindepth 1 -maxdepth 1 -printf '%f\\n'",
          )
        ).trim(),
      ).toBe(".claim.lock");
      expect(await fixture.run("cat /tmp/test-home/.bigbud/agent/bin/current")).toBe("working");
    });
    it(`${downloader} settles its downloader and removes owned partials on cancellation`, async () => {
      fixture = createLinuxControlFixture({ image: "node:24.13.1-bookworm" });
      await prepareDownloadFixture(
        fixture,
        downloader,
        'printf "%s" "$$" > /tmp/downloader.pid; exec sleep 30',
      );
      await fixture.run(`${installCommand} >/tmp/download.out 2>&1 & echo $! >/tmp/script.pid`);
      await fixture.run(
        'while [ ! -s /tmp/downloader.pid ]; do sleep 0.02; done; kill -TERM "$(cat /tmp/script.pid)"',
      );
      await fixture.run(
        'n=0; while [ -e /tmp/test-home/.bigbud/agent/inbox/.download.lock ]; do n=$((n + 1)); [ "$n" -lt 100 ] || exit 1; sleep 0.02; done',
      );
      expect(
        (
          await fixture.run(
            "find /tmp/test-home/.bigbud/agent/inbox -mindepth 1 -maxdepth 1 -printf '%f\\n'",
          )
        ).trim(),
      ).toBe(".claim.lock");
      await fixture.run('! kill -0 "$(cat /tmp/downloader.pid)" 2>/dev/null');
      expect(await fixture.run("cat /tmp/test-home/.bigbud/agent/bin/current")).toBe("working");
    });
  }
});
