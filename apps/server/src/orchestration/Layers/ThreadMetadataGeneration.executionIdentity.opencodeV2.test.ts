import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CredentialEntry, IntegrationInfo, ProviderInfo } from "@opencode/client";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { makeTestSettings } from "../../ws/serverSettings.testing.ts";
import { V2ConsentAuthority } from "../../provider/Layers/OpencodeV2/Application.consent.ts";
import { currentV2RequestContext } from "../../provider/Layers/OpencodeV2/Client.guard.ts";
import {
  opencodeV2MetadataIdentity,
  v2MetadataCredentialScope,
} from "./ThreadMetadataGeneration.executionIdentity.opencodeV2.ts";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../provider/Layers/OpencodeV2/TextGeneration.connection.ts", () => ({
  connectV2TextGeneration: mocks.connect,
}));
const selection = {
  provider: "opencodeV2",
  subProviderID: "provider-A",
  model: "model-A",
} as const;
function evidence() {
  const provider: ProviderInfo = {
    id: "provider-A",
    integrationID: "integration-A",
    name: "Synthetic",
    activation: "enabled",
    package: "synthetic",
  };
  const integration: IntegrationInfo = {
    id: "integration-A",
    name: "Synthetic",
    methods: [],
    connections: [{ type: "credential", id: "credential-A", label: "Synthetic", method: "key" }],
  };
  const credentials: CredentialEntry[] = [
    {
      id: "credential-A",
      integrationID: "integration-A",
      label: "Synthetic",
      active: true,
      value: { type: "key", key: "synthetic-secret" },
    },
  ];
  return { provider, integration, credentials };
}

describe("V2 public metadata identity", () => {
  it.each(["env", "duplicate", "missing", "headers", "settings", "canonical"])(
    "rejects ambiguous %s credential execution",
    (scenario) => {
      const e = evidence();
      if (scenario === "env")
        e.integration.connections.push({ type: "env", name: "SYNTHETIC_KEY" });
      if (scenario === "duplicate") e.credentials.push({ ...e.credentials[0]!, id: "other" });
      if (scenario === "missing") e.credentials.length = 0;
      if (scenario === "headers") e.provider.headers = { Authorization: "override" };
      if (scenario === "settings") e.provider.settings = { apiKey: "override" };
      if (scenario === "canonical") e.provider.canonical = "other-provider";
      expect(v2MetadataCredentialScope(e.provider, e.integration, e.credentials)).toBeNull();
    },
  );

  it("binds public provider/integration/credential APIs to canonical workspace and active consent", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "bigbud-v2-identity-")));
    const serviceFile = join(directory, "synthetic-service.json");
    await writeFile(serviceFile, "Synthetic only; native connector is mocked.");
    const settings = await Effect.runPromise(
      makeTestSettings({
        providers: {
          opencodeV2: { enabled: true, serviceFile, nativeServiceTrust: "host-user-v1" },
        },
      }),
    );
    const consent = new V2ConsentAuthority(settings);
    const e = evidence();
    const close = vi.fn(async () => {});
    const provider = vi.fn(async () => ({ location: { directory }, data: e.provider }));
    const integration = vi.fn(async () => ({ location: { directory }, data: e.integration }));
    const credential = vi.fn(async () => e.credentials);
    mocks.connect.mockReset().mockImplementation(async (transport: string) => {
      expect(transport).toBe(serviceFile);
      expect(currentV2RequestContext()?.intent).toBe("execute");
      return {
        client: {
          provider: { get: provider },
          integration: { get: integration },
          credential: { list: credential },
        },
        descriptor: { generation: "synthetic-generation" },
        close,
      };
    });
    const capture = () => {
      const snapshot = settings.currentSnapshot?.();
      if (!snapshot) throw new Error("Synthetic settings snapshot unavailable");
      return opencodeV2MetadataIdentity(
        selection,
        snapshot.settings.providers,
        {},
        directory,
        consent,
        new AbortController().signal,
      );
    };
    try {
      const original = await capture();
      expect(original?.accountIdentity).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(original)).not.toContain("synthetic-secret");
      expect(provider).toHaveBeenCalledWith(
        { providerID: "provider-A", location: { directory } },
        expect.any(Object),
      );
      expect(integration).toHaveBeenCalledWith(
        { integrationID: "integration-A", location: { directory } },
        expect.any(Object),
      );
      e.credentials[0]!.value = { type: "key", key: "rotated-secret" };
      expect((await capture())?.accountIdentity).not.toBe(original?.accountIdentity);
      provider.mockResolvedValueOnce({ location: { directory: "/wrong" }, data: e.provider });
      expect(await capture()).toBeNull();
      credential.mockRejectedValueOnce(new Error("Synthetic unavailable public API"));
      await expect(capture()).rejects.toThrow();
      expect(close).toHaveBeenCalledTimes(4);
      await Effect.runPromise(
        settings.updateSettings({ providers: { opencodeV2: { nativeServiceTrust: null } } }),
      );
      expect(await capture()).toBeNull();
      expect(mocks.connect).toHaveBeenCalledTimes(4);
    } finally {
      consent.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
