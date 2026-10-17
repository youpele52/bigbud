import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { readV2SharedRegistration } from "./SharedService.registration.ts";
import { makeOwnedClient } from "./Client.ts";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import {
  readV2LifecycleCounters,
  writeV2LifecycleProbes,
} from "./Orchestration.lifecycle.native.fixture.ts";

const version = vi.hoisted(() => ({ breaking: false }));
vi.mock("./Orchestration.plugin.ts", async (original) => {
  const renderer = await original<typeof import("./Orchestration.plugin.ts")>();
  return {
    ...renderer,
    renderV2ThreadPlugin: () =>
      renderer.renderV2ThreadPlugin() +
      (version.breaking ? "\n// Owned breaking bootstrap lifecycle probe.\n" : ""),
  };
});
const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;

it.skipIf(!binary)(
  "reproduces first insertion and breaking suffix teardown, including a paused executor in a second owned Location",
  async () => {
    const app = await makeV2ThreadPluginFixture();
    let probes: Awaited<ReturnType<typeof writeV2LifecycleProbes>> | undefined;
    const native = await sharedServiceNativeFixture(binary!, async (file) => {
      probes = await writeV2LifecycleProbes(file);
    });
    try {
      const config = await readFile(native.configFile);
      const endpoint = (await readV2SharedRegistration(native.file)).endpoint;
      const client = makeOwnedClient({ endpoint: endpoint.url, password: endpoint.auth!.password });
      expect((await client.server.info()).version).toBe(
        process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION,
      );
      const other = path.join(native.profile, "other-owned-location");
      await mkdir(other);
      const locations = [native.workspace, other];
      for (const directory of locations)
        await expect
          .poll(() => readV2LifecycleCounters(client, directory), { timeout: 15000 })
          .toMatchObject({ early: { setup: 1, cleanup: 0 }, sentinel: { setup: 1, cleanup: 0 } });
      const shim = path.join(probes!.directory, "bigbud-thread-tools-managed.js");
      await writeFile(shim, `export {default} from ${JSON.stringify(app.artifact.entryUri)};\n`, {
        mode: 0o600,
        flag: "wx",
      });
      for (const directory of locations)
        await expect
          .poll(() => readV2LifecycleCounters(client, directory), { timeout: 15000 })
          .toMatchObject({ early: { setup: 1, cleanup: 0 }, sentinel: { setup: 2, cleanup: 1 } });
      native.state.tool = "lifecycle_pause";
      native.state.input = {};
      const paused = await client.session.create({
        id: "ses_owned_lifecycle_pause",
        model: { providerID: "bigbud-v2-fixture", id: "synthetic-model" },
        location: { directory: other },
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      });
      await client.session.prompt({
        sessionID: paused.id,
        id: "msg_owned_lifecycle_pause",
        text: "Owned synthetic lifecycle pause",
        files: [],
      });
      await expect
        .poll(() => readV2LifecycleCounters(client, other), { timeout: 15000 })
        .toMatchObject({ sentinel: { started: 1, aborted: 0 } });
      version.breaking = true;
      const next = await exportV2ThreadArtifact(app.root);
      expect(next.artifactDigest).not.toBe(app.artifact.artifactDigest);
      await writeFile(shim, `export {default} from ${JSON.stringify(next.entryUri)};\n`, {
        mode: 0o600,
      });
      for (const directory of locations)
        await expect
          .poll(() => readV2LifecycleCounters(client, directory), { timeout: 15000 })
          .toMatchObject({ early: { setup: 1, cleanup: 0 }, sentinel: { setup: 3, cleanup: 2 } });
      await expect
        .poll(() => readV2LifecycleCounters(client, other), { timeout: 15000 })
        .toMatchObject({ sentinel: { started: 1, aborted: 1, settled: 0 } });
      expect(await readFile(native.configFile)).toEqual(config);
    } finally {
      version.breaking = false;
      await native.close();
      await app.close();
    }
  },
  60000,
);
