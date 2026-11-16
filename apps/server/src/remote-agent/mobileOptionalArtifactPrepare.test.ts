import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { MobileOptionalArtifact } from "@bigbud/contracts/server/mobileOptionalArtifact";
import { canonicalizeMobileOptionalArtifact } from "@bigbud/shared/mobileOptionalArtifact";

import { prepareMobileOptionalArtifacts } from "./mobileOptionalArtifactPrepare.ts";

const keys = generateKeyPairSync("ed25519");
const bytes = Buffer.from("optional component fixture");
const compatibility = {
  agentVersion: "1",
  backendVersion: "2",
  gatewayVersion: "3",
  mobileAssetVersion: "4",
  minimumMobileRpcRevision: 1,
  maximumMobileRpcRevision: 1,
};
function fixture(kind: "mobile-gateway" | "mobile-assets"): MobileOptionalArtifact {
  const artifact: MobileOptionalArtifact = {
    schemaVersion: 1,
    ...(kind === "mobile-gateway"
      ? { kind, format: "executable", targetTriple: "aarch64-unknown-linux-musl" }
      : { kind, format: "tar.gz", targetTriple: "portable" }),
    compatibility,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: `https://github.com/bigbud/releases/${kind}`,
    signature: { algorithm: "ed25519", keyId: "test", value: "" },
  };
  return {
    ...artifact,
    signature: {
      ...artifact.signature,
      value: sign(
        null,
        Buffer.from(canonicalizeMobileOptionalArtifact(artifact)),
        keys.privateKey,
      ).toString("base64"),
    },
  };
}
function input() {
  return {
    mobileConsent: true,
    gateway: fixture("mobile-gateway"),
    assets: fixture("mobile-assets"),
    trustedKeys: { test: keys.publicKey.export({ type: "spki", format: "pem" }).toString() },
    host: {
      targetTriple: "aarch64-unknown-linux-musl" as const,
      agentVersion: "1",
      backendVersion: "2",
      mobileRpcRevision: 1,
    },
  };
}
function resign(artifact: MobileOptionalArtifact): MobileOptionalArtifact {
  return {
    ...artifact,
    signature: {
      ...artifact.signature,
      value: sign(
        null,
        Buffer.from(canonicalizeMobileOptionalArtifact(artifact)),
        keys.privateKey,
      ).toString("base64"),
    },
  };
}
const logger = () => {};
function response() {
  return new Response(bytes, { headers: { "Content-Length": String(bytes.length) } });
}

it("makes zero network calls and does not inspect artifacts without explicit mobile consent", async () => {
  const fetch = vi.fn();
  const refused = {
    ...input(),
    mobileConsent: false,
    get gateway(): never {
      throw new Error("must not inspect");
    },
  };
  expect(await prepareMobileOptionalArtifacts(refused, { fetch })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it("verifies BOTH signatures before fetching either component", async () => {
  const fetch = vi.fn();
  const request = input();
  request.assets = { ...request.assets, url: "https://github.com/bigbud/releases/replaced" };
  await expect(prepareMobileOptionalArtifacts(request, { fetch })).rejects.toThrow(/signature/);
  expect(fetch).not.toHaveBeenCalled();
});
it("refuses incompatible host before any download", async () => {
  const fetch = vi.fn();
  const request = input();
  request.host.backendVersion = "other";
  await expect(prepareMobileOptionalArtifacts(request, { fetch })).rejects.toThrow(/incompatible/);
  expect(fetch).not.toHaveBeenCalled();
});
it("reuses bounded transport and returns verified components without activation", async () => {
  const fetch = vi.fn(async () => response());
  const result = await prepareMobileOptionalArtifacts(input(), { fetch, logger });
  expect(result?.map((entry) => entry.artifact.kind)).toEqual(["mobile-gateway", "mobile-assets"]);
  expect(result?.every((entry) => Buffer.from(entry.bytes).equals(bytes))).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("does not fetch assets after gateway hash verification fails", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(Buffer.alloc(bytes.length), {
        headers: { "Content-Length": String(bytes.length) },
      }),
  );
  await expect(prepareMobileOptionalArtifacts(input(), { fetch, logger })).rejects.toThrow(
    /SHA-256/,
  );
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("honors an already aborted caller before IO", async () => {
  const fetch = vi.fn();
  const signal = AbortSignal.abort(new Error("cancelled"));
  await expect(prepareMobileOptionalArtifacts({ ...input(), signal }, { fetch })).rejects.toThrow(
    "cancelled",
  );
  expect(fetch).not.toHaveBeenCalled();
});
it("refuses a validly signed mixed release pair before network", async () => {
  const fetch = vi.fn();
  const request = input();
  request.assets = resign({
    ...request.assets,
    compatibility: {
      ...compatibility,
      gatewayVersion: "other-release",
    },
  });
  await expect(prepareMobileOptionalArtifacts(request, { fetch })).rejects.toThrow(/incompatible/);
  expect(fetch).not.toHaveBeenCalled();
});
it("checks both source URLs against existing release policy before either download", async () => {
  const fetch = vi.fn();
  const request = input();
  request.assets = resign({ ...request.assets, url: "https://unapproved.example/assets" });
  await expect(prepareMobileOptionalArtifacts(request, { fetch })).rejects.toThrow(/not approved/);
  expect(fetch).not.toHaveBeenCalled();
});
it("does not download assets after cancellation during the gateway response", async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async () => {
    controller.abort(new Error("cancelled during fetch"));
    return response();
  });
  await expect(
    prepareMobileOptionalArtifacts(
      { ...input(), signal: controller.signal },
      {
        fetch,
        logger,
      },
    ),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("pins decoded metadata across an asynchronous caller mutation", async () => {
  const request = input();
  const originalUrl = request.assets.url;
  const fetch = vi.fn(async () => {
    request.assets = resign({ ...request.assets, url: "https://github.com/other/assets" });
    return response();
  });
  const prepared = await prepareMobileOptionalArtifacts(request, { fetch, logger });
  expect(prepared?.[1]?.artifact.url).toBe(originalUrl);
});
