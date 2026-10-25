import { lstat } from "node:fs/promises";
import { expect, it } from "vitest";
import { makeV2ActivationTransactionFixture } from "./PluginSetup.activation.transaction.fixture.ts";
import { wireV2AutomaticNativeFixture } from "./PluginSetup.activation.native.fixture.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";

it.each(["plugin-removal", "tool-deny"] as const)(
  "fresh locked policy checks reject newly introduced scoped %s before retirement/publication",
  async (kind) => {
    const f = await makeV2ActivationTransactionFixture();
    const native = wireV2AutomaticNativeFixture({
      artifact: f.app.artifact,
      client: f.client,
      root: f.root,
      owner: f.app.bind("synthetic", f.root),
    });
    try {
      const selected = v2ThreadRegistration(f.app.artifact);
      let deny = false;
      const original = f.client.config.get;
      f.client.config.get = async (...args) => [
        ...(await original(...args)),
        ...(deny
          ? [
              {
                type: "document" as const,
                info:
                  kind === "plugin-removal"
                    ? { plugins: [`-${selected.id}`] }
                    : {
                        permissions: [
                          {
                            action: selected.tool("list_threads"),
                            resource: "*",
                            effect: "deny" as const,
                          },
                        ],
                      },
              },
            ]
          : []),
      ];
      const participant = f.participants.get("owned")!;
      f.participants.set("owned", {
        ...participant,
        pauseRenewal: () => {
          deny = true;
        },
      });
      const handle = f.jobs.request(f.scope),
        result = await f.jobs.wait(handle, f.scope);
      expect(deny).toBe(true);
      expect(f.retire).not.toHaveBeenCalled();
      expect(await lstat(native.filename).catch(() => undefined)).toBeUndefined();
      // The closed-window failure remains conservatively uncertain; neither mutation was issued.
      expect(result).toMatchObject({ state: "uncertain", reasonCode: "config-source-unverified" });
    } finally {
      await native.close();
      await f.cleanup();
    }
  },
);
