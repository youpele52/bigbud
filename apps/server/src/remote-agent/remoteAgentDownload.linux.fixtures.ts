import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createLinuxControlFixture } from "./remoteAgentUpgrade.linux.fixtures.ts";

const source = readFileSync(
  new URL("../../../../scripts/release-assets/remote-agent.sh", import.meta.url),
  "utf8",
);
export const payloadSha = createHash("sha256").update("x").digest("hex");
export const manifest = JSON.stringify({
  artifacts: ["aarch64", "x86_64"].map((arch) => ({
    targetTriple: `${arch}-unknown-linux-musl`,
    sizeBytes: 1,
    sha256: payloadSha,
  })),
});
export const installCommand =
  "HOME=/tmp/test-home PATH=/tmp/test-bin BIGBUD_AGENT_VERSION=1 /bin/sh /tmp/install.sh";
/** Same script without the BIGBUD_AGENT_VERSION override, for release-stamped copies. */
export const stampedInstallCommand =
  "HOME=/tmp/test-home PATH=/tmp/test-bin /bin/sh /tmp/install.sh";
export async function prepareDownloadFixture(
  fixture: ReturnType<typeof createLinuxControlFixture>,
  downloader: string,
  body: string,
  options: { readonly stampedVersion?: string } = {},
) {
  // Mirrors release.yml, which stamps exactly this line in the published copy.
  const stamped =
    options.stampedVersion === undefined
      ? source
      : source.replace(/^DEFAULT_VERSION=""/m, `DEFAULT_VERSION="${options.stampedVersion}"`);
  await fixture.runInput(
    "cat > /tmp/install.sh",
    stamped
      .replace("MAX_AGENT_BYTES=67108864", "MAX_AGENT_BYTES=2048")
      .replace("MAX_METADATA_BYTES=1048576", "MAX_METADATA_BYTES=1024"),
  );
  // Fixed paths: on a Linux host (no per-test container) each test must start from a clean slate.
  await fixture.run(`rm -rf /tmp/test-bin /tmp/test-home /tmp/downloader.pid /tmp/script.pid /tmp/download.out; mkdir -p /tmp/test-bin /tmp/test-home/.bigbud/agent/bin; chmod 700 /tmp/test-home/.bigbud/agent; printf working > /tmp/test-home/.bigbud/agent/bin/current
for tool in uname sha256sum awk mktemp stat head mkfifo wc flock id mkdir rmdir rm grep tr chmod mv cat sleep; do ln -s "$(command -v "$tool")" "/tmp/test-bin/$tool"; done`);
  await fixture.runInput(`cat > /tmp/test-bin/${downloader}`, `#!/bin/sh\n${body}\n`);
  await fixture.run(`chmod 700 /tmp/test-bin/${downloader}`);
}
