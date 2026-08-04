import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { captureResourceIdentity, deleteResourceAtomically } from "./EntityPurge.resources.ts";

it.effect("reports resources and known bytes actually removed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "purge-removal-metrics-" });
    const target = `${root}/asset.txt`;
    yield* fs.writeFileString(target, "seven!!");
    const identity = yield* Effect.promise(() => captureResourceIdentity({ root, target }));
    assert.isNotNull(identity);

    const removed = yield* Effect.promise(() =>
      deleteResourceAtomically({
        jobId: "removal-metrics-job",
        resolved: { root, target },
        resource: {
          kind: "attachment",
          relativePath: "asset.txt",
          identity,
          quarantineName: ".bigbud-purge-removal-metrics",
          action: "delete",
        },
      }),
    );
    assert.deepEqual(removed, { removed: true, knownBytes: 7 });
  }).pipe(Effect.provide(NodeServices.layer)),
);
