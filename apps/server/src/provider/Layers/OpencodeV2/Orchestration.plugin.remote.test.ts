import { V2_COMPATIBILITY_DIGEST } from "./Orchestration.compatibility.ts";
import { V2_N8_COMPATIBILITY_DIGEST } from "./Orchestration.compatibility.n8.ts";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import { V2ThreadOwner } from "./Orchestration.protocol.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { renderV2ThreadIdentity } from "./Orchestration.plugin.identity.ts";

it("pins current v5 identity bytes and retained v4 migration provenance", () => {
  // The own-thread summary migration introduced v5/canonical-v3 in f73faab0d3;
  // N8 retains the previous six-tool descriptor. Fixed placeholders contain no private state.
  const current = renderV2ThreadIdentity("public-key");
  const hash = (source: string) => createHash("sha256").update(source).digest("hex");
  expect(hash(current)).toBe("f7b6fc93dbf267b63e7a3cf33d67c53e4e560824f2e75a88eef29b34a1dee186");
  expect(
    hash(
      current
        .replaceAll("bigbud.thread.bootstrap.v5", "bigbud.thread.bootstrap.v4")
        .replaceAll(V2_COMPATIBILITY_DIGEST, V2_N8_COMPATIBILITY_DIGEST),
    ),
  ).toBe("155eb230bac8f0e67b24b5f430c78d005a7413fba30005bb4fcc4537d4e6a4f2");
});

it("enrolls a synthetic local Location and dispatches canonical thread tools without remote file authority", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const owner = app.bind("ses_remote_workspace", app.root);
    expect(Schema.decodeUnknownSync(V2ThreadOwner)(owner)).toMatchObject({
      runtimeTargetId: "local",
      workspaceTargetId: "local",
      directory: app.root,
    });
    const host = makeV2ThreadPluginHost(owner);
    const plugin = (await import(/* @vite-ignore */ app.artifact.entryUri)).default;
    const cleanup = await plugin.setup(host.context);
    try {
      await expect(
        host.call("enroll", app.envelope("enroll", 1, Date.now() + 40000)),
      ).resolves.toMatchObject({ state: "active", revision: 1 });
      expect(Object.keys((await host.request(owner.nativeSessionId)).tools).toSorted()).toEqual(
        [...v2ThreadRegistration(app.artifact).tools].toSorted(),
      );
      expect(Object.keys((await host.request("ses_other_workspace")).tools)).toHaveLength(0);
      const tool = host.tools.get(v2ThreadRegistration(app.artifact).tool("list_threads"))!;
      await tool.execute(
        {},
        {
          sessionID: owner.nativeSessionId,
          messageID: "remote-owner-message",
          id: "remote-owner-call",
          agent: "build",
          signal: new AbortController().signal,
        },
      );
      expect(app.state.invocations).toHaveLength(1);
      expect(app.state.invocations[0]).toMatchObject({
        sessionID: owner.nativeSessionId,
        messageID: "remote-owner-message",
        callID: "remote-owner-call",
      });
      await expect(host.call("detach", app.envelope("detach"))).resolves.toMatchObject({
        state: "revoked",
      });
    } finally {
      await cleanup();
    }
  } finally {
    await app.close();
  }
});

it.each([
  { runtimeTargetId: "local", workspaceTargetId: "ssh:vps" },
  { runtimeTargetId: "ssh:vps", workspaceTargetId: "ssh:vps" },
  { runtimeTargetId: "local", workspaceTargetId: "" },
  { runtimeTargetId: "local", workspaceTargetId: "x".repeat(4097) },
])(
  "rejects invalid runtime/workspace identity %# in both schema and rendered plugin",
  async (target) => {
    const app = await makeV2ThreadPluginFixture();
    try {
      const owner = app.bind("ses_invalid_remote_owner", app.root);
      Object.assign(owner, target);
      expect(() => Schema.decodeUnknownSync(V2ThreadOwner)(owner)).toThrow();
      const host = makeV2ThreadPluginHost(owner);
      const plugin = (await import(/* @vite-ignore */ app.artifact.entryUri)).default;
      const cleanup = await plugin.setup(host.context);
      try {
        await expect(
          host.call("enroll", app.envelope("enroll", 1, Date.now() + 40000)),
        ).rejects.toThrow();
        expect(Object.keys((await host.request(owner.nativeSessionId)).tools)).toHaveLength(0);
        expect(app.state.invocations).toHaveLength(0);
      } finally {
        await cleanup();
      }
    } finally {
      await app.close();
    }
  },
);
