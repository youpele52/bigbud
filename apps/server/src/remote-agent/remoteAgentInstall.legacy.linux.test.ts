import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRemoteAgentInstallPaths,
  buildRemoteAgentInstallScript,
} from "./remoteAgentInstall.ts";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

const targetTriple = "x86_64-unknown-linux-gnu" as const;
const bytes = Buffer.from("#!/bin/sh\nexit 0\n");
const artifact = {
  version: "0.2.207",
  buildDigest: "legacy-state-regression",
  protocolMajor: 1,
  protocolMinor: 2,
  targetTriple,
  sizeBytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  signature: { algorithm: "ed25519" as const, keyId: "test", value: "test" },
  bundledPath: "fixture",
};

describe.runIf(linuxControlAvailable)("remote agent legacy install boundary", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  afterEach(() => fixture?.close());

  it("installs a candidate without validating or creating the legacy state root", async () => {
    fixture = createLinuxControlFixture();
    const home = `${fixture.root}/home`;
    await fixture.run(`mkdir -p -m 700 '${home}'`);
    try {
      const script = buildRemoteAgentInstallScript({
        artifact,
        targetTriple,
        stagedBase64: bytes.toString("base64"),
        reservationId: "legacy-state-regression",
      });
      await fixture.runInput(`export HOME='${home}'; ${script.command}`, script.stdin);
      const installed = buildRemoteAgentInstallPaths(artifact).installedBinary.replace(
        "$HOME",
        home,
      );
      expect(await fixture.run(`sha256sum '${installed}' | cut -d ' ' -f1`)).toBe(
        `${artifact.sha256}\n`,
      );
      expect(await fixture.run(`test ! -e '${home}/.bigbud/agent/state' && printf absent`)).toBe(
        "absent",
      );
    } finally {
      await fixture.run(`rm -rf '${home}'`);
    }
  });
});
