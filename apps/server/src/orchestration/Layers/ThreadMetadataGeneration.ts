import * as Effect from "effect/Effect";

import type { TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import { makeThreadMetadataGenerationRepository } from "../../persistence/Layers/ThreadMetadataGeneration.ts";
import type { ServerSettingsShape } from "../../ws/serverSettings.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { makeMetadataDispatchAdmission } from "./ThreadMetadataGeneration.admission.ts";
import { makeMetadataCanonicalOperations } from "./ThreadMetadataGeneration.canonical.ts";
import { makeMetadataRequestHandlers } from "./ThreadMetadataGeneration.capture.ts";
import { makeMetadataConfiguration } from "./ThreadMetadataGeneration.configuration.ts";
import { makeMetadataCoordinator } from "./ThreadMetadataGeneration.coordinator.ts";
import type { MetadataCoordinatorHost } from "./ThreadMetadataGeneration.coordinator.types.ts";
import {
  makeMetadataExecutionIdentity,
  type MetadataExecutionIdentity,
} from "./ThreadMetadataGeneration.executionIdentity.ts";
import type { ThreadMetadataGenerationRequests } from "./ThreadMetadataGeneration.requests.ts";
import { makeMetadataScheduler } from "./ThreadMetadataGeneration.scheduler.ts";

/** Production composition: exact auxiliary dispatch only; no provider-session fallback. */
export const makeThreadMetadataGeneration = Effect.fn("makeThreadMetadataGeneration")(
  function* (input: {
    readonly engine: OrchestrationEngineShape;
    readonly settings: ServerSettingsShape;
    readonly textGeneration: TextGenerationShape;
    readonly executionIdentity?: MetadataExecutionIdentity;
    readonly now?: () => string;
  }) {
    const repository = yield* makeThreadMetadataGenerationRepository();
    const configuration = yield* makeMetadataConfiguration(input.settings);
    const identity =
      input.executionIdentity ?? (yield* makeMetadataExecutionIdentity(input.settings));
    const canonical = yield* makeMetadataCanonicalOperations(input);
    const withDispatchAdmission = yield* makeMetadataDispatchAdmission({
      ...input,
      withExecutionIdentity: identity.withExecutionIdentity,
    });
    const now = input.now ?? (() => new Date().toISOString());
    const host: MetadataCoordinatorHost = {
      ...canonical,
      now,
      providerSettings: identity.providerSettings,
      captureVerifiedThreadPath: (context, selection) =>
        identity.capture(selection, context.workspace.executionTarget, context.workspace.cwd),
      withDispatchAdmission,
    };
    const coordinator = makeMetadataCoordinator({
      repository,
      host,
      textGeneration: input.textGeneration,
    });
    const scheduler = yield* makeMetadataScheduler({ repository, now, step: coordinator.step });
    const requests = makeMetadataRequestHandlers({
      ...input,
      repository,
      now,
      epochFor: configuration.epochFor,
      capturePath: identity.capture,
    });
    const requestsWithLifecycle: ThreadMetadataGenerationRequests = {
      ...requests,
      start: scheduler.start,
    };
    return { ...requestsWithLifecycle, step: coordinator.step };
  },
);
