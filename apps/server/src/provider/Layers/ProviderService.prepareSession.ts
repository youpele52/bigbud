import {
  LOCAL_EXECUTION_TARGET_ID,
  ProviderSessionStartInput,
  type ProviderSession,
  type ThreadId,
} from "@bigbud/contracts";
import { Effect } from "effect";
import type { ProviderCapabilitiesResolver } from "../providerCapabilities.ts";
import type { ProviderRuntimeBinding } from "../Services/ProviderSessionDirectory.ts";
import {
  formatUnsupportedProviderExecutionTargetDetail,
  formatUnsupportedProviderLocalRuntimeRemoteWorkspaceDetail,
  isUnsupportedProviderLocalRuntimeRemoteWorkspace,
  supportsProviderExecutionTarget,
} from "../providerExecutionTargets.ts";
import { resolveProviderSessionExecutionTargets } from "../providerSessionExecutionTargets.ts";
import { decodeInputOrValidationError, toValidationError } from "./ProviderServiceHelpers.ts";

export interface SessionPreparationDependencies {
  readonly serverSettings: {
    readonly getSettings: Effect.Effect<
      { readonly providers: Record<string, { readonly enabled: boolean }> },
      Error
    >;
  };
  readonly getProviderCapabilities: ProviderCapabilitiesResolver;
  readonly isProviderComposed: (provider: ProviderSession["provider"]) => boolean;
}

export const prepareProviderSession = Effect.fn("prepareProviderSession")(function* (
  input: SessionPreparationDependencies,
  threadId: ThreadId,
  rawInput: ProviderSessionStartInput,
  persistedBinding?: ProviderRuntimeBinding,
) {
  const parsed = yield* decodeInputOrValidationError({
    operation: "ProviderService.startSession",
    schema: ProviderSessionStartInput,
    payload: rawInput,
  });
  if (
    parsed.provider !== undefined &&
    parsed.modelSelection?.provider !== undefined &&
    parsed.provider !== parsed.modelSelection.provider
  ) {
    return yield* toValidationError(
      "ProviderService.startSession",
      `Provider '${parsed.provider}' does not match modelSelection provider '${parsed.modelSelection.provider}'.`,
    );
  }
  const provider = parsed.provider ?? parsed.modelSelection?.provider ?? "codex";
  if (!input.isProviderComposed(provider)) {
    return yield* toValidationError(
      "ProviderService.startSession",
      `Provider '${provider}' is unavailable in this bigbud build.`,
    );
  }

  const capabilities = input.getProviderCapabilities(provider);
  const workspaceDefaultExecutionTargetId =
    persistedBinding?.workspaceExecutionTargetId ??
    persistedBinding?.executionTargetId ??
    LOCAL_EXECUTION_TARGET_ID;
  const startInput = {
    ...parsed,
    threadId,
    provider,
    ...resolveProviderSessionExecutionTargets({
      providerRuntimeExecutionTargetId: parsed.providerRuntimeExecutionTargetId,
      workspaceExecutionTargetId: parsed.workspaceExecutionTargetId,
      executionTargetId: parsed.executionTargetId,
      useLegacyExecutionTargetForProviderRuntime: !capabilities.supportsLocalRuntimeRemoteWorkspace,
      defaultProviderRuntimeExecutionTargetId: capabilities.supportsLocalRuntimeRemoteWorkspace
        ? LOCAL_EXECUTION_TARGET_ID
        : (persistedBinding?.providerRuntimeExecutionTargetId ??
          persistedBinding?.executionTargetId ??
          workspaceDefaultExecutionTargetId),
      defaultWorkspaceExecutionTargetId: workspaceDefaultExecutionTargetId,
    }),
  };

  if (
    isUnsupportedProviderLocalRuntimeRemoteWorkspace({
      provider: startInput.provider,
      providerRuntimeExecutionTargetId: startInput.providerRuntimeExecutionTargetId,
      workspaceExecutionTargetId: startInput.workspaceExecutionTargetId,
    })
  ) {
    return yield* toValidationError(
      "ProviderService.startSession",
      formatUnsupportedProviderLocalRuntimeRemoteWorkspaceDetail({
        provider: startInput.provider,
        workspaceExecutionTargetId: startInput.workspaceExecutionTargetId,
      }),
    );
  }
  if (
    !supportsProviderExecutionTarget(
      {
        provider: startInput.provider,
        executionTargetId: startInput.providerRuntimeExecutionTargetId,
      },
      input.getProviderCapabilities,
    )
  ) {
    return yield* toValidationError(
      "ProviderService.startSession",
      formatUnsupportedProviderExecutionTargetDetail({
        provider: startInput.provider,
        executionTargetId: startInput.providerRuntimeExecutionTargetId,
        surface: "Provider sessions",
      }),
    );
  }

  const settings = yield* input.serverSettings.getSettings.pipe(
    Effect.mapError((error) =>
      toValidationError(
        "ProviderService.startSession",
        `Failed to load provider settings: ${error.message}`,
        error,
      ),
    ),
  );
  const providerSettings = settings.providers[startInput.provider];
  if (!providerSettings?.enabled) {
    return yield* toValidationError(
      "ProviderService.startSession",
      `Provider '${startInput.provider}' is disabled in bigbud settings.`,
    );
  }

  return startInput;
});
