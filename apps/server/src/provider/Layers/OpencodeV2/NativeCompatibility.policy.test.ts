import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpencodeV2Client } from "./Client.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2SyntheticNativeEligibility } from "./NativeCompatibility.runtime.fixture.ts";
import { assertV2NativeRuntimePolicy } from "./NativeCompatibility.policy.ts";
import { projectV2NativeConfigSources } from "./NativeCompatibility.sources.ts";
import { deferred } from "./Test.fixtures.ts";
import { v2ConfigSourcePaths } from "./NativeCompatibility.sources.platform.ts";

it("loaded-bootstrap preflight cannot ignore a system/managed deny and never reads raw machine policy", async () => {
  const app = await makeV2ThreadPluginFixture(),
    root = path.join(app.root, "owned-global");
  await mkdir(root, { mode: 0o700 });
  const { systemRoot, paths } = v2ConfigSourcePaths();
  const entries = [
    { type: "directory", path: systemRoot },
    {
      type: "document",
      path:
        process.platform === "darwin"
          ? "/Library/Managed Preferences/ai.opencode.managed.plist"
          : paths.join(systemRoot, "opencode.json"),
      info: {
        permissions: [{ action: "bigbud_thread_v1_*", resource: "*", effect: "deny" }],
        credentials: "SYNTHETIC-DO-NOT-CARRY",
      },
    },
    { type: "directory", path: root },
  ];
  const get = vi.fn(async () => entries),
    client = { config: { get } } as unknown as OpencodeV2Client;
  try {
    const proof = await makeV2SyntheticNativeEligibility(
      client,
      app.artifact,
      root,
      "2.0.28",
      "v2-system-global-config-v1",
    )(app.artifact, client, app.root, root);
    expect(JSON.stringify(projectV2NativeConfigSources(entries as never))).not.toContain(
      "SYNTHETIC-DO-NOT-CARRY",
    );
    await expect(assertV2NativeRuntimePolicy(client, proof)).rejects.toMatchObject({
      reasonCode: "config-source-unverified",
    });
    entries[1]!.info!.permissions = [{ action: "*", resource: "*", effect: "allow" }];
    await expect(assertV2NativeRuntimePolicy(client, proof)).resolves.toBeUndefined();
    await writeFile(path.join(root, "opencode.jsonc"), '{ "plugins": ["-bigbud.thread.v1"] }', {
      mode: 0o600,
    });
    await expect(assertV2NativeRuntimePolicy(client, proof)).rejects.toMatchObject({
      reasonCode: "config-source-unverified",
    });
  } finally {
    await app.close();
  }
});

it("a delayed config response cannot confer proof after scope revocation", async () => {
  const held = deferred<unknown[]>(),
    entered = deferred<void>(),
    app = await makeV2ThreadPluginFixture(),
    root = path.join(app.root, "owned-global"),
    controller = new AbortController();
  const client = {
    config: {
      get: async () => {
        entered.resolve();
        return held.promise;
      },
    },
  } as unknown as OpencodeV2Client;
  await mkdir(root, { mode: 0o700 });
  try {
    const original = await makeV2SyntheticNativeEligibility(client, app.artifact, root)(
        app.artifact,
        client,
        app.root,
        root,
      ),
      proof = { ...original, assertCurrent: () => controller.signal.throwIfAborted() };
    const pending = assertV2NativeRuntimePolicy(client, proof, controller.signal),
      rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    controller.abort();
    held.resolve([{ type: "directory", path: root }]);
    await rejected;
  } finally {
    held.resolve([]);
    await app.close();
  }
});
