import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it } from "vitest";

import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.client.ts";
import type { SshOwnerTargetDescriptor } from "../ssh/sshOwnerProductionClient.launch.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { unsupportedWorkspaceMutations } from "../workspace-runtime/Services/WorkspaceMutations.ts";
import type { WorkspaceRuntimeShape } from "../workspace-runtime/Services/WorkspaceRuntime.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { withWsSshOwnerProductionWorkspace } from "./wsSshOwnerProduction.workspace.ts";

// W2 T-files deterministic reply loss: the staged write really reaches the
// live owner and the target, then the client boundary drops the owner's reply
// (fault injection at `bound.writeProofWorkspaceFile`). The write must surface
// as `unknown`, never retried, and the target must show the applied bytes.
// Same target JSON as `wsSshOwnerProduction.workspace.native.test.ts`.
const external = readExternalV2Target(process.env.BIGBUD_TEST_SSH_OWNER_PRODUCTION_FILES_TARGET);
const enabled =
  external !== undefined && (process.platform === "darwin" || process.platform === "linux");
const pathsLayer = WorkspacePathsLive.pipe(Layer.provide(NodeServices.layer));

it.skipIf(!enabled)(
  "reports a dispatched write whose reply was lost as unknown and never retries it",
  async () => {
    await withProductionV2Owner(
      external!,
      1,
      async ({ handle, targets }) => {
        const { descriptor, cwd } = targets[0]!;
        const trusted = handle.target(descriptor);
        const trust = await trusted.inspectTrust();
        if (trust.state === "approvalRequired") await trusted.approveTrust(trust.challenge);
        let dispatched = 0;
        const lossy = Object.assign(Object.create(handle) as typeof handle, {
          target: (value: SshOwnerTargetDescriptor) => {
            const bound = handle.target(value);
            return Object.assign(Object.create(bound) as typeof bound, {
              writeProofWorkspaceFile: async (
                input: Parameters<typeof bound.writeProofWorkspaceFile>[0],
              ) => {
                dispatched += 1;
                await bound.writeProofWorkspaceFile(input);
                // The owner acknowledged; the reply never reaches the caller.
                throw new PickerProofOwnerError("transportLost");
              },
            });
          },
        });
        const registration = {
          handle: lossy,
          descriptorFor: async () => descriptor,
        } as unknown as SshOwnerProductionRegistration;
        const refuse = () => Effect.die(new Error("the default runtime must never be reached"));
        const base: WorkspaceRuntimeShape = {
          files: {
            listDirectory: refuse,
            readFilePreview: refuse,
            readFileRange: refuse,
            writeFile: refuse,
          },
          search: { searchEntries: refuse, searchFileContents: refuse },
          watch: { watchDirectory: refuse },
        };
        const files = Effect.runSync(
          withWsSshOwnerProductionWorkspace(
            { workspaceRuntime: base, workspaceMutations: unsupportedWorkspaceMutations },
            { activation: true, read: () => registration },
          )!.workspaceRuntime.pipe(Effect.provide(pathsLayer)),
        );
        const input = { executionTargetId: descriptor.targetId, cwd, relativePath: "lost.txt" };
        const contents = "reply-loss ".repeat(10_000);
        const failure = await Effect.runPromise(
          Effect.flip(files.files.writeFile({ ...input, contents })),
        );
        expect(failure).toMatchObject({ writeDisposition: "unknown", retryable: false });
        expect(dispatched).toBe(1);
        const after = await Effect.runPromise(
          files.files.readFileRange({ ...input, offset: 0, maxBytes: 512 * 1024 }),
        );
        expect(after.sizeBytes).toBe(contents.length);
        expect(Buffer.from(after.bytes).toString("utf8")).toBe(contents);
        expect(dispatched).toBe(1);
      },
      { binding: {} },
    );
  },
  120_000,
);
