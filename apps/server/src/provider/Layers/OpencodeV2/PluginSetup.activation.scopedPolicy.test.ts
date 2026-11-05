import path from "node:path";
import { writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { makeV2ActivationTransactionFixture } from "./PluginSetup.activation.transaction.fixture.ts";
import { wireV2AutomaticNativeFixture } from "./PluginSetup.activation.native.fixture.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";

it.each([
  "plugin-removal",
  "tool-deny",
  "policy-deny",
  "policy-unsupported",
  "policy-cross-delimiter",
] as const)(
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
      const mutations = { create: vi.fn(), update: vi.fn(), prompt: vi.fn() };
      Object.assign(f.client.session, mutations);
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
                    : kind === "tool-deny"
                      ? {
                          permissions: [
                            {
                              action: selected.tool("list_threads"),
                              resource: "*",
                              effect: "deny" as const,
                            },
                          ],
                        }
                      : {
                          policies: [
                            {
                              action: "tool.use" as const,
                              resource:
                                kind === "policy-cross-delimiter"
                                  ? "*private:*"
                                  : `${selected.tool("list_threads")}:${kind === "policy-deny" ? "*" : "private"}`,
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
      for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled();
      expect(await lstat(native.filename).catch(() => undefined)).toBeUndefined();
      // The closed-window failure remains conservatively uncertain; neither mutation was issued.
      expect(result).toMatchObject({ state: "uncertain", reasonCode: "config-source-unverified" });
    } finally {
      await native.close();
      await f.cleanup();
    }
  },
);

it.each(["empty-top", "allow-top", "empty-legacy", "allow-legacy"] as const)(
  "locked publication rejects stale %s projection after a raw deny appears",
  async (kind) => {
    const f = await makeV2ActivationTransactionFixture();
    const native = wireV2AutomaticNativeFixture({
      artifact: f.app.artifact,
      client: f.client,
      root: f.root,
      owner: f.app.bind("synthetic", f.root),
    });
    try {
      const filename = path.join(f.root, "opencode.json");
      const allow = { action: "tool.use" as const, resource: "*", effect: "allow" as const };
      const deny = { ...allow, effect: "deny" as const };
      const policies = kind.startsWith("empty") ? [] : [allow];
      f.client.config.get = async () => [
        { type: "document", path: filename, info: { policies } },
        { type: "directory", path: f.root },
      ];
      const mutations = { create: vi.fn(), update: vi.fn(), prompt: vi.fn() };
      Object.assign(f.client.session, mutations);
      const participant = f.participants.get("owned")!;
      let updated = false;
      f.participants.set("owned", {
        ...participant,
        pauseRenewal: () => {
          writeFileSync(
            filename,
            JSON.stringify(
              kind.endsWith("legacy")
                ? { experimental: { policies: [deny] } }
                : { policies: [deny] },
            ),
            { mode: 0o600 },
          );
          updated = true;
        },
      });
      const handle = f.jobs.request(f.scope),
        result = await f.jobs.wait(handle, f.scope);
      expect(updated).toBe(true);
      expect(result).toMatchObject({ state: "uncertain", reasonCode: "config-source-unverified" });
      expect(f.retire).not.toHaveBeenCalled();
      for (const mutation of Object.values(mutations)) expect(mutation).not.toHaveBeenCalled();
      expect(await lstat(native.filename).catch(() => undefined)).toBeUndefined();
    } finally {
      await native.close();
      await f.cleanup();
    }
  },
);
