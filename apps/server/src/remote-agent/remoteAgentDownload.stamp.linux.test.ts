import { afterEach, describe, expect, it } from "vitest";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";
import {
  installCommand,
  manifest,
  payloadSha,
  prepareDownloadFixture,
  stampedInstallCommand,
} from "./remoteAgentDownload.linux.fixtures.ts";

const recordingDownloader = `printf '%s\\n' "$*" >> /tmp/urls
case "$*" in *install-source*) printf '%s' '${manifest}';; *) printf x;; esac`;

describe.runIf(linuxControlAvailable)("manual download with a release-stamped script", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  afterEach(() => fixture?.close());

  it("uses the stamped version when BIGBUD_AGENT_VERSION is unset", async () => {
    fixture = createLinuxControlFixture({ image: "node:24.13.1-bookworm" });
    await prepareDownloadFixture(fixture, "curl", recordingDownloader, { stampedVersion: "1" });
    await fixture.run("rm -f /tmp/urls");
    await fixture.run(stampedInstallCommand);
    expect(await fixture.run("cat /tmp/urls")).toContain("/releases/download/v1/");
    expect(
      await fixture.run(`cat /tmp/test-home/.bigbud/agent/inbox/${payloadSha}/bigbud-remote-agent`),
    ).toBe("x");
  });

  it("accepts a matching BIGBUD_AGENT_VERSION", async () => {
    fixture = createLinuxControlFixture({ image: "node:24.13.1-bookworm" });
    await prepareDownloadFixture(fixture, "curl", recordingDownloader, { stampedVersion: "1" });
    await fixture.run(installCommand);
    expect(
      await fixture.run(`cat /tmp/test-home/.bigbud/agent/inbox/${payloadSha}/bigbud-remote-agent`),
    ).toBe("x");
  });

  it("refuses a BIGBUD_AGENT_VERSION that differs from the stamp before downloading", async () => {
    fixture = createLinuxControlFixture({ image: "node:24.13.1-bookworm" });
    await prepareDownloadFixture(fixture, "curl", recordingDownloader, { stampedVersion: "2" });
    await fixture.run("rm -f /tmp/urls");
    await expect(fixture.run(installCommand)).rejects.toThrow(
      "does not match this script's release 2",
    );
    expect((await fixture.run("test -e /tmp/urls && echo fetched || echo none")).trim()).toBe(
      "none",
    );
    expect(await fixture.run("cat /tmp/test-home/.bigbud/agent/bin/current")).toBe("working");
  });

  it("asks for a channel link when neither a stamp nor the env var is set", async () => {
    fixture = createLinuxControlFixture({ image: "node:24.13.1-bookworm" });
    await prepareDownloadFixture(fixture, "curl", recordingDownloader);
    await expect(fixture.run(stampedInstallCommand)).rejects.toThrow(
      "https://bigbud.app/download/<channel>/remote-agent",
    );
  });
});
