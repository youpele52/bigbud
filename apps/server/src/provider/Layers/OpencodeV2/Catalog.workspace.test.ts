import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { loadModelChoiceContext } from "../../../orchestration-tools/ThreadOrchestrationTools.modelChoice.context.ts";
import { listDelegatedEffort } from "../../../orchestration-tools/ThreadOrchestrationTools.modelChoice.effort.ts";
import { provider } from "../../../orchestration-tools/ThreadOrchestrationTools.modelChoice.test.helpers.ts";
import { readV2NativeCatalog } from "./Catalog.native.ts";
import { readCachedV2WorkspaceCatalog } from "./Catalog.workspace.ts";
import { bindV2NativeCompatibility } from "./NativeCompatibility.binding.ts";
import { V2RuntimeHttpFixture } from "./Runtime.fixture.ts";

it("uses the native catalog for the canonical project, never a different project or generation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bigbud-project-model-cache-"));
  try {
    const startup = await realpath(root);
    const project = path.join(startup, "project");
    const alias = path.join(startup, "alias");
    const cold = path.join(startup, "cold");
    await mkdir(project);
    await mkdir(cold);
    await symlink(project, alias);
    const native = new V2RuntimeHttpFixture();
    const connection = {
      registrationFile: "/fixture/service.json",
      storageIdentity: "fixture",
      generation: "generation-1",
    };
    let attached = true;
    bindV2NativeCompatibility(native.client, {
      descriptor: connection,
      assertCurrent: () => {
        if (!attached) throw new Error("detached fixture");
      },
    });
    const model = native.models[0]!;
    native.models.splice(0, native.models.length, { ...model, variants: [{ id: "startup" }] });
    await readV2NativeCatalog(native.client, startup);
    const startupModels = readCachedV2WorkspaceCatalog(native.client, connection, startup)!;
    native.models.splice(0, 1, { ...model, variants: [{ id: "project" }] });
    await readV2NativeCatalog(native.client, project);
    const nativeReads = native.calls.length;
    const effort = async (workspaceRoot: string, descriptor = connection) => {
      const context = await Effect.runPromise(
        loadModelChoiceContext({
          target: { workspaceRoot },
          qualifyWorkspaceEffort: true,
          sources: {
            getProviders: Effect.succeed([provider("opencodeV2", {}, startupModels)]),
            getOpencodeWorkspaceModels: (directory) =>
              readCachedV2WorkspaceCatalog(native.client, descriptor, directory),
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            listRecent: () => Effect.succeed([]),
            hasInteractiveClient: () => false,
          },
        }),
      );
      expect(context).not.toBeNull();
      return listDelegatedEffort(context!, {
        provider: "opencodeV2",
        model: model.id,
        subProviderID: model.providerID,
      });
    };
    expect(await effort(alias)).toEqual({
      status: "supported",
      levels: [{ value: "project", label: "project" }],
    });
    expect(await effort(startup)).toEqual({
      status: "supported",
      levels: [{ value: "startup", label: "startup" }],
    });
    expect(await effort(cold)).toEqual({ status: "unknown", levels: [] });
    expect(await effort(startup, { ...connection, generation: "generation-2" })).toEqual({
      status: "unknown",
      levels: [],
    });
    attached = false;
    expect(await effort(alias)).toEqual({ status: "unknown", levels: [] });
    expect(native.calls).toHaveLength(nativeReads);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
