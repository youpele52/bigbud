import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadRemoteAgentInstallSource } from "./remoteAgentInstallSource.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function installSource() {
  return {
    manifest: {
      schemaVersion: 1,
      artifacts: [
        {
          version: "1.2.3",
          buildDigest: "build-1.2.3",
          protocolMajor: 1,
          protocolMinor: 0,
          targetTriple: "x86_64-unknown-linux-gnu",
          sizeBytes: 5,
          sha256: "a".repeat(64),
          signature: { algorithm: "ed25519", keyId: "release-2026", value: "signature" },
          url: "https://example.com/agent",
        },
      ],
    },
    trustStore: { "release-2026": "public-key" },
  };
}

describe("remote agent install source", () => {
  it("loads an explicit development or packaged source file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bigbud-agent-source-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "remote-agent-install-source.json");
    await writeFile(path, JSON.stringify(installSource()));

    const source = await loadRemoteAgentInstallSource({
      BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH: path,
    });

    expect(source.manifest.artifacts[0]?.version).toBe("1.2.3");
    expect(source.trustStore["release-2026"]).toBe("public-key");
  });

  it("rejects an invalid release repository before making a request", async () => {
    await expect(
      loadRemoteAgentInstallSource({ BIGBUD_REMOTE_AGENT_RELEASE_REPOSITORY: "invalid" }),
    ).rejects.toThrow("owner/repository");
  });

  it("uses the checksummed release manifest only for unpackaged desktop development", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(installSource().manifest), {
          status: 200,
          headers: { "content-length": "500" },
        }),
      );
    vi.stubGlobal("fetch", request);

    const source = await loadRemoteAgentInstallSource({ BIGBUD_DESKTOP_PACKAGED: "0" });

    expect(source.allowUntrustedDevelopmentArtifact).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1]?.[0])).toContain("remote-agent-manifest.json");
  });

  it("explains how to recover when the development release is not published", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    await expect(loadRemoteAgentInstallSource({ BIGBUD_DESKTOP_PACKAGED: "0" })).rejects.toThrow(
      "Publish the matching release",
    );
  });
});
