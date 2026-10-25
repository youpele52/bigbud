import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { readV2SharedRegistration } from "./SharedService.registration.ts";
import { makeOwnedClient } from "./Client.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { v2NativeRegistrationMetadata } from "./Runtime.registration.ts";

const binary = process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_BINARY;
it.skipIf(!binary)(
  "portable required plugin registers narrow tools/RPC and stops primary model requests when callback ownership fails",
  async () => {
    const app = await makeV2ThreadPluginFixture();
    const selected = v2ThreadRegistration(app.artifact);
    const native = await sharedServiceNativeFixture(binary!, async (filename) => {
      const config = JSON.parse(await readFile(filename, "utf8"));
      config.plugins = [app.artifact.pluginUri];
      await writeFile(filename, JSON.stringify(config), { mode: 0o600 });
    }).catch(async (error) => {
      await app.close();
      throw error;
    });
    try {
      const registration = await readV2SharedRegistration(native.file);
      const client = makeOwnedClient({
        endpoint: registration.endpoint.url,
        password: registration.endpoint.auth!.password,
      });
      const info = await client.server.info();
      expect(info.version).toBe(process.env.BIGBUD_OPENCODE_V2_SHARED_TEST_VERSION);
      expect(info.pid).toBe(native.child.pid);
      const location = { directory: native.workspace };
      const rpc = async (method: string, input: unknown = {}) =>
        (await client.rpc.call({ rpcID: selected.id, method, location, input: input as never }))
          .output as Record<string, unknown>;
      const pluginInfo = await rpc("info");
      expect(pluginInfo).toMatchObject({
        artifactDigest: app.artifact.artifactDigest,
        issuer: app.artifact.issuer,
        tools: expect.arrayContaining([selected.tool("send_thread_message")]),
      });
      const id = `ses_bigbud_${"a".repeat(64)}`;
      const owner = app.bind(id, native.workspace);
      await client.session.create({
        id,
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
        permissions: [
          { action: "*", resource: "*", effect: "allow" },
          { action: "subagent", resource: "*", effect: "deny" },
        ],
      });
      const expiry = Date.now() + 40000;
      expect(await rpc("enroll", app.envelope("enroll", 1, expiry))).toMatchObject({
        state: "active",
        revision: 1,
        expiry,
      });
      const renewedExpiry = Date.now() + 45000;
      expect(await rpc("renew", app.envelope("renew", 2, renewedExpiry))).toMatchObject({
        revision: 2,
        expiry: renewedExpiry,
      });
      expect(await rpc("inspect", app.envelope("inspect"))).toMatchObject({ revision: 2 });
      const cases = [
        {
          action: "send_thread_message",
          input: { threadId: "other-provider-thread", message: "smile" },
        },
        {
          action: "create_thread",
          input: { title: "Disposable child", task: "Synthetic independent task" },
        },
        { action: "get_thread_status", input: { threadId: "other-provider-thread" } },
        { action: "list_threads", input: {} },
        {
          action: "rename_thread",
          input: { title: "Renamed disposable target", targetThreadId: "other-provider-thread" },
        },
      ] as const;
      for (const [index, item] of cases.entries()) {
        native.state.tool = selected.tool(item.action);
        native.state.input = item.input;
        await client.session.prompt({ sessionID: id, text: `Synthetic canonical ${item.action}` });
        await expect.poll(() => app.state.invocations.length, { timeout: 15000 }).toBe(index + 1);
        expect(app.state.invocations[index]).toMatchObject({
          action: item.action,
          input: item.input,
        });
        await client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(10000) });
      }
      expect(app.state.invocations[0]).toMatchObject({
        action: "send_thread_message",
        sessionID: id,
        input: cases[0]!.input,
        messageID: expect.any(String),
        callID: expect.any(String),
        agent: expect.any(String),
      });
      app.state.active = false;
      const before = native.state.modelRequests;
      await client.session.prompt({
        sessionID: id,
        text: "Callback-down primary must not dispatch",
      });
      await client.session
        .wait({ sessionID: id }, { signal: AbortSignal.timeout(5000) })
        .catch(() => {});
      await expect
        .poll(async () => (await client.session.get({ sessionID: id })).outcome, { timeout: 5000 })
        .toBe("failed");
      expect(native.state.modelRequests).toBe(before);
      expect(app.state.invocations).toHaveLength(5);
      expect(native.state.advertised.has(selected.tool("create_thread"))).toBe(true);
      expect(native.state.advertised.has(selected.tool("get_thread_status"))).toBe(true);
      expect(native.state.advertised.has(selected.tool("list_threads"))).toBe(true);
      expect(native.state.advertised.has("bigbud_orchestration")).toBe(false);
    } finally {
      await native.close();
      await app.close();
    }
  },
  60000,
);
