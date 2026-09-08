import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

describe.runIf(linuxControlAvailable)("Linux durable remote control publication", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  beforeAll(async () => {
    fixture = createLinuxControlFixture();
    await fixture.run(`mkdir -p -m 700 '${fixture.root}'`);
  });
  afterAll(() => fixture?.close());

  it("reconciles lost acknowledgement after durable rename", async () => {
    let lost = false;
    const store = makeRemoteAgentRegistryStore(fixture.root, {
      run: async (command) => {
        const result = await fixture.run(command);
        if (!lost && command.includes("printf committed")) {
          lost = true;
          throw new Error("fixture lost acknowledgement after rename");
        }
        return result;
      },
    });
    const result = await store.update((state) => ({ ...state, revision: state.revision + 1 }));
    expect(lost).toBe(true);
    expect(result.revision).toBe(1);
    expect((await store.read()).revision).toBe(1);
  });

  it("serializes independent controllers without stale snapshot publication", async () => {
    const first = makeRemoteAgentRegistryStore(fixture.root, fixture);
    const second = makeRemoteAgentRegistryStore(fixture.root, fixture);
    await Promise.all(
      [first, second].map((store) =>
        store.update((state) => ({ ...state, revision: state.revision + 1 })),
      ),
    );
    expect((await first.read()).revision).toBe(3);
  });

  it("rejects symlink metadata without modifying its target", async () => {
    await fixture.run(
      `mv '${fixture.root}/control-v1/registry.json' '${fixture.root}/saved'; ln -s '${fixture.root}/saved' '${fixture.root}/control-v1/registry.json'`,
    );
    await expect(makeRemoteAgentRegistryStore(fixture.root, fixture).read()).rejects.toThrow();
    expect(JSON.parse(await fixture.run(`cat '${fixture.root}/saved'`)).revision).toBe(3);
  });
});
