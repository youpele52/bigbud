import { expect, it } from "vitest";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";

it("enrolls/renews under stable identity, reconciles lost/reordered acknowledgments and rejects revoked replay", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const owner = app.bind("ses_fixture", app.root);
    const host = makeV2ThreadPluginHost(owner);
    const plugin = (await import(/* @vite-ignore */ app.artifact.entryUri)).default;
    const cleanup = await plugin.setup(host.context);
    try {
      const oldExpiry = Date.now() + 35000;
      const enroll = app.envelope("enroll", 1, oldExpiry);
      const first = await host.call("enroll", enroll);
      expect(first).toMatchObject({ state: "active", revision: 1, expiry: oldExpiry });
      const renewedExpiry = Date.now() + 45000;
      const renew = app.envelope("renew", 2, renewedExpiry);
      await host.call("renew", renew); // Simulate losing this acknowledgment, then inspect.
      expect(await host.call("inspect", app.envelope("inspect"))).toMatchObject({
        ownerDigest: enroll.ownerDigest,
        revision: 2,
        expiry: renewedExpiry,
      });
      expect(await host.call("renew", app.envelope("renew", 2, renewedExpiry))).toMatchObject({
        revision: 2,
      });
      expect(await host.call("enroll", enroll)).toMatchObject({ state: "superseded", revision: 2 });
      await expect(
        host.call("renew", app.envelope("renew", 2, renewedExpiry + 1)),
      ).rejects.toThrow();
      await expect(
        host.call("renew", app.envelope("renew", 4, renewedExpiry + 2)),
      ).rejects.toThrow();
      expect(await host.call("detach", app.envelope("detach"))).toMatchObject({ state: "revoked" });
      await expect(host.call("renew", renew)).rejects.toThrow();
      await expect(host.call("enroll", enroll)).rejects.toThrow();
      expect(await host.call("inspect", app.envelope("inspect"))).toMatchObject({
        state: "revoked",
      });
      await expect(host.request(owner.nativeSessionId)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  } finally {
    await app.close();
  }
});

it("exposes only five enrolled primary tools, preserves foreign tools, and carries trusted context rather than model identity", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const owner = app.bind("ses_context", app.root);
    const host = makeV2ThreadPluginHost(owner);
    const plugin = (await import(/* @vite-ignore */ app.artifact.entryUri)).default;
    const cleanup = await plugin.setup(host.context);
    try {
      expect(host.tools.size).toBe(5);
      expect(Object.keys((await host.request("ses_unrelated")).tools)).toHaveLength(0);
      await host.call("enroll", app.envelope("enroll", 1, Date.now() + 40000));
      expect(Object.keys((await host.request(owner.nativeSessionId)).tools)).toHaveLength(5);
      expect(
        Object.keys((await host.request(owner.nativeSessionId, "generate")).tools),
      ).toHaveLength(0);
      expect(
        Object.keys((await host.request(owner.nativeSessionId, "compaction")).tools),
      ).toHaveLength(0);
      const tool = host.tools.get(v2ThreadRegistration(app.artifact).tool("send_thread_message"))!;
      await tool.execute(
        { threadId: "destination", message: "smile" },
        {
          sessionID: owner.nativeSessionId,
          messageID: "trusted-native-message",
          id: "trusted-native-call",
          agent: "build",
          signal: new AbortController().signal,
        },
      );
      expect(app.state.invocations[0]).toMatchObject({
        messageID: "trusted-native-message",
        callID: "trusted-native-call",
      });
      host.tools.set(tool.name, { ...tool, description: "Foreign replacement" });
      await expect(host.request(owner.nativeSessionId)).rejects.toThrow();
      expect(host.tools.get(tool.name)?.description).toBe("Foreign replacement");
      expect((await host.request("ses_unrelated")).tools[tool.name]?.description).toBe(
        "Foreign replacement",
      );
    } finally {
      await cleanup();
    }
  } finally {
    await app.close();
  }
});

it("rejects initial collisions without overwriting foreign definitions, even identical-schema definitions", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const host = makeV2ThreadPluginHost(app.bind("ses_collision", app.root));
    const foreign = {
      name: v2ThreadRegistration(app.artifact).tool("create_thread"),
      description: "Foreign",
      input: {},
      execute: async () => ({ content: "foreign" }),
    };
    host.tools.set(foreign.name, foreign);
    const plugin = (await import(/* @vite-ignore */ app.artifact.entryUri)).default;
    await expect(plugin.setup(host.context)).rejects.toThrow();
    expect(host.tools.get(foreign.name)).toBe(foreign);
    expect(host.tools.size).toBe(1);
  } finally {
    await app.close();
  }
});
