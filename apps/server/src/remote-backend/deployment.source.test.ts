import { generateKeyPairSync } from "node:crypto";

import { PINNED_RELEASE_TRUST_STORE } from "@bigbud/shared/releaseTrust";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeDeploymentGraphSourceResolver,
  RELEASE_GRAPH_VERSION_ENV,
} from "./deployment.source.ts";
import type { RemoteAgentInstallSource } from "../remote-agent/remoteAgentInstallManager.ts";

const PINNED = PINNED_RELEASE_TRUST_STORE["release-2026"]!;
const otherKey = () =>
  generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubReleaseGraph(keyId: string) {
  // Unsigned on purpose: only the trust selection before signature verification is under test.
  const manifest = JSON.stringify({ revision: 1, signature: { algorithm: "ed25519", keyId } });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL) =>
      Promise.resolve(
        new Response(
          String(url).endsWith(".sha256") ? `${"a".repeat(64)}  graph.tar.gz\n` : manifest,
        ),
      ),
    ),
  );
}

function resolve(rust: RemoteAgentInstallSource) {
  return makeDeploymentGraphSourceResolver({
    environment: { [RELEASE_GRAPH_VERSION_ENV]: "1.2.3" },
    loadRustSource: async () => rust,
  })("x86_64-unknown-linux-gnu", new AbortController().signal);
}

const rustSource = (trustStore: Record<string, string>, localTrustOverride?: true) =>
  ({
    manifest: { schemaVersion: 1, artifacts: [] },
    trustStore,
    ...(localTrustOverride ? { localTrustOverride } : {}),
  }) as RemoteAgentInstallSource;

describe("release backend graph trust", () => {
  it("refuses a release graph whose key is not pinned, even if the install source lists it", async () => {
    stubReleaseGraph("release-2026");
    await expect(resolve(rustSource({ "release-2026": otherKey() }))).rejects.toThrow(
      "signed by key 'release-2026', which this version of bigbud does not trust; update bigbud",
    );
    stubReleaseGraph("attacker");
    await expect(
      resolve(rustSource({ "release-2026": PINNED, attacker: otherKey() })),
    ).rejects.toThrow("signed by key 'attacker'");
  });

  it("passes the pinned key on to manifest signature verification", async () => {
    stubReleaseGraph("release-2026");
    await expect(resolve(rustSource({ "release-2026": PINNED }))).rejects.toThrow(
      "failed signature or target verification",
    );
  });

  it("keeps operator trust when the install source came from a local override", async () => {
    stubReleaseGraph("fixture");
    await expect(resolve(rustSource({ fixture: otherKey() }, true))).rejects.toThrow(
      "failed signature or target verification",
    );
  });
});
