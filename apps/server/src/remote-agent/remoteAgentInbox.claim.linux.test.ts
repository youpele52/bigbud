import { artifact } from "./remoteAgentInstallManager.fixtures.ts";
import { payloadSha } from "./remoteAgentDownload.linux.fixtures.ts";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRemoteAgentInboxPromotionBody,
  buildRemoteAgentInboxAdoptionScript,
} from "./remoteAgentInstall.inbox.ts";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

const script = readFileSync(
  new URL("../../../marketing/public/remote-agent.sh", import.meta.url),
  "utf8",
);
const scriptClaim = script.slice(
  script.indexOf("# Shared with app adoption"),
  script.indexOf("\nlock="),
);
const partialCheck = script.slice(
  script.indexOf("for partial in"),
  script.indexOf("work=$(mktemp"),
);
const promotion = buildRemoteAgentInboxPromotionBody({
  version: "1",
  sha256: "a".repeat(64),
  sizeBytes: 1,
});
const appClaim = promotion.slice(
  promotion.indexOf("inbox_root="),
  promotion.indexOf('if [ -e "$installed"'),
);

describe.runIf(linuxControlAvailable)("manual script and app inbox admission", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  afterEach(() => fixture?.close());
  it.each([
    [scriptClaim, appClaim],
    [appClaim, scriptClaim],
  ])("serializes script and app claim in both directions", async (holder, contender) => {
    fixture = createLinuxControlFixture({ image: "node:24.13.1-bookworm" });
    await fixture.run("mkdir -p /tmp/inbox-test/inbox");
    const prefix = 'set -eu; root=/tmp/inbox-test; inbox=$root/inbox; fail() { exit "$1"; }; ';
    // Keep the first FD alive in the same shell while a separate shell contends.
    await fixture.runInput("cat > /tmp/contender.sh", `${prefix}\n${contender}`);
    expect(
      await fixture.run(
        `${prefix}\n${holder}\nsh /tmp/contender.sh >/dev/null 2>&1 && exit 99; printf rejected`,
      ),
    ).toBe("rejected");
    // Both locks release on process exit, including a failed adoption/download.
    await fixture.run(`${prefix}\n${contender}`);
  });
  it("reuses valid managed bytes without a pre-existing inbox through complete adoption", async () => {
    fixture = createLinuxControlFixture({ image: "node:24.13.1-bookworm" });
    const selected = { ...artifact, version: "1", sha256: payloadSha, sizeBytes: 1 };
    const path = `/tmp/reuse-home/.bigbud/agent/bin/1/${payloadSha}/bigbud-remote-agent`;
    await fixture.run(
      `umask 077; mkdir -p /tmp/reuse-home/.bigbud/agent/bin/1/${payloadSha}; printf x > ${path}; chmod 700 ${path}; test ! -e /tmp/reuse-home/.bigbud/agent/inbox`,
    );
    const script = buildRemoteAgentInboxAdoptionScript({
      artifact: selected,
      targetTriple: selected.targetTriple,
    });
    await fixture.run(`HOME=/tmp/reuse-home\n${script.command}`);
    expect(await fixture.run(`cat ${path}`)).toBe("x");
    expect(await fixture.run(`stat -c '%a' ${path}`)).toBe("700\n");
  });

  it("refuses stale partials without deleting them or a working installation", async () => {
    fixture = createLinuxControlFixture({ image: "node:24.13.1-bookworm" });
    await fixture.run(
      "mkdir -p /tmp/inbox-test/.partial.dead; printf working > /tmp/current-build; printf partial > /tmp/inbox-test/.partial.dead/bytes",
    );
    await expect(
      fixture.run(
        `inbox=/tmp/inbox-test; fail() { printf '%s' "$*" >&2; exit "$1"; }; ${partialCheck}`,
      ),
    ).rejects.toThrow("interrupted download");
    expect(await fixture.run("cat /tmp/current-build /tmp/inbox-test/.partial.dead/bytes")).toBe(
      "workingpartial",
    );
  });
});
