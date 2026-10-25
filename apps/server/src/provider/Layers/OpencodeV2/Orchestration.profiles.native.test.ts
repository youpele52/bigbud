import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { readV2SharedRegistration } from "./SharedService.registration.ts";
import { makeOwnedClient } from "./Client.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { v2NativeRegistrationMetadata } from "./Runtime.registration.ts";
import { v2CompactNativeSessionId } from "./Orchestration.sessionIdentity.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;

// The shared fixture requires clean-machine isolation evidence before launching any native process.
it.skipIf(!binary).each([false, true])(
  "retail native isolates two profile registrations in one Location (reverse=%s)",
  async (reverse) => {
    const a = await makeV2ThreadPluginFixture(),
      b = await makeV2ThreadPluginFixture();
    let native: Awaited<ReturnType<typeof sharedServiceNativeFixture>> | undefined;
    try {
      native = await sharedServiceNativeFixture(binary!, async (filename) => {
        const config = JSON.parse(await readFile(filename, "utf8"));
        config.plugins = (reverse ? [b, a] : [a, b]).map((app) => app.artifact.pluginUri);
        await writeFile(filename, JSON.stringify(config), { mode: 0o600 });
      });
      const registration = await readV2SharedRegistration(native.file);
      const client = makeOwnedClient({
        endpoint: registration.endpoint.url,
        password: registration.endpoint.auth!.password,
      });
      expect((await client.server.info()).pid).toBe(native.child.pid);
      const location = { directory: native.workspace };
      const ids = [a, b].map((app) =>
        v2CompactNativeSessionId(app.artifact.issuer, "0".repeat(64)),
      );
      const rpc = async (app: typeof a, method: string, input: unknown = {}) =>
        (
          await client.rpc.call({
            rpcID: v2ThreadRegistration(app.artifact).id,
            method,
            location,
            input: input as never,
          })
        ).output;
      for (const [index, app] of [a, b].entries()) {
        const selected = v2ThreadRegistration(app.artifact);
        expect(await rpc(app, "info")).toMatchObject({
          issuer: app.artifact.issuer,
          tools: [...selected.tools],
        });
        const owner = app.bind(ids[index]!, native.workspace);
        await client.session.create({
          id: owner.nativeSessionId,
          location,
          model: { providerID: "bigbud-v2-fixture", id: "synthetic-model" },
          metadata: {
            bigbud_provider: "opencodeV2",
            bigbud_thread: owner.threadId,
            bigbud_storage: owner.storageIdentity,
            ...v2NativeRegistrationMetadata({
              registrationFamily: "scoped",
              profileIssuer: app.artifact.issuer,
            }),
          },
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
        });
        expect(owner.nativeSessionId.length).toBeLessThanOrEqual(100);
        expect((await client.session.get({ sessionID: owner.nativeSessionId })).id).toBe(
          owner.nativeSessionId,
        );
      }
      await Promise.all(
        [a, b].map((app) => rpc(app, "enroll", app.envelope("enroll", 1, Date.now() + 50000))),
      );
      await expect(rpc(b, "inspect", a.envelope("inspect"))).rejects.toThrow();
      for (const [index, app] of [a, b].entries()) {
        native.state.advertised.clear();
        native.state.tool = v2ThreadRegistration(app.artifact).tool("list_threads");
        native.state.input = {};
        await client.session.prompt({
          sessionID: ids[index]!,
          id: `msg_profiles_${index}`,
          text: "Owned synthetic list",
          files: [],
        });
        await expect.poll(() => app.state.invocations.length, { timeout: 15000 }).toBe(1);
        for (const name of v2ThreadRegistration(app.artifact).tools)
          expect(native.state.advertised.has(name)).toBe(true);
        for (const name of v2ThreadRegistration((app === a ? b : a).artifact).tools)
          expect(native.state.advertised.has(name)).toBe(false);
      }
    } finally {
      await native?.close();
      await Promise.all([a.close(), b.close()]);
    }
  },
  60000,
);
