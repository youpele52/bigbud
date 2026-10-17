import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import {
  V2ThreadImplementationRegistry,
  v2ThreadImplementation,
} from "./Orchestration.implementation.ts";
import { V2ImplementationSelection } from "./Orchestration.implementation.selection.ts";

it("signed app-side default persists independently of native bootstrap and cannot hot-switch existing owner references", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const registry = new V2ThreadImplementationRegistry(),
      a = registry.acquire();
    const selected = await V2ImplementationSelection.open(app.artifact, registry);
    const controller = new AbortController(),
      authority = {
        signal: controller.signal,
        assertCurrent: () => controller.signal.throwIfAborted(),
      };
    await selected.select("v2", authority);
    const b = registry.acquire();
    expect(a.handler).toBe(v2ThreadImplementation("v1"));
    expect(b.handler).toBe(v2ThreadImplementation("v2"));
    const restart = new V2ThreadImplementationRegistry();
    await V2ImplementationSelection.open(app.artifact, restart);
    expect(restart.current()).toBe(b.handler);
    await selected.select("v1", authority);
    expect(b.handler).toBe(v2ThreadImplementation("v2"));
    controller.abort();
    await expect(selected.select("v2", authority)).rejects.toThrow();
    expect(registry.current()).toBe(a.handler);
    a.release();
    b.release();
  } finally {
    await app.close();
  }
});
