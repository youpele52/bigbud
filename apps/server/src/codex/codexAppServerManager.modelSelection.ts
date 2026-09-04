import type { ServerProviderModel } from "@bigbud/contracts/server/server.providers.ts";

export type CodexModelCatalog = ReadonlyArray<ServerProviderModel> | undefined;

export interface CodexEffectiveModelSelection {
  readonly model: string | undefined;
  readonly effort: string | undefined;
}

export type CodexModelSelectionErrorKind =
  | "catalog-unavailable"
  | "unknown-model"
  | "unsupported-effort";

export class CodexModelSelectionError extends Error {
  override readonly name = "CodexModelSelectionError";

  constructor(
    readonly kind: CodexModelSelectionErrorKind,
    readonly issue: string,
  ) {
    super(issue);
  }
}

export function isCodexModelSelectionError(value: unknown): value is CodexModelSelectionError {
  return value instanceof CodexModelSelectionError;
}

function findModel(
  catalog: Exclude<CodexModelCatalog, undefined>,
  model: string | undefined,
): ServerProviderModel | undefined {
  return model === undefined ? undefined : catalog.find((entry) => entry.slug === model);
}

function modelDefaultEffort(model: ServerProviderModel | undefined): string | undefined {
  return model?.capabilities?.reasoningEffortLevels.find((level) => level.isDefault)?.value;
}

function assertKnownExplicitModel(input: {
  readonly catalog: CodexModelCatalog;
  readonly model: string | undefined;
  readonly modelExplicitlyRequested: boolean;
}): ServerProviderModel | undefined {
  if (input.catalog === undefined) {
    return undefined;
  }

  const model = findModel(input.catalog, input.model);
  if (input.modelExplicitlyRequested && !model) {
    throw new CodexModelSelectionError(
      "unknown-model",
      input.model
        ? `Codex model '${input.model}' is not present in the active model catalog.`
        : "Codex model selection did not resolve to a model in the active catalog.",
    );
  }
  return model;
}

export function resolveCodexModelSelection(input: {
  readonly catalog: CodexModelCatalog;
  readonly current: CodexEffectiveModelSelection | undefined;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly modelExplicitlyRequested: boolean;
}): CodexEffectiveModelSelection {
  const current = input.current;
  const resolvedModel = input.model ?? current?.model;
  const model = assertKnownExplicitModel({
    catalog: input.catalog,
    model: resolvedModel,
    modelExplicitlyRequested: input.modelExplicitlyRequested,
  });

  if (input.effort !== undefined) {
    if (input.catalog === undefined) {
      throw new CodexModelSelectionError(
        "catalog-unavailable",
        `Cannot validate Codex effort '${input.effort}' because the active model catalog is unavailable.`,
      );
    }
    if (!model) {
      throw new CodexModelSelectionError(
        "unknown-model",
        resolvedModel
          ? `Codex model '${resolvedModel}' is not present in the active model catalog.`
          : `Cannot validate Codex effort '${input.effort}' without an active model.`,
      );
    }
    const supported = model.capabilities?.reasoningEffortLevels.some(
      (level) => level.value === input.effort,
    );
    if (!supported) {
      throw new CodexModelSelectionError(
        "unsupported-effort",
        `Codex model '${model.slug}' does not advertise reasoning effort '${input.effort}'.`,
      );
    }
    return { model: resolvedModel, effort: input.effort };
  }

  if (current !== undefined && current.model === resolvedModel) {
    return { model: resolvedModel, effort: current.effort };
  }

  return {
    model: resolvedModel,
    effort: input.catalog === undefined ? undefined : modelDefaultEffort(model),
  };
}
