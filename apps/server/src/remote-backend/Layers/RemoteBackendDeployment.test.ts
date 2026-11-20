import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { RemoteBackendRelayProfiles } from "../clientRelay.profiles.ts";
import { RemoteBackendDeployment } from "../Services/RemoteBackendDeployment.ts";
import { RemoteBackendDeploymentLive } from "./RemoteBackendDeployment.ts";

it.effect("live composition provides deployment and the persisted relay directory", () =>
  Effect.gen(function* () {
    const program = Effect.gen(function* () {
      const profiles = yield* Effect.serviceOption(RemoteBackendRelayProfiles);
      const deployment = yield* Effect.serviceOption(RemoteBackendDeployment);
      assert.isTrue(Option.isSome(profiles) && Option.isSome(deployment));
      return yield* Effect.promise(() =>
        Option.getOrThrow(profiles).list("caller", new AbortController().signal),
      );
    });
    yield* runMigrations();
    const listed = yield* program.pipe(Effect.provide(RemoteBackendDeploymentLive));
    assert.deepStrictEqual(listed, { availability: "setup-required", profiles: [] });
  }).pipe(
    Effect.provide(
      ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
    ),
  ),
);
