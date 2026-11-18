import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PINNED_RELEASE_TRUST_STORE } from "@bigbud/shared/releaseTrust";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadRemoteAgentInstallSource } from "./remoteAgentInstallSource.ts";

const PINNED = PINNED_RELEASE_TRUST_STORE["release-2026"]!;
const otherKey = () =>
  generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

function sourceJson(trustStore: Record<string, string>, keyId = "release-2026", extra = {}) {
  return JSON.stringify({
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
          signature: { algorithm: "ed25519", keyId, value: "signature" },
          url: "https://example.com/agent",
        },
      ],
    },
    trustStore,
    ...extra,
  });
}

function load(environment: NodeJS.ProcessEnv, body: string) {
  const fetch = vi.fn(async () => new Response(body));
  return loadRemoteAgentInstallSource(environment, {
    fetch: fetch as unknown as typeof globalThis.fetch,
    logger: () => undefined,
  });
}

const RELEASE = { BIGBUD_REMOTE_AGENT_RELEASE_VERSION: "1.2.3" };

describe("install source release key pinning", () => {
  it("reduces the default release trust store to the pinned key", async () => {
    const source = await load(
      RELEASE,
      sourceJson({ "release-2026": PINNED.replaceAll("\n", "\r\n"), extra: otherKey() }),
    );
    expect(source.trustStore).toEqual({ "release-2026": PINNED });
    expect(source.localTrustOverride).toBeUndefined();
  });

  it("rejects a default release whose pinned id carries a different key", async () => {
    await expect(load(RELEASE, sourceJson({ "release-2026": otherKey() }))).rejects.toThrow(
      "Release manifest is signed by key 'release-2026', which this version of bigbud does not trust; update bigbud.",
    );
  });

  it("rejects a default release signed by an unpinned key id", async () => {
    const body = sourceJson({ "release-2026": PINNED, "release-2099": otherKey() }, "release-2099");
    await expect(load({}, body)).rejects.toThrow("signed by key 'release-2099'");
  });

  it("does not let downloaded content claim a local trust override", async () => {
    const body = sourceJson({ "release-2026": otherKey() }, "release-2026", {
      localTrustOverride: true,
      allowUntrustedDevelopmentArtifact: true,
    });
    await expect(load(RELEASE, body)).rejects.toThrow("does not trust");
  });

  it("keeps operator trust for an explicit install-source URL", async () => {
    const key = otherKey();
    const source = await load(
      { BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_URL: "https://fixtures.example/source.json" },
      sourceJson({ fixture: key }, "fixture"),
    );
    expect(source.trustStore).toEqual({ fixture: key });
    expect(source.localTrustOverride).toBe(true);
  });

  it("keeps operator trust for an explicit install-source file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bigbud-agent-source-trust-"));
    directories.push(directory);
    const path = join(directory, "source.json");
    const key = otherKey();
    await writeFile(path, sourceJson({ fixture: key }, "fixture"));
    const source = await loadRemoteAgentInstallSource({
      BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH: path,
    });
    expect(source.trustStore).toEqual({ fixture: key });
    expect(source.localTrustOverride).toBe(true);
  });
});
