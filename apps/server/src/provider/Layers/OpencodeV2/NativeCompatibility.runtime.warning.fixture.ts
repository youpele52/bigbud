import { mkdir } from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { makeOwnedClient, type OpencodeV2Client } from "./Client.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import { bindV2NativeCompatibility } from "./NativeCompatibility.binding.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { sharedServiceTestRegistration } from "./SharedService.test.fixture.ts";
import { readV2SharedRegistration, v2SharedGeneration } from "./SharedService.registration.ts";
import { v2CanonicalApiFixture } from "./NativeCompatibility.api.fixture.ts";

/** Production verifier and private registration; health/API responses and native config
 * are synthetic. This owns no retail process and issues no native session/prompt. */
export async function withV2RuntimeWarningFixture(
  version: string,
  run: (fixture: {
    artifact: Awaited<ReturnType<typeof makeV2ThreadPluginFixture>>["artifact"];
    client: OpencodeV2Client;
    root: string;
    directory: string;
    contract: ReturnType<typeof v2CanonicalApiFixture>;
    config: ReturnType<typeof vi.fn<OpencodeV2Client["config"]["get"]>>;
    context: { operationGuard?: () => void; operationSignal?: AbortSignal };
    revoke: () => void;
  }) => Promise<void>,
) {
  const app = await makeV2ThreadPluginFixture(),
    registration = await sharedServiceTestRegistration({ version });
  const root = path.join(app.root, "native-global");
  await mkdir(root, { mode: 0o700 });
  const contract = v2CanonicalApiFixture();
  const fetch = Object.assign(
    vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const route = new URL(String(input)).pathname;
      if (!["/api/info", "/openapi.json"].includes(route))
        throw new Error("Unexpected synthetic health route");
      return new Response(
        JSON.stringify(route === "/api/info" ? { version, pid: registration.value.pid } : contract),
        { headers: { "content-type": "application/json" } },
      );
    }),
    { preconnect: () => {} },
  ) as unknown as typeof globalThis.fetch;
  vi.stubGlobal("fetch", fetch);
  const native = await readV2SharedRegistration(registration.file);
  const client = makeOwnedClient({
    endpoint: native.endpoint.url,
    password: native.endpoint.auth!.password,
    fetch,
  });
  const config = vi.fn<OpencodeV2Client["config"]["get"]>(async () => [
    { type: "directory", path: root },
  ]);
  client.config.get = config;
  let current = true;
  const assertCurrent = () => {
    if (!current) throw new Error("V2 consent revoked");
  };
  bindV2NativeCompatibility(client, {
    descriptor: {
      registrationFile: registration.file,
      generation: v2SharedGeneration(native),
      storageIdentity: "synthetic-only",
    },
    assertCurrent,
  });
  const context = {
    transport: registration.file,
    intent: "execute" as const,
    permit: {
      revision: 1,
      signal: new AbortController().signal,
      assertCurrent,
      assertNativeConfigRead: assertCurrent,
      release: () => {},
    },
  } as {
    transport: string;
    intent: "execute";
    permit: {
      revision: number;
      signal: AbortSignal;
      assertCurrent: () => void;
      assertNativeConfigRead: () => void;
      release: () => void;
    };
    operationGuard?: () => void;
    operationSignal?: AbortSignal;
  };
  try {
    await runV2RequestContext(context, () =>
      run({
        artifact: app.artifact,
        client,
        root,
        directory: app.root,
        contract,
        config,
        context,
        revoke: () => {
          current = false;
        },
      }),
    );
  } finally {
    vi.unstubAllGlobals();
    await registration.close();
    await app.close();
  }
}
