import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerSettings } from "@bigbud/contracts/core/settings.ts";
import type { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { ServerSettingsShape } from "../../ws/serverSettings.ts";
import type { MetadataExecutionAdmission } from "./ThreadMetadataGeneration.admission.ts";
import type { MetadataCapturedPath } from "./ThreadMetadataGeneration.context.ts";
import {
  MetadataCoordinatorError,
  type MetadataCoordinatorFailure,
  type MetadataCoordinatorHost,
} from "./ThreadMetadataGeneration.coordinator.types.ts";
import { metadataFingerprint } from "./ThreadMetadataGeneration.policy.ts";
import { metadataProviderConfiguration } from "./ThreadMetadataGeneration.configuration.ts";

import {
  copilotMetadataTransport,
  probeMetadataCopilotAccount,
} from "./ThreadMetadataGeneration.copilotIdentity.ts";

import { cliProxyMetadataIdentity } from "./ThreadMetadataGeneration.executionIdentity.gateway.ts";
import { opencodeV2MetadataIdentity } from "./ThreadMetadataGeneration.executionIdentity.opencodeV2.ts";
import { ThreadToolsActivation } from "../../provider/Services/OpencodeV2/ThreadToolsActivation.ts";

type QualifiedProvider = "codex" | "claudeAgent" | "cursor" | "copilot" | "cliProxy" | "opencodeV2";
type Providers = ServerSettings["providers"];

export interface MetadataExecutionIdentity {
  readonly capture: (
    selection: ModelSelection,
    executionTarget: string,
    cwd?: string,
  ) => Effect.Effect<MetadataCapturedPath | null, MetadataCoordinatorFailure>;
  readonly providerSettings: MetadataCoordinatorHost["providerSettings"];
  readonly withExecutionIdentity: MetadataExecutionAdmission;
}

function qualified(provider: string): provider is QualifiedProvider {
  return (
    provider === "codex" ||
    provider === "claudeAgent" ||
    provider === "cursor" ||
    provider === "copilot" ||
    provider === "cliProxy" ||
    provider === "opencodeV2"
  );
}

function record(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** No credential material, account names, endpoints or paths escape into durable identity. */
export const makeMetadataExecutionIdentity = Effect.fn("makeMetadataExecutionIdentity")(function* (
  settings: ServerSettingsShape,
): Effect.fn.Return<
  MetadataExecutionIdentity,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const semaphore = yield* Semaphore.make(1);
  const activation = Option.getOrUndefined(yield* Effect.serviceOption(ThreadToolsActivation));
  const gatewayIdentity = (
    selection: ModelSelection,
    providers: Providers,
    env: NodeJS.ProcessEnv,
    cwd?: string,
  ) =>
    selection.provider === "cliProxy"
      ? Effect.try({
          try: () => cliProxyMetadataIdentity(selection, providers, env),
          catch: () =>
            new MetadataCoordinatorError({ detail: "Metadata gateway identity unavailable." }),
        })
      : Effect.tryPromise({
          try: (signal) =>
            opencodeV2MetadataIdentity(selection, providers, env, cwd, activation?.consent, signal),
          catch: () =>
            new MetadataCoordinatorError({ detail: "Metadata V2 identity unavailable." }),
        });
  const defaults = { codex: "codex", claudeAgent: "claude", cursor: "agent", copilot: "copilot" };

  const transport = Effect.fn("metadataExecutionIdentity.transport")(
    function* (
      selection: ModelSelection,
      executionTarget: string,
      providers: Providers,
      env: NodeJS.ProcessEnv,
      cwd?: string,
    ) {
      if (executionTarget !== "local" || !qualified(selection.provider)) return null;
      const config = providers[selection.provider];
      if (!config.enabled) return null;
      if (selection.provider === "cliProxy" || selection.provider === "opencodeV2")
        return (yield* gatewayIdentity(selection, providers, env, cwd))?.transport ?? null;
      if (selection.provider === "copilot")
        return copilotMetadataTransport(selection, providers, env);
      return metadataFingerprint({
        version: 1,
        selection,
        executionTarget,
        config: metadataProviderConfiguration(config),
        binary: providers[selection.provider].binaryPath || defaults[selection.provider],
        // Includes endpoint and credential-scope overrides without persisting their values.
        environment: env,
      });
    },
    Effect.timeoutOrElse({ duration: "750 millis", orElse: () => Effect.succeed(null) }),
    Effect.catchCause(() => Effect.succeed(null)),
  );

  const probe = Effect.fn("metadataExecutionIdentity.probe")(function* (
    binary: string,
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv,
  ) {
    const child = yield* spawner.spawn(
      ChildProcess.make(binary, args, { env, shell: process.platform === "win32" }),
    );
    const [stdout, code] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            (): string | null => "",
            (output, chunk) =>
              output !== null && output.length + chunk.length <= 65_536 ? output + chunk : null,
          ),
        ),
        child.exitCode,
        Stream.runDrain(child.stderr),
      ],
      { concurrency: "unbounded" },
    );
    return code === 0 && stdout !== null ? record(stdout) : null;
  }, Effect.scoped);

  const account = Effect.fn("metadataExecutionIdentity.account")(
    function* (
      selection: ModelSelection,
      providers: Providers,
      env: NodeJS.ProcessEnv,
      cwd?: string,
    ) {
      const provider = selection.provider;
      if (!qualified(provider)) return null;
      if (provider === "cliProxy" || provider === "opencodeV2") {
        const identity = yield* gatewayIdentity(selection, providers, env, cwd);
        return identity ? { accountIdentity: identity.accountIdentity } : null;
      }
      let identity: unknown = null;
      let nativeAccountIdentity: string | undefined;
      if (provider === "codex") {
        const home =
          providers.codex.homePath || env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
        const raw = yield* fs
          .readFileString(join(home, "auth.json"))
          .pipe(Effect.catch(() => Effect.succeed("")));
        const auth = record(raw);
        const tokens = auth?.tokens;
        const accountId =
          tokens !== null && typeof tokens === "object" && !Array.isArray(tokens)
            ? text((tokens as Record<string, unknown>).account_id)
            : null;
        if (auth?.auth_mode === "apikey") {
          const key = text(auth.OPENAI_API_KEY) || text(env.OPENAI_API_KEY);
          if (key) identity = ["api-key", key];
        } else if (accountId) identity = ["account", accountId];
        else if (text(env.OPENAI_API_KEY)) identity = ["api-key", env.OPENAI_API_KEY];
      } else if (provider === "cursor") {
        // Query the CLI itself, never Cursor desktop's unrelated credential store.
        const endpoint = providers.cursor.apiEndpoint.trim();
        const result = yield* probe(
          providers.cursor.binaryPath || defaults.cursor,
          [...(endpoint ? ["-e", endpoint] : []), "about", "--format", "json"],
          env,
        );
        const email = text(result?.userEmail);
        if (email && /^[^\s@]+@[^\s@]+$/.test(email)) identity = ["email", email];
      } else if (provider === "copilot") {
        const accountIdentity = yield* Effect.tryPromise((signal) =>
          probeMetadataCopilotAccount(
            providers.copilot.binaryPath || defaults.copilot,
            env,
            signal,
          ),
        );
        // The SDK probe already returns the same opaque fingerprint checked by the driver.
        return accountIdentity === null ? null : { accountIdentity };
      } else {
        // Alternate API/proxy/cloud credentials cannot be proved by subscription auth status.
        if (
          Object.entries(env).some(
            ([key, value]) =>
              Boolean(value) && /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN)/.test(key),
          )
        )
          return null;
        const result = yield* probe(
          providers.claudeAgent.binaryPath || defaults.claudeAgent,
          ["auth", "status", "--json"],
          env,
        );
        const email = text(result?.email);
        const org = text(result?.orgId) || text(result?.orgID);
        if (result?.loggedIn === true && result.authMethod === "claude.ai" && email && org) {
          identity = ["subscription", email, org];
          const orgName = text(result.orgName);
          if (orgName)
            nativeAccountIdentity = metadataFingerprint([
              provider,
              ["subscription", email, orgName],
            ]);
        }
      }
      return identity === null
        ? null
        : {
            accountIdentity: metadataFingerprint([provider, identity]),
            ...(nativeAccountIdentity ? { nativeAccountIdentity } : {}),
          };
    },
    Effect.timeoutOrElse({ duration: "750 millis", orElse: () => Effect.succeed(null) }),
    Effect.catchCause(() => Effect.succeed(null)),
  );

  const capture: MetadataExecutionIdentity["capture"] = (selection, executionTarget, cwd) =>
    Effect.gen(function* () {
      const selected = structuredClone(selection);
      if (!qualified(selected.provider) || executionTarget !== "local") return null;
      const providers = structuredClone((yield* settings.getSettings).providers);
      const env = { ...process.env };
      const fingerprint = yield* transport(selected, executionTarget, providers, env, cwd);
      if (!fingerprint) return null;
      const accountSnapshot = yield* account(selected, providers, env, cwd);
      if (
        !accountSnapshot ||
        (yield* transport(selected, executionTarget, providers, env, cwd)) !== fingerprint
      )
        return null;
      return {
        selection: selected,
        transport: fingerprint,
        ...accountSnapshot,
        executionTarget,
        promptVersion: "1",
        validatorVersion: "1",
        mode: "auxiliary" as const,
      };
    }).pipe(Effect.catchCause(() => Effect.succeed(null)));

  const matches = (
    path: MetadataCapturedPath,
    providers: Providers,
    env: NodeJS.ProcessEnv,
    cwd?: string,
  ) =>
    Effect.gen(function* () {
      return (
        path.mode === "auxiliary" &&
        path.promptVersion === "1" &&
        path.validatorVersion === "1" &&
        (yield* transport(path.selection, path.executionTarget, providers, env, cwd)) ===
          path.transport
      );
    });

  const providerSettings: MetadataExecutionIdentity["providerSettings"] = (context, path) =>
    Effect.gen(function* () {
      if (context.workspace.executionTarget !== path.executionTarget) return null;
      const providers = structuredClone((yield* settings.getSettings).providers);
      const env = { ...process.env };
      if (
        !qualified(path.selection.provider) ||
        !(yield* matches(path, providers, env, context.workspace.cwd))
      )
        return null;
      const current = yield* account(path.selection, providers, env, context.workspace.cwd);
      return (yield* matches(path, providers, env, context.workspace.cwd)) &&
        current?.accountIdentity === path.accountIdentity &&
        (path.nativeAccountIdentity === undefined ||
          current.nativeAccountIdentity === path.nativeAccountIdentity)
        ? providers
        : null;
    }).pipe(Effect.catchCause(() => Effect.succeed(null)));

  const withExecutionIdentity: MetadataExecutionAdmission = (context, path, snapshot, claim) => {
    const unavailable = () =>
      new TextGenerationError({
        operation:
          context.operation === "title" ? "generateThreadTitle" : "generateThreadElevatorSummary",
        detail: "Metadata execution identity is unavailable or no longer current.",
        metadataOutcome: "unavailable",
      });
    return semaphore
      .withPermitsIfAvailable(1)(
        Effect.gen(function* () {
          const providers = structuredClone(snapshot.settings.providers);
          const env = { ...process.env };
          if (
            context.workspace.executionTarget !== path.executionTarget ||
            !qualified(path.selection.provider) ||
            !(yield* matches(path, providers, env, context.workspace.cwd))
          )
            return yield* unavailable();
          const current = yield* account(path.selection, providers, env, context.workspace.cwd);
          if (
            current === null ||
            !(yield* matches(path, providers, env, context.workspace.cwd)) ||
            current.accountIdentity !== path.accountIdentity ||
            (path.nativeAccountIdentity !== undefined &&
              current.nativeAccountIdentity !== path.nativeAccountIdentity)
          )
            return yield* unavailable();
          // Settings epoch and source/workspace barriers belong to the caller. No model calls here.
          yield* claim;
        }),
      )
      .pipe(
        Effect.flatMap((result) =>
          Option.isSome(result) ? Effect.void : Effect.fail(unavailable()),
        ),
      );
  };
  return { capture, providerSettings, withExecutionIdentity };
});
