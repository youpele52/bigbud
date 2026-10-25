import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import { V2ThreadImplementationRegistry } from "./Orchestration.implementation.ts";
import { renderV2ThreadPlugin } from "./Orchestration.plugin.ts";
import { renderV2ThreadIdentity } from "./Orchestration.plugin.identity.ts";
import { syntheticV2QualificationRecord } from "./NativeCompatibility.qualification.fixture.ts";
import { validateV2NativeQualificationRegistry } from "./NativeCompatibility.qualification.ts";

it.each(["2.0.0", "2.0.25", "2.0.26", "2.0.27", "2.0.28", "2.1.0", "2.999.999"])(
  "bootstrap structurally accepts stable V2 candidate %s without claiming broker qualification",
  async (version) => {
    const app = await makeV2ThreadPluginFixture();
    try {
      const host = makeV2ThreadPluginHost(app.bind("native", app.root));
      host.context.app.version = version;
      const plugin = (await import(/* @vite-ignore */ app.artifact.entryUri)).default;
      const cleanup = await plugin.setup(host.context);
      try {
        expect((await host.call("info")).nativeVersion).toBe(version);
      } finally {
        await cleanup();
      }
    } finally {
      await app.close();
    }
  },
);

it.each(["1.0.0", "3.0.0", "2.0.28-dev", "2.0.28+custom", "2.00.28"])(
  "candidate bootstrap rejects %s before registration",
  async (version) => {
    const app = await makeV2ThreadPluginFixture();
    try {
      const host = makeV2ThreadPluginHost(app.bind("native", app.root));
      host.context.app.version = version;
      const plugin = (await import(/* @vite-ignore */ app.artifact.entryUri)).default;
      await expect(plugin.setup(host.context)).rejects.toThrow();
      expect(host.tools.size).toBe(0);
    } finally {
      await app.close();
    }
  },
);

it("qualification metadata/default selection cannot alter emitted bytes or frozen handler identity", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const before = [renderV2ThreadPlugin(), renderV2ThreadIdentity(app.artifact.publicKey)];
    const handlers = new V2ThreadImplementationRegistry(),
      pinned = handlers.acquire();
    handlers.select("v2");
    validateV2NativeQualificationRegistry([syntheticV2QualificationRecord()], []);
    expect([renderV2ThreadPlugin(), renderV2ThreadIdentity(app.artifact.publicKey)]).toEqual(
      before,
    );
    expect(pinned.handler.implementationDigest).not.toBe(handlers.current().implementationDigest);
    pinned.release();
  } finally {
    await app.close();
  }
});

it.each(["2.0.0", "2.0.25", "2.0.28", "2.999.999"])(
  "missing native context capabilities in %s fail before tools can register",
  async (version) => {
    const app = await makeV2ThreadPluginFixture();
    try {
      const host = makeV2ThreadPluginHost(app.bind("native", app.root));
      host.context.app.version = version;
      const plugin = (await import(/* @vite-ignore */ app.artifact.entryUri)).default;
      await expect(plugin.setup({ ...host.context, rpc: {} })).rejects.toThrow();
      expect(host.tools.size).toBe(0);
      await expect(
        plugin.setup({ ...host.context, location: { directory: "" } }),
      ).rejects.toThrow();
      expect(host.tools.size).toBe(0);
    } finally {
      await app.close();
    }
  },
);
