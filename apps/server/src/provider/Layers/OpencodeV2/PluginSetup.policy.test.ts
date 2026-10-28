import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { inspectV2PluginControls } from "./PluginSetup.policy.ts";
import type { OpencodeV2Client } from "./Client.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";

type Sources = Awaited<ReturnType<OpencodeV2Client["config"]["get"]>>;

it("validates JSONC without rewriting comments/legacy entries, resolves relative entries and refuses native removal/malformed input", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const root = path.join(app.root, "native-config");
    await mkdir(root);
    const filename = path.join(root, "opencode.jsonc");
    const bytes =
      '// user comment\n{"plugin":["./manual-package","foreign-package"],"unrelated":true,}\n';
    await writeFile(filename, bytes, { mode: 0o644 });
    const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
    expect(await inspectV2PluginControls([], root, authority, "/actual-worktree")).toEqual([
      "./manual-package",
      path.join(root, "manual-package"),
      "foreign-package",
    ]);
    expect(await readFile(filename, "utf8")).toBe(bytes);
    await writeFile(filename, '{"plugins":["-bigbud.thread.*"]}', { mode: 0o644 });
    await expect(inspectV2PluginControls([], root, authority, "/actual-worktree")).rejects.toThrow(
      "explicitly removed/denied",
    );
    await writeFile(filename, '{"plugins":[', { mode: 0o644 });
    await expect(inspectV2PluginControls([], root, authority, "/actual-worktree")).rejects.toThrow(
      "malformed/truncated",
    );
  } finally {
    await app.close();
  }
});

const document = (effect: string) => ({
  type: "document",
  info: { permissions: [{ action: "bigbud_thread_v1_*", resource: "*", effect }] },
});

it("respects both legacy denial intent and selected issuer-specific controls without changing last-match tool rules", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const root = path.join(app.root, "config");
    await mkdir(root);
    const selected = v2ThreadRegistration(app.artifact);
    const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
    const inspect = (sources: unknown[]) =>
      inspectV2PluginControls(
        sources as Sources,
        root,
        authority,
        "/workspace",
        new Set(),
        selected,
      );
    for (const id of ["bigbud.thread.v1", selected.id, "bigbud.thread.v2.*"])
      await expect(inspect([{ type: "document", info: { plugins: [`-${id}`] } }])).rejects.toThrow(
        "removed/denied",
      );
    const deny = {
      type: "document",
      info: {
        permissions: [{ action: selected.tool("list_threads"), resource: "*", effect: "deny" }],
      },
    };
    await expect(inspect([deny])).rejects.toThrow("permission-denied");
    await expect(inspect([document("deny")])).rejects.toThrow("permission-denied");
    await expect(
      inspect([
        deny,
        {
          type: "document",
          info: {
            permissions: [
              { action: selected.tool("list_threads"), resource: "*", effect: "allow" },
            ],
          },
        },
      ]),
    ).resolves.toEqual([]);
    await expect(
      inspect([{ type: "document", info: { plugins: [`-bigbud.thread.v2.${"f".repeat(64)}`] } }]),
    ).resolves.toHaveLength(1);
  } finally {
    await app.close();
  }
});

it("native permission order is conserved, and a final deny is never granted by installation", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const root = path.join(app.root, "native-config");
    await mkdir(root);
    const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
    await expect(
      inspectV2PluginControls(
        [document("deny"), document("allow")] as Sources,
        root,
        authority,
        "/worktree",
      ),
    ).resolves.toEqual([]);
    await expect(
      inspectV2PluginControls(
        [document("allow"), document("deny")] as Sources,
        root,
        authority,
        "/worktree",
      ),
    ).rejects.toThrow("permission-denied");
  } finally {
    await app.close();
  }
});

it("raw policies cannot be silently dropped, malformed or merged in filesystem iteration order", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const root = path.join(app.root, "config");
    await mkdir(root);
    const filename = path.join(root, "opencode.json");
    const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
    const allow = { action: "tool.use", resource: "*", effect: "allow" };
    const inspect = (sources: unknown[]) =>
      inspectV2PluginControls(sources as Sources, root, authority, "/workspace");
    for (const raw of [
      { policies: [allow] },
      { experimental: { policies: [allow] } },
      { policies: [{ ...allow, effect: "ask" }] },
    ]) {
      await writeFile(filename, JSON.stringify(raw), { mode: 0o600 });
      await expect(inspect([{ type: "document", path: filename, info: {} }])).rejects.toThrow(
        "policy-unsupported",
      );
    }
    await writeFile(filename, JSON.stringify({ policies: [allow] }), { mode: 0o600 });
    await expect(
      inspect([{ type: "document", path: filename, info: { policies: [allow] } }]),
    ).resolves.toEqual([]);
  } finally {
    await app.close();
  }
});

it("stale empty/allow canonical policies cannot conceal newly read top-level or legacy denies", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const root = path.join(app.root, "reconciliation");
    await mkdir(root);
    const filename = path.join(root, "opencode.json");
    const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
    const allow = { action: "tool.use", resource: "*", effect: "allow" };
    const deny = { ...allow, effect: "deny" };
    for (const raw of [{ policies: [deny] }, { experimental: { policies: [deny] } }]) {
      await writeFile(filename, JSON.stringify(raw), { mode: 0o600 });
      for (const policies of [[], [allow]]) {
        const sources = [{ type: "document", path: filename, info: { policies } }] as Sources;
        await expect(
          inspectV2PluginControls(sources, root, authority, "/workspace"),
        ).rejects.toMatchObject({
          diagnostic: { code: "policy-unsupported" },
        });
      }
    }
  } finally {
    await app.close();
  }
});

it("matching raw legacy/top-level statement order and native provider prefix remain supported", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const root = path.join(app.root, "matching-policies");
    await mkdir(root);
    const filename = path.join(root, "opencode.json");
    const deny = { action: "tool.use", resource: "*", effect: "deny" };
    const allow = { ...deny, effect: "allow" };
    await writeFile(
      filename,
      JSON.stringify({ experimental: { policies: [deny] }, policies: [allow] }),
      { mode: 0o600 },
    );
    const sources = [
      {
        type: "document",
        path: filename,
        info: {
          policies: [{ action: "provider.use", resource: "*", effect: "deny" }, deny, allow],
        },
      },
    ] as Sources;
    await expect(
      inspectV2PluginControls(
        sources,
        root,
        { signal: new AbortController().signal, assertCurrent: () => {} },
        "/workspace",
      ),
    ).resolves.toEqual([]);
  } finally {
    await app.close();
  }
});
